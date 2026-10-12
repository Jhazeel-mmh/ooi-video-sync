import { mkdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { Video, Workflow } from "../../db/schema";
import { env } from "../../env";
import { errorMessage, QuotaError, RetryableError } from "../../errors";
import { logEvent } from "../../events";
import { downloadItem, getItem, moveItem } from "../../providers/onedrive";
import {
  addToPlaylist,
  queryUpload,
  startUpload,
  uploadFile,
  UploadSessionExpiredError,
  type YouTubeVideo,
} from "../../providers/youtube";
import { canStartUpload, nextQuotaReset, recordQuota } from "../../quota";
import { getSettings } from "../../settings";
import { duplicateMessage, findDuplicateOf } from "../../video-scope";
import { ignoreVideo, loadVideo, setVideoStatus, updateVideo, youtubeMetadata } from "../../videos";
import { enqueue, type JobPayloads } from "../queue";
import type { JobContext } from "../runner";

const TRANSFERABLE = new Set(["queued", "waiting_quota", "downloading", "uploading", "failed"]);
const DISK_MARGIN_BYTES = 512 * 1024 * 1024;

export function tempFilePath(video: Video): string {
  const ext = path.extname(video.name) || ".bin";
  return path.join(path.resolve(env().DATA_DIR), "tmp", `video-${video.id}${ext}`);
}

async function sizeOnDisk(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Persists progress at most every couple of seconds. */
function throttled(write: (bytes: number) => void, everyMs = 2000) {
  let last = 0;
  let pending: number | null = null;
  return {
    update(bytes: number) {
      pending = bytes;
      if (Date.now() - last >= everyMs) {
        write(bytes);
        last = Date.now();
        pending = null;
      }
    },
    flush() {
      if (pending !== null) write(pending);
    },
  };
}

function ensureQuota(): void {
  const check = canStartUpload();
  if (!check.ok) throw new QuotaError(check.reason, nextQuotaReset());
}

export async function transferVideo({ videoId }: JobPayloads["transfer_video"], ctx: JobContext): Promise<void> {
  const loaded = loadVideo(videoId);
  if (!loaded || !TRANSFERABLE.has(loaded.video.status)) return;
  let { video } = loaded;
  const { workflow } = loaded;

  // Two copies of the same file may have been approved at the same time.
  const duplicate = !video.youtubeVideoId && !video.uploadSessionUrl && workflow.skipDuplicates ? findDuplicateOf(video) : null;
  if (duplicate) {
    ignoreVideo(video, "duplicate", duplicateMessage(duplicate));
    logEvent({ videoId }, `Se ignora por duplicado: ${duplicateMessage(duplicate)}`);
    return;
  }

  if (video.youtubeVideoId) {
    // Already uploaded; only the follow-up is missing.
    setVideoStatus(videoId, "processing", { error: null });
    enqueue("check_processing", { videoId }, { dedupeKey: `check:${videoId}` });
    return;
  }

  // Don't spend a download on a video that can't be uploaded today.
  if (!video.uploadSessionUrl) ensureQuota();

  const file = tempFilePath(video);
  await mkdir(path.dirname(file), { recursive: true });
  video = await download(video, workflow, file, ctx);

  setVideoStatus(videoId, "uploading", { error: null });
  const accountId = workflow.youtubeAccountId;
  let sessionUrl = video.uploadSessionUrl;
  let offset = 0;

  if (sessionUrl) {
    const state = await queryUpload(accountId, sessionUrl, video.size);
    if (state.kind === "done") return finish(video, workflow, file, state.video);
    if (state.kind === "expired") sessionUrl = null;
    else offset = state.offset;
  }

  if (!sessionUrl) {
    ensureQuota();
    // Reload: the title may have been edited while the file was downloading.
    video = loadVideo(videoId)?.video ?? video;
    sessionUrl = await startUpload(accountId, youtubeMetadata(video, workflow), video.size, video.mimeType ?? "application/octet-stream");
    recordQuota(getSettings().uploadCostUnits, { upload: true });
    updateVideo(videoId, { uploadSessionUrl: sessionUrl, bytesUploaded: 0 });
    logEvent({ videoId }, "Subiendo a YouTube");
  } else {
    logEvent({ videoId }, `Reanudando la subida a YouTube desde ${Math.round((offset / video.size) * 100)}%`);
  }

  const progress = throttled((bytes) => updateVideo(videoId, { bytesUploaded: bytes }));
  let uploaded: YouTubeVideo;
  try {
    uploaded = await uploadFile(accountId, sessionUrl, file, video.size, offset, {
      signal: ctx.signal,
      onProgress: progress.update,
    });
  } catch (error) {
    if (error instanceof UploadSessionExpiredError) {
      updateVideo(videoId, { uploadSessionUrl: null, bytesUploaded: 0 });
      throw new RetryableError("La sesión de subida expiró; se volverá a subir", 5_000);
    }
    throw error;
  } finally {
    progress.flush();
  }
  await finish(video, workflow, file, uploaded);
}

async function download(video: Video, workflow: Workflow, file: string, ctx: JobContext): Promise<Video> {
  let onDisk = await sizeOnDisk(file);
  if (onDisk === video.size) return video;
  if (onDisk > video.size) {
    await rm(file, { force: true });
    onDisk = 0;
  }

  const { bavail, bsize } = await statfs(path.dirname(file));
  const needed = video.size - onDisk + DISK_MARGIN_BYTES;
  if (bavail * bsize < needed) {
    throw new RetryableError("No hay espacio suficiente en disco para el archivo temporal", 30 * 60_000);
  }

  setVideoStatus(video.id, "downloading", { bytesDownloaded: onDisk, error: null });
  logEvent({ videoId: video.id }, onDisk > 0 ? "Reanudando la descarga de OneDrive" : "Descargando de OneDrive");
  const progress = throttled((bytes) => updateVideo(video.id, { bytesDownloaded: bytes }));
  let finalSize: number;
  try {
    finalSize = await downloadItem(workflow.onedriveAccountId, video.driveId, video.itemId, file, {
      offset: onDisk,
      signal: ctx.signal,
      onProgress: progress.update,
    });
  } finally {
    progress.flush();
  }

  if (finalSize !== video.size) {
    // The file may have been replaced in OneDrive since it was detected.
    const item = await getItem(workflow.onedriveAccountId, video.driveId, video.itemId);
    await rm(file, { force: true });
    if (item.size && item.size !== video.size) {
      updateVideo(video.id, { size: item.size, lastSeenSize: item.size, eTag: item.eTag ?? null, bytesDownloaded: 0 });
      throw new RetryableError("El archivo cambió en OneDrive; se descargará de nuevo", 5_000);
    }
    throw new RetryableError(`Descarga incompleta (${finalSize} de ${video.size} bytes)`);
  }
  updateVideo(video.id, { bytesDownloaded: finalSize });
  return { ...video, bytesDownloaded: finalSize };
}

async function finish(video: Video, workflow: Workflow, file: string, uploaded: YouTubeVideo): Promise<void> {
  setVideoStatus(video.id, "processing", {
    youtubeVideoId: uploaded.id,
    uploadSessionUrl: null,
    bytesUploaded: video.size,
    uploadedAt: new Date(),
    error: null,
  });
  logEvent({ videoId: video.id }, `Subido a YouTube (id ${uploaded.id}); esperando a que termine de procesarse`);
  await rm(file, { force: true });

  // Edits saved after the upload session started aren't on YouTube yet.
  const current = loadVideo(video.id)?.video;
  if (current && metadataDiffers(current, video, uploaded)) {
    enqueue("sync_metadata", { videoId: video.id }, { dedupeKey: `sync:${video.id}` });
  }

  if (workflow.playlistId) {
    try {
      await addToPlaylist(workflow.youtubeAccountId, workflow.playlistId, uploaded.id);
      logEvent({ videoId: video.id }, `Agregado a la playlist ${workflow.playlistTitle ?? workflow.playlistId}`);
    } catch (error) {
      logEvent({ videoId: video.id }, `No se pudo agregar a la playlist: ${errorMessage(error)}`, "warn");
    }
  }

  if (workflow.postUploadAction === "move" && workflow.postUploadFolderId) {
    try {
      await moveItem(workflow.onedriveAccountId, video.driveId, video.itemId, workflow.postUploadFolderId);
      logEvent({ videoId: video.id }, `Archivo movido en OneDrive a ${workflow.postUploadFolderPath ?? "la carpeta de subidos"}`);
    } catch (error) {
      logEvent({ videoId: video.id }, `No se pudo mover el archivo en OneDrive: ${errorMessage(error)}`, "warn");
    }
  }

  enqueue("check_processing", { videoId: video.id }, { dedupeKey: `check:${video.id}`, runAt: new Date(Date.now() + 60_000) });
}

function metadataDiffers(current: Video, sent: Video, uploaded: YouTubeVideo): boolean {
  const remote = uploaded.snippet;
  if (!remote) return false;
  return (
    remote.title !== current.title ||
    (remote.description ?? "") !== (current.description ?? "") ||
    (remote.tags ?? []).join(",") !== (current.tags ?? []).join(",") ||
    current.privacyStatus !== sent.privacyStatus ||
    current.publishAt?.getTime() !== sent.publishAt?.getTime()
  );
}
