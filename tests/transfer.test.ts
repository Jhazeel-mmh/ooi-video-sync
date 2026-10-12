import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { jobs, quotaUsage, videos } from "@/server/db/schema";
import { QuotaError, RescheduleSignal } from "@/server/errors";
import { checkProcessing } from "@/server/jobs/handlers/check-processing";
import { tempFilePath, transferVideo } from "@/server/jobs/handlers/transfer";
import { claimNext, enqueue } from "@/server/jobs/queue";
import { runJob } from "@/server/jobs/runner";
import { quotaDay } from "@/server/quota";
import { updateSettings } from "@/server/settings";
import { createWorkflow, json, mockFetch } from "./helpers";

const CONTENT = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789");
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s1";
const DOWNLOAD = "https://storage.example/download/file";
const ctx = { signal: new AbortController().signal };

function createVideo(overrides: Partial<typeof videos.$inferInsert> = {}) {
  const workflow = createWorkflow({ playlistId: "PL1", postUploadAction: "move", postUploadFolderId: "done" });
  const video = getDb()
    .insert(videos)
    .values({
      workflowId: workflow.id,
      driveId: "drive1",
      itemId: "item1",
      name: "misa.mp4",
      path: "/Videos",
      size: CONTENT.length,
      mimeType: "video/mp4",
      lastSeenSize: CONTENT.length,
      stableSince: new Date(),
      status: "queued",
      title: "Misa del domingo",
      description: "Descripción",
      tags: ["misa"],
      privacyStatus: "unlisted",
      ...overrides,
    })
    .returning()
    .get();
  return { workflow, video };
}

/** OneDrive + YouTube fake that records what it received. */
function fakeServices(options: { downloadFrom?: number } = {}) {
  const uploaded: Buffer[] = [];
  const calls = mockFetch((url, init) => {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (url.hostname === "graph.microsoft.com" && url.pathname.endsWith("/content")) {
      return new Response(null, { status: 302, headers: { Location: DOWNLOAD } });
    }
    if (url.href === DOWNLOAD) {
      expect(headers.get("authorization")).toBeNull();
      const from = options.downloadFrom ?? 0;
      if (from > 0) {
        expect(headers.get("range")).toBe(`bytes=${from}-`);
        return new Response(CONTENT.subarray(from), { status: 206 });
      }
      return new Response(CONTENT, { status: 200 });
    }
    if (url.pathname === "/upload/youtube/v3/videos" && method === "POST") {
      return new Response(null, { status: 200, headers: { Location: SESSION } });
    }
    if (url.href === SESSION && method === "PUT") {
      uploaded.push(Buffer.from(init.body as Buffer));
      return json({ id: "yt1", snippet: { title: "Misa del domingo", description: "Descripción", tags: ["misa"], categoryId: "22" } }, { status: 201 });
    }
    if (url.pathname === "/youtube/v3/playlistItems") return json({ id: "pli" });
    if (url.hostname === "graph.microsoft.com" && method === "PATCH") return json({ id: "item1" });
    throw new Error(`Unexpected request ${method} ${url.href}`);
  });
  return { calls, uploaded: () => Buffer.concat(uploaded) };
}

beforeEach(() => {
  const db = getDb();
  db.delete(jobs).run();
  db.delete(quotaUsage).run();
  updateSettings({ dailyQuotaUnits: 10_000, uploadCostUnits: 1600, maxUploadsPerDay: 0 });
});

describe("transferVideo", () => {
  it("downloads, uploads, adds to the playlist, moves the file and waits for processing", async () => {
    const { video } = createVideo();
    const services = fakeServices();
    await transferVideo({ videoId: video.id }, ctx);

    const saved = getDb().select().from(videos).where(eq(videos.id, video.id)).get()!;
    expect(saved).toMatchObject({ status: "processing", youtubeVideoId: "yt1", uploadSessionUrl: null, error: null });
    expect(services.uploaded().equals(CONTENT)).toBe(true);
    expect(existsSync(tempFilePath(saved))).toBe(false);

    const initiation = services.calls.find((c) => c.url.pathname === "/upload/youtube/v3/videos")!;
    expect(JSON.parse(initiation.init.body as string)).toMatchObject({
      snippet: { title: "Misa del domingo", tags: ["misa"], categoryId: "22" },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    });
    expect(services.calls.some((c) => c.url.pathname === "/youtube/v3/playlistItems")).toBe(true);
    expect(services.calls.some((c) => c.init.method === "PATCH")).toBe(true);

    expect(getDb().select().from(quotaUsage).get()).toMatchObject({ uploads: 1, units: 1600 + 50 });
    const followUp = getDb().select().from(jobs).where(eq(jobs.type, "check_processing")).get();
    expect(followUp?.payload).toEqual({ videoId: video.id });
    // Nothing changed since the upload started, so no metadata sync is needed.
    expect(getDb().select().from(jobs).where(eq(jobs.type, "sync_metadata")).get()).toBeUndefined();
  });

  it("resumes a partial download with a Range request", async () => {
    const { video } = createVideo();
    const file = tempFilePath(video);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, CONTENT.subarray(0, 10));
    const services = fakeServices({ downloadFrom: 10 });

    await transferVideo({ videoId: video.id }, ctx);
    expect(services.uploaded().equals(CONTENT)).toBe(true);
  });

  it("doesn't download anything when today's quota is spent", async () => {
    updateSettings({ dailyQuotaUnits: 1000 });
    const { video } = createVideo();
    const services = fakeServices();
    await expect(transferVideo({ videoId: video.id }, ctx)).rejects.toBeInstanceOf(QuotaError);
    expect(services.calls).toHaveLength(0);
  });

  it("parks the video until the quota resets when run through the job runner", async () => {
    updateSettings({ maxUploadsPerDay: 1 });
    getDb().insert(quotaUsage).values({ datePt: quotaDay(), units: 0, uploads: 1 }).run();
    const { video } = createVideo();
    fakeServices();

    enqueue("transfer_video", { videoId: video.id });
    const job = claimNext("test")!;
    await runJob(job, ctx);

    const saved = getDb().select().from(videos).where(eq(videos.id, video.id)).get()!;
    expect(saved.status).toBe("waiting_quota");
    const requeued = getDb().select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(requeued).toMatchObject({ status: "queued", attempts: 0 });
    expect(requeued.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the video failed without retrying when YouTube rejects the metadata", async () => {
    const { video } = createVideo();
    mockFetch((url) => {
      if (url.pathname.endsWith("/content")) return new Response(null, { status: 302, headers: { Location: DOWNLOAD } });
      if (url.href === DOWNLOAD) return new Response(CONTENT);
      return json({ error: { code: 400, message: "Invalid title", errors: [{ reason: "invalidTitle" }] } }, { status: 400 });
    });
    enqueue("transfer_video", { videoId: video.id });
    await runJob(claimNext("test")!, ctx);

    const saved = getDb().select().from(videos).where(eq(videos.id, video.id)).get()!;
    expect(saved.status).toBe("failed");
    expect(saved.error).toMatch(/invalidTitle/);
    expect(getDb().select().from(jobs).get()?.status).toBe("failed");
  });
});

describe("checkProcessing", () => {
  it("publishes when YouTube finished and warns if privacy was forced", async () => {
    const { video } = createVideo({ status: "processing", youtubeVideoId: "yt1" });
    mockFetch(() => json({ items: [{ id: "yt1", status: { uploadStatus: "processed", privacyStatus: "private" } }] }));
    await checkProcessing({ videoId: video.id });
    expect(getDb().select().from(videos).where(eq(videos.id, video.id)).get()?.status).toBe("published");
  });

  it("polls again later while YouTube is still processing", async () => {
    const { video } = createVideo({ status: "processing", youtubeVideoId: "yt1" });
    mockFetch(() => json({ items: [{ id: "yt1", status: { uploadStatus: "uploaded" }, processingDetails: { processingStatus: "processing" } }] }));
    const error = await checkProcessing({ videoId: video.id, checks: 2 }).catch((e) => e);
    expect(error).toBeInstanceOf(RescheduleSignal);
    expect(error.payload).toEqual({ videoId: video.id, checks: 3 });
  });
});
