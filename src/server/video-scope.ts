import { and, eq, inArray, or } from "drizzle-orm";
import { formatDate } from "../lib/format";
import { getDb } from "./db/client";
import { videos, workflows, type IgnoreReason, type Workflow } from "./db/schema";
import { recordingDate } from "./naming/template";
import { getSettings } from "./settings";
import { ignoreVideo, restoreVideo } from "./videos";

type Scope = Pick<Workflow, "includeExisting" | "sinceDate">;

/** Why a newly found video should be skipped, or null to process it. */
export function skipReason(scope: Scope, recordedAt: Date, firstScan: boolean): IgnoreReason | null {
  if (scope.sinceDate) return recordedAt < scope.sinceDate ? "before_since" : null;
  return firstScan && !scope.includeExisting ? "existing" : null;
}

export function ignoreMessage(reason: IgnoreReason, scope: Scope, timeZone: string): string | null {
  switch (reason) {
    case "existing":
      return "Ya estaba en la carpeta al crear el workflow";
    case "before_since":
      return scope.sinceDate
        ? `Grabado antes del ${formatDate(scope.sinceDate, timeZone)}`
        : "Grabado antes de la fecha de inicio del workflow";
    case "missing":
      return "Ya no está en la carpeta de OneDrive";
    case "manual":
      return null;
  }
}

/**
 * After the workflow's scope changes: brings back the videos it had skipped
 * automatically that now qualify, and skips pending ones that no longer do.
 * Manually ignored videos and anything already approved are left alone.
 */
export function reapplyVideoScope(workflowId: number): { restored: number; skipped: number } {
  const db = getDb();
  const workflow = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  // "Only new videos" can't tell, after the fact, which files were already there.
  if (!workflow || (!workflow.sinceDate && !workflow.includeExisting)) return { restored: 0, skipped: 0 };

  const { timeZone } = getSettings();
  const candidates = db
    .select()
    .from(videos)
    .where(
      and(
        eq(videos.workflowId, workflowId),
        or(
          and(eq(videos.status, "ignored"), inArray(videos.ignoredReason, ["existing", "before_since"])),
          inArray(videos.status, ["discovered", "pending_review"]),
        ),
      ),
    )
    .all()
    .map((video) => ({ video, recordedAt: recordingDate(video, timeZone) }))
    // Oldest first, so `{n}` numbering follows the recording order.
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  let restored = 0;
  let skipped = 0;
  for (const { video, recordedAt } of candidates) {
    const qualifies = !workflow.sinceDate || recordedAt >= workflow.sinceDate;
    if (video.status === "ignored" && qualifies) {
      restoreVideo(video);
      restored += 1;
    } else if (video.status !== "ignored" && !qualifies) {
      ignoreVideo(video, "before_since", ignoreMessage("before_since", workflow, timeZone));
      skipped += 1;
    }
  }
  return { restored, skipped };
}
