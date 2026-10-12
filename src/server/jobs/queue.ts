import { and, asc, eq, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { jobs, type Job, type JobType } from "../db/schema";

export type JobPayloads = {
  scan_workflow: { workflowId: number };
  generate_metadata: { videoId: number };
  transcribe_video: { videoId: number };
  transfer_video: { videoId: number };
  check_processing: { videoId: number; checks?: number };
  sync_metadata: { videoId: number };
};

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

export function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
}

/** Enqueues a job; with `dedupeKey`, reuses a queued/running job with the same key. */
export function enqueue<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  options: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
): number {
  const runAt = options.runAt ?? new Date();
  return getDb().transaction(
    (tx) => {
      if (options.dedupeKey) {
        const existing = tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, options.dedupeKey), inArray(jobs.status, ["queued", "running"])))
          .get();
        if (existing) {
          if (existing.status === "queued" && existing.runAt > runAt) {
            tx.update(jobs).set({ runAt }).where(eq(jobs.id, existing.id)).run();
          }
          return existing.id;
        }
      }
      return tx
        .insert(jobs)
        .values({ type, payload, dedupeKey: options.dedupeKey, runAt, maxAttempts: options.maxAttempts ?? 5 })
        .returning({ id: jobs.id })
        .get().id;
    },
    { behavior: "immediate" },
  );
}

/** Atomically takes the next due job. */
export function claimNext(workerId: string, excludeTypes: JobType[] = []): Job | null {
  const now = new Date();
  return getDb().transaction(
    (tx) => {
      const job = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            lte(jobs.runAt, now),
            excludeTypes.length > 0 ? notInArray(jobs.type, excludeTypes) : undefined,
          ),
        )
        .orderBy(asc(jobs.runAt), asc(jobs.id))
        .limit(1)
        .get();
      if (!job) return null;
      return tx
        .update(jobs)
        .set({ status: "running", lockedBy: workerId, lockedAt: now, attempts: job.attempts + 1 })
        .where(eq(jobs.id, job.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export function completeJob(jobId: number): void {
  getDb().update(jobs).set({ status: "done", lockedBy: null, lockedAt: null }).where(eq(jobs.id, jobId)).run();
}

/** Returns whether the job will be retried. */
export function failJob(job: Job, error: string, options: { retry: boolean; retryAfterMs?: number }): boolean {
  const willRetry = options.retry && job.attempts < job.maxAttempts;
  getDb()
    .update(jobs)
    .set({
      status: willRetry ? "queued" : "failed",
      runAt: willRetry ? new Date(Date.now() + (options.retryAfterMs ?? backoffMs(job.attempts))) : job.runAt,
      lastError: error,
      lockedBy: null,
      lockedAt: null,
    })
    .where(eq(jobs.id, job.id))
    .run();
  return willRetry;
}

/** Puts the job back in the queue without counting the attempt. */
export function rescheduleJob(job: Job, runAt: Date, payload?: Record<string, unknown>): void {
  getDb()
    .update(jobs)
    .set({
      status: "queued",
      runAt,
      attempts: Math.max(job.attempts - 1, 0),
      lockedBy: null,
      lockedAt: null,
      ...(payload ? { payload } : {}),
    })
    .where(eq(jobs.id, job.id))
    .run();
}

export function heartbeat(jobId: number): void {
  getDb().update(jobs).set({ lockedAt: new Date() }).where(eq(jobs.id, jobId)).run();
}

/** Requeues running jobs whose worker stopped sending heartbeats. */
export function releaseStaleJobs(staleAfterMs: number): number {
  const cutoff = new Date(Date.now() - staleAfterMs);
  return getDb()
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedAt: null, attempts: sql`max(${jobs.attempts} - 1, 0)` })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .run().changes;
}

/** On startup (single worker): anything still `running` was interrupted. */
export function resetRunningJobs(): number {
  return getDb()
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedAt: null, attempts: sql`max(${jobs.attempts} - 1, 0)` })
    .where(eq(jobs.status, "running"))
    .run().changes;
}

export function pruneJobs(): void {
  const db = getDb();
  const day = 24 * 3_600_000;
  db.delete(jobs)
    .where(and(eq(jobs.status, "done"), lt(jobs.updatedAt, new Date(Date.now() - 7 * day))))
    .run();
  db.delete(jobs)
    .where(and(eq(jobs.status, "failed"), lt(jobs.updatedAt, new Date(Date.now() - 30 * day))))
    .run();
}

/** Cancels pending jobs of a video (e.g. when it's ignored). */
export function cancelVideoJobs(videoId: number, types: JobType[]): void {
  getDb()
    .delete(jobs)
    .where(
      and(
        eq(jobs.status, "queued"),
        inArray(jobs.type, types),
        sql`json_extract(${jobs.payload}, '$.videoId') = ${videoId}`,
      ),
    )
    .run();
}
