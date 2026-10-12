import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { videos, workflows, type IgnoreReason, type Video, type VideoStatus, type Workflow } from "./db/schema";
import { logEvent } from "./events";
import { cancelVideoJobs, enqueue } from "./jobs/queue";
import { sanitizeTitle } from "./naming/sanitize";
import type { VideoMetadata } from "./providers/youtube";

export const AUTH_ERROR_PREFIX = "Reconecta la cuenta";

export function loadVideo(videoId: number): { video: Video; workflow: Workflow } | null {
  const row = getDb()
    .select()
    .from(videos)
    .innerJoin(workflows, eq(videos.workflowId, workflows.id))
    .where(eq(videos.id, videoId))
    .get();
  return row ? { video: row.videos, workflow: row.workflows } : null;
}

export function updateVideo(videoId: number, values: Partial<typeof videos.$inferInsert>): void {
  getDb().update(videos).set(values).where(eq(videos.id, videoId)).run();
}

export function setVideoStatus(videoId: number, status: VideoStatus, values: Partial<typeof videos.$inferInsert> = {}): void {
  updateVideo(videoId, { ...values, status });
}

export function youtubeMetadata(video: Video, workflow: Workflow): VideoMetadata {
  return {
    title: video.title ?? sanitizeTitle(video.name),
    description: video.description ?? "",
    tags: video.tags ?? [],
    categoryId: workflow.categoryId,
    privacyStatus: video.privacyStatus ?? workflow.privacyStatus,
    publishAt: video.publishAt,
    madeForKids: workflow.madeForKids,
  };
}

/** Next value of the workflow's `{n}` counter. */
export function nextSequence(workflowId: number): number {
  return getDb()
    .update(workflows)
    .set({ counter: sql`${workflows.counter} + 1` })
    .where(eq(workflows.id, workflowId))
    .returning({ counter: workflows.counter })
    .get().counter;
}

/** Sends a video to the transfer queue. */
export function queueTransfer(videoId: number): void {
  setVideoStatus(videoId, "queued", { error: null });
  enqueue("transfer_video", { videoId }, { dedupeKey: `transfer:${videoId}` });
}

export function queueMetadata(videoId: number): void {
  enqueue("generate_metadata", { videoId }, { dedupeKey: `meta:${videoId}` });
}

/**
 * Re-runs what failed because an account had to be reconnected.
 * Called after the account is linked again.
 */
export function retryAuthFailures(accountId: number): number {
  const db = getDb();
  const failed = db
    .select({ video: videos })
    .from(videos)
    .innerJoin(workflows, eq(videos.workflowId, workflows.id))
    .where(
      and(
        eq(videos.status, "failed"),
        like(videos.error, `${AUTH_ERROR_PREFIX}%`),
        or(eq(workflows.onedriveAccountId, accountId), eq(workflows.youtubeAccountId, accountId)),
      ),
    )
    .all()
    .map((r) => r.video);
  for (const video of failed) {
    retryVideo(video);
    logEvent({ videoId: video.id }, "Cuenta reconectada: se reintenta");
  }
  return failed.length;
}

/** Puts a failed video back at the step where it stopped. */
export function retryVideo(video: Video): void {
  if (video.youtubeVideoId) {
    setVideoStatus(video.id, "processing", { error: null });
    enqueue("check_processing", { videoId: video.id }, { dedupeKey: `check:${video.id}` });
  } else if (video.title) {
    queueTransfer(video.id);
  } else {
    setVideoStatus(video.id, "discovered", { error: null });
    queueMetadata(video.id);
  }
}

export function videosByIds(ids: number[]): Video[] {
  return ids.length > 0 ? getDb().select().from(videos).where(inArray(videos.id, ids)).all() : [];
}

/** Statuses where the worker is actively handling the video. */
const BUSY_STATUSES: VideoStatus[] = ["downloading", "uploading", "processing"];

export function canIgnore(video: Video): boolean {
  return !video.youtubeVideoId && !BUSY_STATUSES.includes(video.status) && video.status !== "ignored";
}

export function ignoreVideo(video: Video, reason: IgnoreReason = "manual", message: string | null = null): void {
  cancelVideoJobs(video.id, ["generate_metadata", "transfer_video"]);
  setVideoStatus(video.id, "ignored", { ignoredReason: reason, error: message });
}

/** Brings an ignored video back into the pipeline (it gets named again). */
export function restoreVideo(video: Video): void {
  if (video.sequence === null) updateVideo(video.id, { sequence: nextSequence(video.workflowId) });
  setVideoStatus(video.id, "discovered", { ignoredReason: null, error: null });
  queueMetadata(video.id);
}

export function canRegenerate(video: Video): boolean {
  return !video.youtubeVideoId && ["discovered", "pending_review", "failed"].includes(video.status);
}
