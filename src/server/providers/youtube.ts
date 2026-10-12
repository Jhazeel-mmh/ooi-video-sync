import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { PrivacyStatus } from "../db/schema";
import { PermanentError, QuotaError, RetryableError, errorMessage, isClassifiedError, retryAfterMs } from "../errors";
import { QUOTA_COST, nextQuotaReset, recordQuota } from "../quota";
import { authedFetch } from "./authed-fetch";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";

/** Must be a multiple of 256 KiB. */
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_CONSECUTIVE_CHUNK_FAILURES = 5;

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

export type VideoMetadata = {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: PrivacyStatus;
  publishAt?: Date | null;
  madeForKids: boolean;
};

export type YouTubeVideo = {
  id: string;
  snippet?: { title: string; description: string; tags?: string[]; categoryId: string };
  status?: {
    uploadStatus?: "uploaded" | "processed" | "failed" | "rejected" | "deleted";
    privacyStatus?: PrivacyStatus;
    failureReason?: string;
    rejectionReason?: string;
  };
  processingDetails?: { processingStatus?: "processing" | "succeeded" | "failed" | "terminated" };
};

export async function youtubeError(res: Response, what: string): Promise<Error> {
  let reason = "";
  let message = res.statusText;
  try {
    const json = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    reason = json.error?.errors?.[0]?.reason ?? "";
    message = json.error?.message ?? message;
  } catch {
    // Body wasn't JSON; keep the status text.
  }
  const text = `YouTube (${what}): ${res.status} ${reason ? `${reason} — ` : ""}${message}`;
  if (QUOTA_REASONS.has(reason)) return new QuotaError(text, nextQuotaReset());
  if (RATE_REASONS.has(reason) || res.status === 429 || res.status >= 500) {
    return new RetryableError(text, retryAfterMs(res) ?? 60_000);
  }
  return new PermanentError(text);
}

async function ytJson<T>(
  accountId: number,
  path: string,
  what: string,
  init: RequestInit & { cost?: number } = {},
): Promise<T> {
  const { cost = QUOTA_COST.list, ...requestInit } = init;
  const res = await authedFetch(accountId, `${API}${path}`, requestInit);
  recordQuota(cost);
  if (!res.ok) throw await youtubeError(res, what);
  return (await res.json()) as T;
}

/** Called during OAuth linking, before the account row exists. */
export async function fetchMyChannel(accessToken: string) {
  const res = await fetch(`${API}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await youtubeError(res, "leer canal");
  const json = (await res.json()) as {
    items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[];
  };
  const channel = json.items?.[0];
  if (!channel) throw new PermanentError("Esta cuenta de Google no tiene un canal de YouTube.");
  return {
    id: channel.id,
    title: channel.snippet.title,
    avatarUrl: channel.snippet.thumbnails?.default?.url ?? null,
  };
}

export async function listCategories(accountId: number, regionCode: string) {
  const json = await ytJson<{ items: { id: string; snippet: { title: string; assignable: boolean } }[] }>(
    accountId,
    `/videoCategories?part=snippet&regionCode=${regionCode}&hl=es-419`,
    "categorías",
  );
  return json.items.filter((c) => c.snippet.assignable).map((c) => ({ id: c.id, title: c.snippet.title }));
}

export async function listPlaylists(accountId: number) {
  const playlists: { id: string; title: string }[] = [];
  let pageToken = "";
  do {
    const json = await ytJson<{ items: { id: string; snippet: { title: string } }[]; nextPageToken?: string }>(
      accountId,
      `/playlists?part=snippet&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`,
      "playlists",
    );
    playlists.push(...json.items.map((p) => ({ id: p.id, title: p.snippet.title })));
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return playlists;
}

function toResource(meta: VideoMetadata) {
  // Scheduled publishing only works for private videos.
  const scheduled = meta.publishAt && meta.publishAt.getTime() > Date.now();
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: meta.categoryId,
    },
    status: {
      privacyStatus: scheduled ? "private" : meta.privacyStatus,
      ...(scheduled ? { publishAt: meta.publishAt!.toISOString() } : {}),
      selfDeclaredMadeForKids: meta.madeForKids,
    },
  };
}

export async function getVideo(accountId: number, videoId: string): Promise<YouTubeVideo | null> {
  const json = await ytJson<{ items: YouTubeVideo[] }>(
    accountId,
    `/videos?part=snippet,status,processingDetails&id=${videoId}`,
    "estado del video",
  );
  return json.items[0] ?? null;
}

export async function updateVideo(accountId: number, videoId: string, meta: VideoMetadata): Promise<void> {
  await ytJson(accountId, "/videos?part=snippet,status", "actualizar video", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: videoId, ...toResource(meta) }),
    cost: QUOTA_COST.update,
  });
}

export async function addToPlaylist(accountId: number, playlistId: string, videoId: string): Promise<void> {
  await ytJson(accountId, "/playlistItems?part=snippet", "agregar a playlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
    cost: QUOTA_COST.playlistInsert,
  });
}

/** Opens a resumable upload session and returns its URL. */
export async function startUpload(
  accountId: number,
  meta: VideoMetadata,
  size: number,
  mimeType: string,
): Promise<string> {
  const res = await authedFetch(accountId, `${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": mimeType,
    },
    body: JSON.stringify(toResource(meta)),
  });
  if (!res.ok) throw await youtubeError(res, "iniciar subida");
  const location = res.headers.get("location");
  if (!location) throw new RetryableError("YouTube no devolvió la URL de la sesión de subida");
  return location;
}

export type UploadState = { kind: "partial"; offset: number } | { kind: "done"; video: YouTubeVideo } | { kind: "expired" };

/** Interprets the response of a chunk PUT or status query. */
async function readUploadResponse(res: Response): Promise<UploadState> {
  if (res.status === 308) {
    // `Range: bytes=0-1234` → next byte to send is 1235. No header → nothing stored yet.
    const range = res.headers.get("range");
    const end = range ? Number(range.split("-")[1]) : -1;
    return { kind: "partial", offset: end + 1 };
  }
  if (res.status === 200 || res.status === 201) {
    return { kind: "done", video: (await res.json()) as YouTubeVideo };
  }
  if (res.status === 404 || res.status === 410) return { kind: "expired" };
  throw await youtubeError(res, "subir video");
}

export async function queryUpload(accountId: number, sessionUrl: string, size: number): Promise<UploadState> {
  const res = await authedFetch(accountId, sessionUrl, {
    method: "PUT",
    headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
    redirect: "manual",
  });
  return readUploadResponse(res);
}

/**
 * Sends the file from `offset` in chunks. Transient failures are retried in
 * place by asking the session where it left off.
 */
export async function uploadFile(
  accountId: number,
  sessionUrl: string,
  filePath: string,
  size: number,
  offset: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (uploaded: number) => void;
    chunkSize?: number;
    /** Base delay for in-place retries (doubles per consecutive failure). */
    retryDelayMs?: number;
  } = {},
): Promise<YouTubeVideo> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const file = await open(filePath, "r");
  const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(size, 1)));
  let failures = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const length = Math.min(chunkSize, size - offset);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new PermanentError("El archivo temporal está incompleto");

      let state: UploadState;
      try {
        const res = await authedFetch(accountId, sessionUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(length),
            "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
          },
          body: buffer.subarray(0, length),
          redirect: "manual",
          signal: options.signal,
        });
        state = await readUploadResponse(res);
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof RetryableError)) throw error;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_CHUNK_FAILURES) throw error;
        await sleep(Math.min(2 ** (failures - 1) * retryDelayMs, 30_000), undefined, { signal: options.signal });
        state = await queryUpload(accountId, sessionUrl, size);
      }

      if (state.kind === "done") {
        options.onProgress?.(size);
        return state.video;
      }
      if (state.kind === "expired") {
        throw new UploadSessionExpiredError();
      }
      if (state.offset > offset) {
        failures = 0;
      } else if (++failures >= MAX_CONSECUTIVE_CHUNK_FAILURES) {
        throw new RetryableError("La subida a YouTube no avanza");
      }
      offset = state.offset;
      options.onProgress?.(offset);
    }
  } catch (error) {
    if (error instanceof UploadSessionExpiredError || options.signal?.aborted || isClassifiedError(error)) throw error;
    throw new RetryableError(`Subida interrumpida: ${errorMessage(error)}`);
  } finally {
    await file.close();
  }
}

export class UploadSessionExpiredError extends Error {
  constructor() {
    super("La sesión de subida de YouTube expiró");
    this.name = "UploadSessionExpiredError";
  }
}
