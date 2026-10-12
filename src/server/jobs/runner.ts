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
import { transferVideo } from "./handlers/transfer";
import { completeJob, failJob, rescheduleJob, type JobPayloads } from "./queue";

export type JobContext = {
  /** Aborted when the worker shuts down; the job is requeued without counting the attempt. */
  signal: AbortSignal;
};

const handlers: { [T in JobType]: (payload: JobPayloads[T], ctx: JobContext) => Promise<void> } = {
  scan_workflow: scanWorkflow,
  generate_metadata: generateMetadata,
  transfer_video: transferVideo,
  check_processing: checkProcessing,
  sync_metadata: syncMetadata,
};

export async function runJob(job: Job, ctx: JobContext): Promise<void> {
  const handler = handlers[job.type] as (payload: unknown, ctx: JobContext) => Promise<void>;
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
