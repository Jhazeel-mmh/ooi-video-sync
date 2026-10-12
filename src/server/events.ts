import { getDb } from "./db/client";
import { events } from "./db/schema";

type Level = (typeof events.$inferInsert)["level"];

export function logEvent(
  target: { videoId?: number | null; workflowId?: number | null },
  message: string,
  level: Level = "info",
): void {
  getDb()
    .insert(events)
    .values({ videoId: target.videoId ?? null, workflowId: target.workflowId ?? null, message, level })
    .run();
}
