import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { accounts, workflows } from "../db/schema";
import { enqueue } from "./queue";

/** Queues a scan for every enabled workflow whose poll interval has elapsed. */
export function enqueueDueScans(now = new Date()): number {
  const db = getDb();
  const activeAccounts = new Set(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.status, "active"))
      .all()
      .map((a) => a.id),
  );
  let queued = 0;
  for (const wf of db.select().from(workflows).where(eq(workflows.enabled, true)).all()) {
    // Paused until the user reconnects the account.
    if (!activeAccounts.has(wf.onedriveAccountId) || !activeAccounts.has(wf.youtubeAccountId)) continue;
    const due = !wf.lastScannedAt || wf.lastScannedAt.getTime() + wf.pollIntervalMin * 60_000 <= now.getTime();
    if (due) {
      enqueue("scan_workflow", { workflowId: wf.id }, { dedupeKey: `scan:${wf.id}`, maxAttempts: 1 });
      queued += 1;
    }
  }
  return queued;
}

export function scanNow(workflowId: number): void {
  enqueue("scan_workflow", { workflowId }, { dedupeKey: `scan:${workflowId}`, maxAttempts: 1 });
}
