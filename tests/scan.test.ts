import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { jobs, videos, workflows } from "@/server/db/schema";
import { scanWorkflow } from "@/server/jobs/handlers/scan";
import type { DriveItem } from "@/server/providers/onedrive";
import { createWorkflow, json, mockFetch } from "./helpers";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function file(id: string, name: string, size: number, modifiedMinutesAgo: number, mimeType = "video/mp4"): DriveItem {
  return {
    id,
    name,
    size,
    eTag: `${id}-${size}`,
    createdDateTime: minutesAgo(modifiedMinutesAgo),
    lastModifiedDateTime: minutesAgo(modifiedMinutesAgo),
    file: { mimeType },
    parentReference: { driveId: "drive1", id: "folder1", path: "/drive/root:/Videos" },
  };
}

function serveFolder(items: DriveItem[]) {
  mockFetch((url) => {
    expect(url.pathname).toBe("/v1.0/drives/drive1/items/folder1/children");
    return json({ value: items });
  });
}

const videosOf = (workflowId: number) =>
  getDb().select().from(videos).where(eq(videos.workflowId, workflowId)).all();
const metadataJobs = () =>
  getDb().select().from(jobs).where(eq(jobs.type, "generate_metadata")).all();

describe("scanWorkflow", () => {
  it("ignores files that were already there unless asked, and skips non-videos", async () => {
    const wf = createWorkflow({ includeExisting: false });
    serveFolder([file("a", "viejo.mp4", 100, 600), file("doc", "acta.pdf", 10, 600, "application/pdf")]);
    await scanWorkflow({ workflowId: wf.id });

    const [video] = videosOf(wf.id);
    expect(videosOf(wf.id)).toHaveLength(1);
    expect(video).toMatchObject({ name: "viejo.mp4", status: "ignored", path: "/Videos" });
  });

  it("sends stable new videos to naming with a sequence number", async () => {
    const wf = createWorkflow({ includeExisting: true, stableMinutes: 5 });
    serveFolder([file("old", "listo.mp4", 100, 30), file("new", "subiendo.mp4", 50, 1)]);
    await scanWorkflow({ workflowId: wf.id });

    const byName = Object.fromEntries(videosOf(wf.id).map((v) => [v.name, v]));
    expect(byName["listo.mp4"]).toMatchObject({ status: "discovered", sequence: 1 });
    expect(byName["subiendo.mp4"]).toMatchObject({ status: "discovered", sequence: null });
    const queued = metadataJobs().map((j) => j.payload.videoId);
    expect(queued).toContain(byName["listo.mp4"].id);
    expect(queued).not.toContain(byName["subiendo.mp4"].id);
    expect(getDb().select().from(workflows).where(eq(workflows.id, wf.id)).get()?.counter).toBe(1);
  });

  it("restarts the stability timer when the file keeps changing", async () => {
    const wf = createWorkflow({ includeExisting: true, stableMinutes: 5 });
    serveFolder([file("grow", "creciendo.mp4", 10, 30)]);
    // First scan: an old timestamp makes it ready… unless it changes before the next one.
    getDb().update(workflows).set({ stableMinutes: 60 }).where(eq(workflows.id, wf.id)).run();
    await scanWorkflow({ workflowId: wf.id });

    serveFolder([file("grow", "creciendo.mp4", 20, 30)]);
    getDb().update(workflows).set({ stableMinutes: 5 }).where(eq(workflows.id, wf.id)).run();
    await scanWorkflow({ workflowId: wf.id });

    const [video] = videosOf(wf.id);
    expect(video).toMatchObject({ size: 20, sequence: null });
    expect(Date.now() - video.stableSince.getTime()).toBeLessThan(60_000);
  });

  it("ignores pending videos that left the folder", async () => {
    const wf = createWorkflow({ includeExisting: true, stableMinutes: 60 });
    serveFolder([file("gone", "borrado.mp4", 10, 1)]);
    await scanWorkflow({ workflowId: wf.id });
    serveFolder([]);
    await scanWorkflow({ workflowId: wf.id });
    expect(videosOf(wf.id)[0]).toMatchObject({ status: "ignored", error: "Ya no está en la carpeta de OneDrive" });
  });

  it("records the error and stops on listing failures", async () => {
    const wf = createWorkflow();
    mockFetch(() => json({ error: { code: "itemNotFound", message: "nope" } }, { status: 404 }));
    await expect(scanWorkflow({ workflowId: wf.id })).rejects.toThrow();
    const updated = getDb().select().from(workflows).where(eq(workflows.id, wf.id)).get()!;
    expect(updated.lastScanError).toMatch(/No se encontró/);
    expect(updated.lastScannedAt).not.toBeNull();
  });
});
