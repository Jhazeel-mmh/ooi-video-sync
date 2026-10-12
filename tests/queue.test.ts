import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import {
  backoffMs,
  claimNext,
  completeJob,
  enqueue,
  failJob,
  releaseStaleJobs,
  rescheduleJob,
} from "@/server/jobs/queue";

const getJob = (id: number) => getDb().select().from(jobs).where(eq(jobs.id, id)).get()!;

beforeEach(() => {
  getDb().delete(jobs).run();
});

describe("enqueue", () => {
  it("dedupes queued jobs and pulls the run time forward", () => {
    const later = new Date(Date.now() + 60_000);
    const first = enqueue("scan_workflow", { workflowId: 1 }, { dedupeKey: "scan:1", runAt: later });
    const second = enqueue("scan_workflow", { workflowId: 1 }, { dedupeKey: "scan:1" });
    expect(second).toBe(first);
    expect(getJob(first).runAt.getTime()).toBeLessThan(later.getTime());
  });

  it("allows a new job once the previous one finished", () => {
    const first = enqueue("scan_workflow", { workflowId: 1 }, { dedupeKey: "scan:1" });
    completeJob(first);
    expect(enqueue("scan_workflow", { workflowId: 1 }, { dedupeKey: "scan:1" })).not.toBe(first);
  });
});

describe("claimNext", () => {
  it("only takes due jobs, once, and honours exclusions", () => {
    enqueue("transfer_video", { videoId: 1 });
    enqueue("generate_metadata", { videoId: 2 }, { runAt: new Date(Date.now() + 60_000) });

    expect(claimNext("w", ["transfer_video"])).toBeNull();
    const job = claimNext("w");
    expect(job).toMatchObject({ type: "transfer_video", status: "running", attempts: 1, lockedBy: "w" });
    expect(claimNext("w")).toBeNull();
  });
});

describe("failures", () => {
  it("retries with backoff until max attempts, then fails", () => {
    const id = enqueue("transfer_video", { videoId: 1 }, { maxAttempts: 2 });

    const first = claimNext("w")!;
    expect(failJob(first, "boom", { retry: true })).toBe(true);
    const queued = getJob(id);
    expect(queued.status).toBe("queued");
    expect(queued.runAt.getTime()).toBeGreaterThanOrEqual(Date.now() + backoffMs(1) - 1000);

    getDb().update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, id)).run();
    const second = claimNext("w")!;
    expect(failJob(second, "boom again", { retry: true })).toBe(false);
    expect(getJob(id)).toMatchObject({ status: "failed", lastError: "boom again", attempts: 2 });
  });

  it("does not retry when told not to", () => {
    const id = enqueue("transfer_video", { videoId: 1 });
    expect(failJob(claimNext("w")!, "auth", { retry: false })).toBe(false);
    expect(getJob(id).status).toBe("failed");
  });

  it("reschedules without counting the attempt", () => {
    const id = enqueue("check_processing", { videoId: 1 });
    const job = claimNext("w")!;
    const runAt = new Date(Date.now() + 120_000);
    rescheduleJob(job, runAt, { videoId: 1, checks: 3 });
    expect(getJob(id)).toMatchObject({ status: "queued", attempts: 0, payload: { videoId: 1, checks: 3 } });
  });

  it("releases jobs whose worker stopped sending heartbeats", () => {
    const id = enqueue("transfer_video", { videoId: 1 });
    claimNext("w");
    getDb()
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(jobs.id, id))
      .run();
    expect(releaseStaleJobs(10 * 60_000)).toBe(1);
    expect(getJob(id)).toMatchObject({ status: "queued", lockedBy: null, attempts: 0 });
  });
});
