import { and, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { getDb } from "./db/client";
import { videos, workflows, type IgnoreReason, type Video, type Workflow } from "./db/schema";
import { filterFailure, type FilterCandidate } from "./filters";
import { recordingDate } from "./naming/template";
import { getSettings } from "./settings";
import { ignoreVideo, restoreVideo } from "./videos";

export const EXISTING_MESSAGE = "Ya estaba en la carpeta al crear el workflow";
export const MISSING_MESSAGE = "Ya no está en la carpeta de OneDrive";

export type SkipDecision = { reason: IgnoreReason; message: string } | null;

/**
 * Whether a newly found video is skipped. Precedence: videos already in the
 * folder on the first scan (unless included), then the workflow filters.
 */
export function scanDecision(
  workflow: Workflow,
  candidate: FilterCandidate,
  firstScan: boolean,
  timeZone: string,
): SkipDecision {
  if (firstScan && !workflow.includeExisting) return { reason: "existing", message: EXISTING_MESSAGE };
  const failure = filterFailure(workflow, candidate, timeZone);
  return failure ? { reason: "filtered", message: failure } : null;
}

export function candidateOf(video: Video, timeZone: string): FilterCandidate {
  return {
    name: video.name,
    size: video.size,
    durationMs: video.durationMs,
    recordedAt: recordingDate(video, timeZone),
  };
}

/** Statuses meaning "this content is already on its way to YouTube or there". */
const COMMITTED_STATUSES = ["queued", "waiting_quota", "downloading", "uploading", "processing", "published"] as const;

/**
 * Another video with the same content, in any workflow, that is already on
 * YouTube, or was approved and is older than this one. The age tie-break keeps
 * two copies approved together from skipping each other.
 */
export function findDuplicateOf(video: Video): Video | null {
  if (!video.contentHash) return null;
  return (
    getDb()
      .select()
      .from(videos)
      .where(
        and(
          eq(videos.contentHash, video.contentHash),
          ne(videos.id, video.id),
          or(
            isNotNull(videos.youtubeVideoId),
            and(inArray(videos.status, [...COMMITTED_STATUSES]), lt(videos.id, video.id)),
          ),
        ),
      )
      .get() ?? null
  );
}

export function duplicateMessage(original: Video): string {
  const name = original.title ?? original.name;
  return original.youtubeVideoId ? `Ya se subió como «${name}»` : `Ya está en proceso como «${name}»`;
}

/**
 * After the workflow's filters change: brings back the videos it had skipped
 * automatically that now qualify, and skips pending ones that no longer do.
 * Manually ignored videos and anything already approved are left alone.
 */
export function reapplyVideoScope(workflowId: number): { restored: number; skipped: number } {
  const db = getDb();
  const workflow = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!workflow) return { restored: 0, skipped: 0 };

  const { timeZone } = getSettings();
  const candidates = db
    .select()
    .from(videos)
    .where(
      and(
        eq(videos.workflowId, workflowId),
        or(
          and(eq(videos.status, "ignored"), inArray(videos.ignoredReason, ["existing", "filtered", "duplicate"])),
          inArray(videos.status, ["discovered", "pending_review"]),
        ),
      ),
    )
    .all()
    .map((video) => ({ video, candidate: candidateOf(video, timeZone) }))
    // Oldest first, so `{n}` numbering follows the recording order.
    .sort((a, b) => a.candidate.recordedAt.getTime() - b.candidate.recordedAt.getTime());

  let restored = 0;
  let skipped = 0;
  for (const { video, candidate } of candidates) {
    const failure = filterFailure(workflow, candidate, timeZone);
    if (video.status === "ignored") {
      const allowed =
        failure === null &&
        (video.ignoredReason !== "existing" || workflow.includeExisting) &&
        (video.ignoredReason !== "duplicate" || !workflow.skipDuplicates);
      if (allowed) {
        restoreVideo(video);
        restored += 1;
      }
    } else if (failure) {
      ignoreVideo(video, "filtered", failure);
      skipped += 1;
    }
  }
  return { restored, skipped };
}
