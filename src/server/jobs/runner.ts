import { formatDateTime } from "../../lib/format";
import type { Job, JobType } from "../db/schema";
import { AuthError, PermanentError, QuotaError, RescheduleSignal, RetryableError, errorMessage } from "../errors";
import { logEvent } from "../events";
import { getSettings } from "../settings";
import { loadVideo, setVideoStatus, updateVideo } from "../videos";
import { checkProcessing } from "./handlers/check-processing";
import { generateMetadata } from "./handlers/generate-metadata";
import { scanWorkflow } from "./handlers/scan";
import { syncMetadata } from "./handlers/sync-metadata";
import { transcribeVideoJob } from "./handlers/transcribe";
import { transferVideo } from "./handlers/transfer";
import { completeJob, failJob, rescheduleJob, type JobPayloads } from "./queue";

export type JobContext = {
  /** Aborted when the worker shuts down; the job is requeued without counting the attempt. */
  signal: AbortSignal;
  /** 1-based attempt number of this run. */
  attempt: number;
  maxAttempts: number;
};

/** Whether a temporary failure can still be retried by the queue. */
export function canRetry(ctx: JobContext): boolean {
  return ctx.attempt < ctx.maxAttempts;
}

const handlers: { [T in JobType]: (payload: JobPayloads[T], ctx: JobContext) => Promise<void> } = {
  scan_workflow: scanWorkflow,
  generate_metadata: generateMetadata,
  transcribe_video: transcribeVideoJob,
  transfer_video: transferVideo,
  check_processing: checkProcessing,
  sync_metadata: syncMetadata,
};

export async function runJob(job: Job, worker: { signal: AbortSignal }): Promise<void> {
  const handler = handlers[job.type] as (payload: unknown, ctx: JobContext) => Promise<void>;
  const ctx: JobContext = { signal: worker.signal, attempt: job.attempts, maxAttempts: job.maxAttempts };
  try {
    await handler(job.payload, ctx);
    completeJob(job.id);
  } catch (error) {
    handleFailure(job, error, ctx);
  }
}

function handleFailure(job: Job, error: unknown, ctx: JobContext): void {
  const videoId = typeof job.payload.videoId === "number" ? job.payload.videoId : null;
  const message = errorMessage(error);

  if (ctx.signal.aborted) {
    rescheduleJob(job, new Date());
    if (videoId && job.type === "transfer_video") setVideoStatus(videoId, "queued");
    return;
  }

  if (error instanceof RescheduleSignal) {
    rescheduleJob(job, error.runAt, error.payload);
    return;
  }

  if (error instanceof QuotaError) {
    rescheduleJob(job, error.resumeAt);
    if (videoId && job.type === "transfer_video") {
      setVideoStatus(videoId, "waiting_quota", { error: message });
      const when = formatDateTime(error.resumeAt, getSettings().timeZone);
      logEvent({ videoId }, `${message}. Se reintentará el ${when}`, "warn");
    }
    return;
  }

  const retry = !(error instanceof AuthError || error instanceof PermanentError);
  const willRetry = failJob(job, message, {
    retry,
    retryAfterMs: error instanceof RetryableError ? error.retryAfterMs : undefined,
  });
  if (!videoId) return;
  onVideoJobFailure(job.type, videoId, message, willRetry);
}

function onVideoJobFailure(type: JobType, videoId: number, message: string, willRetry: boolean): void {
  const loaded = loadVideo(videoId);
  if (!loaded) return;

  if (type === "transcribe_video") {
    // On-demand extra: the video itself is fine, only the transcript is missing.
    logEvent({ videoId }, `No se pudo transcribir: ${message}${willRetry ? " (se reintentará)" : ""}`, willRetry ? "warn" : "error");
    return;
  }

  if (type === "sync_metadata") {
    updateVideo(videoId, { error: `No se pudo actualizar en YouTube: ${message}` });
    logEvent({ videoId }, `No se pudo actualizar en YouTube: ${message}${willRetry ? " (se reintentará)" : ""}`, "error");
    return;
  }

  if (willRetry) {
    // Show it as waiting in the queue rather than stuck mid-transfer.
    if (type === "transfer_video") setVideoStatus(videoId, "queued", { error: message });
    else updateVideo(videoId, { error: message });
    logEvent({ videoId }, `${message} (se reintentará)`, "warn");
    return;
  }

  setVideoStatus(videoId, "failed", { error: message });
  logEvent({ videoId }, message, "error");
}
