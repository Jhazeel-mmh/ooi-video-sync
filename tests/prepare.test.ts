import { execFileSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import ffmpegStatic from "ffmpeg-static";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { jobs, videos, workflows } from "@/server/db/schema";
import { generateMetadata } from "@/server/jobs/handlers/generate-metadata";
import { transferVideo } from "@/server/jobs/handlers/transfer";
import { probeDuration } from "@/server/media/ffmpeg";
import { updateSettings } from "@/server/settings";
import { reapplyVideoScope } from "@/server/video-scope";
import { createWorkflow, mockFetch } from "./helpers";

const ctx = { signal: new AbortController().signal, attempt: 1, maxAttempts: 5 };
let sample: string;

beforeAll(() => {
  // A real 3-second video, so ffmpeg is exercised for real.
  sample = path.join(process.env.DATA_DIR!, "sample.mp4");
  execFileSync(ffmpegStatic!, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=64x64:rate=10",
    "-f", "lavfi", "-i", "sine=duration=3",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", sample,
  ]);
});

beforeEach(() => {
  updateSettings({ timeZone: "America/Mexico_City" });
  getDb().delete(jobs).run();
});

/** Graph answers the content request with a redirect to the local sample file. */
function serveSample() {
  return mockFetch((url) => {
    if (url.pathname.endsWith("/content")) return new Response(null, { status: 302, headers: { Location: sample } });
    throw new Error(`Unexpected request ${url.href}`);
  });
}

function insertVideo(workflowId: number, values: Partial<typeof videos.$inferInsert> = {}) {
  return getDb()
    .insert(videos)
    .values({
      workflowId,
      driveId: "drive1",
      itemId: `item-${Math.random()}`,
      name: "VID_20260510_120000.mp4",
      path: "/Videos",
      size: 10 * 1024 * 1024,
      lastSeenSize: 10 * 1024 * 1024,
      stableSince: new Date(),
      status: "discovered",
      ...values,
    })
    .returning()
    .get();
}

const reload = (id: number) => getDb().select().from(videos).where(eq(videos.id, id)).get()!;

describe("probeDuration", () => {
  it("reads the duration of a real file", async () => {
    const ms = await probeDuration(sample);
    expect(ms).toBeGreaterThan(2900);
    expect(ms).toBeLessThan(3200);
  });
});

describe("preparing a video", () => {
  it("measures the duration with ffmpeg when OneDrive didn't report it, then applies the filter", async () => {
    const wf = createWorkflow({ minDurationSec: 60 });
    const video = insertVideo(wf.id);
    serveSample();
    await generateMetadata({ videoId: video.id }, ctx);
    expect(reload(video.id)).toMatchObject({ status: "ignored", ignoredReason: "filtered", error: "Dura menos de 1 min" });
    expect(reload(video.id).durationMs).toBeGreaterThan(2900);
  });

  it("names videos that pass every filter", async () => {
    const wf = createWorkflow({ maxDurationSec: 60, minSizeBytes: 1024, nameInclude: "vid" });
    const video = insertVideo(wf.id);
    serveSample();
    await generateMetadata({ videoId: video.id }, ctx);
    expect(reload(video.id)).toMatchObject({ status: "pending_review", title: "VID 20260510 120000" });
  });

  it("re-checks the size with the final value", async () => {
    const wf = createWorkflow({ maxSizeBytes: 5 * 1024 * 1024 });
    const video = insertVideo(wf.id);
    await generateMetadata({ videoId: video.id }, ctx);
    expect(reload(video.id)).toMatchObject({ status: "ignored", ignoredReason: "filtered", error: "Pesa más de 5.0 MB" });
  });
});

describe("duplicates", () => {
  it("skips a file whose content was already uploaded, in any workflow", async () => {
    const other = createWorkflow();
    insertVideo(other.id, { contentHash: "abc", status: "published", youtubeVideoId: "yt1", title: "Misa del 10 de mayo" });
    const wf = createWorkflow();
    const video = insertVideo(wf.id, { contentHash: "abc" });
    await generateMetadata({ videoId: video.id }, ctx);
    expect(reload(video.id)).toMatchObject({
      status: "ignored",
      ignoredReason: "duplicate",
      error: "Ya se subió como «Misa del 10 de mayo»",
    });
  });

  it("ignores pending copies and keeps them when duplicates are allowed", async () => {
    const wf = createWorkflow({ skipDuplicates: false });
    insertVideo(wf.id, { contentHash: "same", status: "published", youtubeVideoId: "yt1" });
    const pending = insertVideo(wf.id, { contentHash: "other", status: "pending_review", title: "x" });
    const video = insertVideo(wf.id, { contentHash: "same" });
    await generateMetadata({ videoId: video.id }, ctx);
    expect(reload(video.id).status).toBe("pending_review");
    expect(reload(pending.id).status).toBe("pending_review");
  });

  it("lets only the oldest of two approved copies through at transfer time", async () => {
    const wf = createWorkflow();
    const first = insertVideo(wf.id, { contentHash: "twin", status: "queued", title: "Uno" });
    const second = insertVideo(wf.id, { contentHash: "twin", status: "queued", title: "Dos" });
    mockFetch(() => {
      throw new Error("no network expected");
    });

    await transferVideo({ videoId: second.id }, ctx);
    expect(reload(second.id)).toMatchObject({ status: "ignored", ignoredReason: "duplicate", error: "Ya está en proceso como «Uno»" });
    // The first one isn't a duplicate of the (now ignored) second; it proceeds and reaches the network.
    await expect(transferVideo({ videoId: first.id }, ctx)).rejects.toThrow();
    expect(reload(first.id).ignoredReason).toBeNull();
  });

  it("restores skipped duplicates when the option is turned off", async () => {
    const wf = createWorkflow();
    insertVideo(wf.id, { contentHash: "h", status: "published", youtubeVideoId: "yt1" });
    const copy = insertVideo(wf.id, { contentHash: "h", status: "ignored", ignoredReason: "duplicate" });
    expect(reapplyVideoScope(wf.id)).toEqual({ restored: 0, skipped: 0 });
    getDb().update(workflows).set({ skipDuplicates: false }).where(eq(workflows.id, wf.id)).run();
    expect(reapplyVideoScope(wf.id)).toEqual({ restored: 1, skipped: 0 });
    expect(reload(copy.id).status).toBe("discovered");
  });
});
