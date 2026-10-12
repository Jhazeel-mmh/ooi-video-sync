import type { Video, Workflow } from "../../db/schema";
import { errorMessage, RetryableError } from "../../errors";
import { logEvent } from "../../events";
import { filterFailure, needsDuration } from "../../filters";
import { isFfmpegAvailable, probeDuration } from "../../media/ffmpeg";
import { buildMetadata } from "../../naming/metadata";
import { ensureTranscript, transcriptionUnavailableReason } from "../../naming/transcript";
import { getDownloadUrl } from "../../providers/onedrive";
import { getSettings } from "../../settings";
import { candidateOf, duplicateMessage, findDuplicateOf } from "../../video-scope";
import { ignoreVideo, loadVideo, queueTransfer, setVideoStatus, updateVideo } from "../../videos";
import type { JobPayloads } from "../queue";
import { canRetry, type JobContext } from "../runner";

/**
 * Prepares a stable video: applies the filters that need final data (size,
 * duration), skips duplicates, then names it.
 */
export async function generateMetadata({ videoId }: JobPayloads["generate_metadata"], ctx: JobContext): Promise<void> {
  const loaded = loadVideo(videoId);
  if (!loaded || loaded.video.status !== "discovered") return;
  const { workflow } = loaded;
  let { video } = loaded;
  const { timeZone } = getSettings();

  if (needsDuration(workflow) && video.durationMs === null) {
    video = await measureDuration(video, workflow, ctx);
  }

  const failure = filterFailure(workflow, candidateOf(video, timeZone), timeZone);
  if (failure) {
    ignoreVideo(video, "filtered", failure);
    logEvent({ videoId }, `Se ignora: ${failure}`);
    return;
  }
  const duplicate = workflow.skipDuplicates ? findDuplicateOf(video) : null;
  if (duplicate) {
    ignoreVideo(video, "duplicate", duplicateMessage(duplicate));
    logEvent({ videoId }, `Se ignora por duplicado: ${duplicateMessage(duplicate)}`);
    return;
  }

  if (workflow.useTranscript && video.transcript === null) {
    video = await transcribeForNaming(video, workflow, ctx);
  }

  const metadata = await buildMetadata(video, workflow, { useAi: workflow.useAi });
  if (metadata.aiRetryable && canRetry(ctx)) {
    // e.g. Gemini's free-tier rate limit: try again later instead of settling for the template.
    throw new RetryableError(`La IA no está disponible por ahora: ${metadata.aiError}`, 60_000);
  }
  if (metadata.aiError) {
    logEvent({ videoId }, `La IA no pudo generar el título, se usó la plantilla: ${metadata.aiError}`, "warn");
  }

  setVideoStatus(videoId, workflow.mode === "auto" ? "queued" : "pending_review", {
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    titleSource: metadata.source,
    privacyStatus: workflow.privacyStatus,
    error: null,
  });
  logEvent(
    { videoId },
    `Título generado (${metadata.source === "ai" ? "IA" : "plantilla"}): ${metadata.title}${
      workflow.mode === "review" ? " — pendiente de revisión" : ""
    }`,
  );
  if (workflow.mode === "auto") queueTransfer(videoId);
}

/** Reads the duration with ffmpeg (headers only) when OneDrive didn't report it. */
async function measureDuration(video: Video, workflow: Workflow, ctx: JobContext): Promise<Video> {
  if (!isFfmpegAvailable()) {
    logEvent({ videoId: video.id }, "No se pudo medir la duración (ffmpeg no está disponible); no se aplica el filtro de duración", "warn");
    return video;
  }
  try {
    const url = await getDownloadUrl(workflow.onedriveAccountId, video.driveId, video.itemId, ctx.signal);
    const durationMs = await probeDuration(url, { signal: ctx.signal });
    if (durationMs !== null) {
      updateVideo(video.id, { durationMs });
      return { ...video, durationMs };
    }
    logEvent({ videoId: video.id }, "No se pudo leer la duración del video; no se aplica el filtro de duración", "warn");
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    logEvent({ videoId: video.id }, `No se pudo medir la duración: ${errorMessage(error)}; no se aplica el filtro de duración`, "warn");
  }
  return video;
}

/**
 * Best effort: a temporary failure (rate limit, network) retries the job while
 * attempts remain; otherwise the video is named without a transcript.
 */
async function transcribeForNaming(video: Video, workflow: Workflow, ctx: JobContext): Promise<Video> {
  const unavailable = transcriptionUnavailableReason();
  if (unavailable) {
    logEvent({ videoId: video.id }, `No se transcribe: ${unavailable}`, "warn");
    return video;
  }
  try {
    const transcript = await ensureTranscript(video, workflow, ctx.signal);
    return { ...video, transcript };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof RetryableError && canRetry(ctx)) throw error;
    logEvent({ videoId: video.id }, `No se pudo transcribir: ${errorMessage(error)}. Se nombra sin transcripción`, "warn");
    return video;
  }
}
