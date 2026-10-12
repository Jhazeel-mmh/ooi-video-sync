import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { videos, workflows } from "../../db/schema";
import { errorMessage } from "../../errors";
import { logEvent } from "../../events";
import { recordingDate } from "../../naming/template";
import { contentHashOf, isVideoItem, listFiles, parentPathOf } from "../../providers/onedrive";
import { getSettings } from "../../settings";
import { MISSING_MESSAGE, scanDecision } from "../../video-scope";
import { nextSequence, queueMetadata } from "../../videos";
import type { JobPayloads } from "../queue";

export async function scanWorkflow({ workflowId }: JobPayloads["scan_workflow"]): Promise<void> {
  const db = getDb();
  const workflow = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!workflow?.enabled) return;

  const firstScan = workflow.lastScannedAt === null;
  let files;
  try {
    files = (
      await listFiles(workflow.onedriveAccountId, workflow.driveId, workflow.folderId, workflow.recursive)
    ).filter(isVideoItem);
  } catch (error) {
    // Wait for the next interval instead of hammering a broken folder.
    db.update(workflows)
      .set({ lastScannedAt: new Date(), lastScanError: errorMessage(error) })
      .where(eq(workflows.id, workflowId))
      .run();
    logEvent({ workflowId }, `Error al revisar la carpeta: ${errorMessage(error)}`, "error");
    throw error;
  }

  const now = new Date();
  const { timeZone } = getSettings();
  const known = new Map(
    db.select().from(videos).where(eq(videos.workflowId, workflowId)).all().map((v) => [v.itemId, v]),
  );
  let discovered = 0;

  for (const item of files) {
    const size = item.size ?? 0;
    const modifiedAt = new Date(item.lastModifiedDateTime);
    const previous = known.get(item.id);

    if (!previous) {
      const sourceCreatedAt = new Date(item.fileSystemInfo?.createdDateTime ?? item.createdDateTime);
      // Duration is often missing here; the duration filter is checked again before naming.
      const decision = scanDecision(
        workflow,
        {
          name: item.name,
          size,
          durationMs: item.video?.duration ?? null,
          recordedAt: recordingDate({ name: item.name, sourceCreatedAt, createdAt: now }, timeZone),
        },
        firstScan,
        timeZone,
      );
      const status = decision ? "ignored" : "discovered";
      const inserted = db
        .insert(videos)
        .values({
          workflowId,
          driveId: item.parentReference?.driveId ?? workflow.driveId,
          itemId: item.id,
          name: item.name,
          path: parentPathOf(item),
          size,
          mimeType: item.file?.mimeType ?? null,
          eTag: item.eTag ?? null,
          contentHash: contentHashOf(item),
          sourceCreatedAt,
          sourceModifiedAt: modifiedAt,
          durationMs: item.video?.duration ?? null,
          lastSeenSize: size,
          stableSince: modifiedAt,
          status,
          ignoredReason: decision?.reason ?? null,
          error: decision?.message ?? null,
        })
        .returning({ id: videos.id })
        .get();
      if (status === "discovered") {
        discovered += 1;
        logEvent({ videoId: inserted.id, workflowId }, `Detectado en OneDrive: ${item.name}`);
      }
      continue;
    }

    if (previous.contentHash === null && contentHashOf(item)) {
      // Videos found before hashes were stored: fill it in for duplicate detection.
      db.update(videos).set({ contentHash: contentHashOf(item) }).where(eq(videos.id, previous.id)).run();
    }
    if (previous.status === "discovered" && (previous.lastSeenSize !== size || previous.eTag !== item.eTag)) {
      // Still changing: restart the stability timer.
      db.update(videos)
        .set({
          name: item.name,
          size,
          lastSeenSize: size,
          eTag: item.eTag ?? null,
          contentHash: contentHashOf(item),
          sourceModifiedAt: modifiedAt,
          durationMs: item.video?.duration ?? previous.durationMs,
          stableSince: now,
        })
        .where(eq(videos.id, previous.id))
        .run();
    }
  }

  // Videos waiting for review that disappeared from the folder no longer need attention.
  const present = new Set(files.map((f) => f.id));
  for (const video of known.values()) {
    if ((video.status === "discovered" || video.status === "pending_review") && !present.has(video.itemId)) {
      db.update(videos)
        .set({ status: "ignored", ignoredReason: "missing", error: MISSING_MESSAGE })
        .where(eq(videos.id, video.id))
        .run();
      logEvent({ videoId: video.id, workflowId }, `${MISSING_MESSAGE}; se ignora`, "warn");
    }
  }

  // Stable videos move on to naming. Sequence numbers follow detection order.
  const ready = db
    .select()
    .from(videos)
    .where(and(eq(videos.workflowId, workflowId), eq(videos.status, "discovered")))
    .orderBy(videos.stableSince, videos.id)
    .all()
    .filter((v) => v.size > 0 && now.getTime() - v.stableSince.getTime() >= workflow.stableMinutes * 60_000);
  for (const video of ready) {
    if (video.sequence === null) {
      db.update(videos).set({ sequence: nextSequence(workflowId) }).where(eq(videos.id, video.id)).run();
    }
    queueMetadata(video.id);
  }

  db.update(workflows).set({ lastScannedAt: now, lastScanError: null }).where(eq(workflows.id, workflowId)).run();
  if (discovered > 0) logEvent({ workflowId }, `${discovered} video(s) nuevo(s) en ${workflow.folderPath}`);
}
