import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { jobs, videos, workflows } from "@/server/db/schema";
import { scanWorkflow } from "@/server/jobs/handlers/scan";
import type { DriveItem } from "@/server/providers/onedrive";
import { updateSettings } from "@/server/settings";
import { reapplyVideoScope } from "@/server/video-scope";
import { ignoreVideo } from "@/server/videos";
import { createWorkflow, json, mockFetch } from "./helpers";

const TZ = "America/Mexico_City";
/** 1 de mayo de 2026, 00:00 en Ciudad de México. */
const MAY_1 = new Date("2026-05-01T06:00:00Z");

function file(id: string, name: string, createdAt = "2026-01-15T12:00:00Z"): DriveItem {
  return {
    id,
    name,
    size: 100,
    eTag: id,
    createdDateTime: createdAt,
    lastModifiedDateTime: "2026-01-15T12:00:00Z",
    file: { mimeType: "video/mp4" },
    parentReference: { driveId: "drive1", id: "folder1", path: "/drive/root:/Videos" },
  };
}

const FOLDER = [
  file("abr", "VID_20260430_200000.mp4"), // 30 abr 20:00 local → antes
  file("may", "VID_20260501_000500.mp4"), // 1 may 00:05 local → incluido
  file("jun", "Misa 2026-06-07.mov"),
  file("nodate", "sin fecha.mp4", "2026-05-20T12:00:00Z"), // sin fecha en el nombre: usa la de creación
];

function serve(items: DriveItem[]) {
  mockFetch(() => json({ value: items }));
}

const byName = (workflowId: number) =>
  Object.fromEntries(
    getDb()
      .select()
      .from(videos)
      .where(eq(videos.workflowId, workflowId))
      .all()
      .map((v) => [v.name, v]),
  );

beforeEach(() => {
  updateSettings({ timeZone: TZ });
  getDb().delete(jobs).run();
});

describe("since date", () => {
  it("processes only videos recorded on or after the date, existing ones included", async () => {
    const wf = createWorkflow({ includeExisting: true, sinceDate: MAY_1, stableMinutes: 0 });
    serve(FOLDER);
    await scanWorkflow({ workflowId: wf.id });

    const v = byName(wf.id);
    expect(v["VID_20260430_200000.mp4"]).toMatchObject({
      status: "ignored",
      ignoredReason: "before_since",
      error: "Grabado antes del 01/05/2026",
    });
    for (const name of ["VID_20260501_000500.mp4", "Misa 2026-06-07.mov", "sin fecha.mp4"]) {
      expect(v[name]).toMatchObject({ status: "discovered", ignoredReason: null });
    }
  });

  it("also skips old recordings that show up later", async () => {
    const wf = createWorkflow({ includeExisting: true, sinceDate: MAY_1 });
    serve([]);
    await scanWorkflow({ workflowId: wf.id });
    serve([file("late", "VID_20251224_100000.mp4")]);
    await scanWorkflow({ workflowId: wf.id });
    expect(byName(wf.id)["VID_20251224_100000.mp4"]).toMatchObject({ status: "ignored", ignoredReason: "before_since" });
  });
});

describe("reapplyVideoScope", () => {
  it("brings back skipped videos from the new date in recording order and leaves manual ignores alone", async () => {
    // Created with "only new videos": everything already there is skipped.
    const wf = createWorkflow({ includeExisting: false });
    serve(FOLDER);
    await scanWorkflow({ workflowId: wf.id });
    expect(Object.values(byName(wf.id)).every((v) => v.ignoredReason === "existing")).toBe(true);

    // The user ignores one by hand, then switches to "recorded since May 1".
    ignoreVideo(byName(wf.id)["Misa 2026-06-07.mov"]);
    getDb().update(workflows).set({ includeExisting: true, sinceDate: MAY_1 }).where(eq(workflows.id, wf.id)).run();
    expect(reapplyVideoScope(wf.id)).toEqual({ restored: 2, skipped: 0 });

    const v = byName(wf.id);
    expect(v["VID_20260430_200000.mp4"].status).toBe("ignored");
    expect(v["Misa 2026-06-07.mov"]).toMatchObject({ status: "ignored", ignoredReason: "manual" });
    expect(v["VID_20260501_000500.mp4"]).toMatchObject({ status: "discovered", ignoredReason: null, sequence: 1 });
    expect(v["sin fecha.mp4"]).toMatchObject({ status: "discovered", sequence: 2 });
    const queued = getDb().select().from(jobs).where(eq(jobs.type, "generate_metadata")).all();
    expect(queued.map((j) => j.payload.videoId).sort()).toEqual(
      [v["VID_20260501_000500.mp4"].id, v["sin fecha.mp4"].id].sort(),
    );
  });

  it("skips pending videos that fall before a later date", async () => {
    const wf = createWorkflow({ includeExisting: true, stableMinutes: 60 });
    serve(FOLDER);
    await scanWorkflow({ workflowId: wf.id });
    getDb().update(videos).set({ status: "pending_review" }).where(eq(videos.workflowId, wf.id)).run();

    getDb()
      .update(workflows)
      .set({ sinceDate: new Date("2026-06-01T06:00:00Z") })
      .where(eq(workflows.id, wf.id))
      .run();
    expect(reapplyVideoScope(wf.id)).toEqual({ restored: 0, skipped: 3 });
    const v = byName(wf.id);
    expect(v["Misa 2026-06-07.mov"].status).toBe("pending_review");
    expect(v["sin fecha.mp4"]).toMatchObject({ status: "ignored", ignoredReason: "before_since", error: "Grabado antes del 01/06/2026" });
  });

  it("does nothing for 'only new videos'", async () => {
    const wf = createWorkflow({ includeExisting: false });
    serve(FOLDER);
    await scanWorkflow({ workflowId: wf.id });
    expect(reapplyVideoScope(wf.id)).toEqual({ restored: 0, skipped: 0 });
  });
});
