import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import ffmpegStatic from "ffmpeg-static";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { jobs, videos } from "@/server/db/schema";
import { generateMetadata } from "@/server/jobs/handlers/generate-metadata";
import { transcribeVideo } from "@/server/naming/transcript";
import { updateSettings } from "@/server/settings";
import { createWorkflow, json, mockFetch } from "./helpers";

process.env.GEMINI_API_KEY = "gemini-test-key";

const ctx = { signal: new AbortController().signal, attempt: 1, maxAttempts: 5 };
let sample: string;

beforeAll(() => {
  sample = path.join(process.env.DATA_DIR!, "speech.mp4");
  execFileSync(ffmpegStatic!, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=64x64:rate=10",
    "-f", "lavfi", "-i", "sine=duration=3",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", sample,
  ]);
});

beforeEach(() => {
  updateSettings({ aiProvider: "gemini", timeZone: "America/Mexico_City", transcriptMaxMinutes: 0 });
  getDb().delete(jobs).run();
});

function reply(text: string) {
  return json({ id: "i", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }] });
}

/** OneDrive redirects to the local sample; Gemini answers transcription and naming requests. */
function services(metadata: object = {}) {
  const audioRequests: { mime: string; bytes: number }[] = [];
  const namingPrompts: string[] = [];
  mockFetch((url, init) => {
    if (url.pathname.endsWith("/content")) return new Response(null, { status: 302, headers: { Location: sample } });
    const body = JSON.parse(init.body as string);
    if (Array.isArray(body.input)) {
      const audio = body.input.find((part: { type: string }) => part.type === "audio");
      audioRequests.push({ mime: audio.mime_type, bytes: Buffer.from(audio.data, "base64").length });
      return reply("[00:00] Bienvenidos a la misa.\n[00:01] Lectura del día.");
    }
    namingPrompts.push(body.input);
    return reply(JSON.stringify({ title: "Misa con lectura", description: "Celebración.", tags: ["misa"], ...metadata }));
  });
  return { audioRequests, namingPrompts };
}

function insertVideo(workflowId: number) {
  return getDb()
    .insert(videos)
    .values({
      workflowId,
      driveId: "drive1",
      itemId: `item-${Math.random()}`,
      name: "misa.mp4",
      path: "/Videos",
      size: 1000,
      lastSeenSize: 1000,
      stableSince: new Date(),
      durationMs: 3 * 3600 * 1000,
    })
    .returning()
    .get();
}

describe("transcribeVideo", () => {
  it("extracts Opus audio with ffmpeg, sends it to Gemini and cleans up", async () => {
    const wf = createWorkflow();
    const video = insertVideo(wf.id);
    const { audioRequests } = services();
    const transcript = await transcribeVideo(video, wf, ctx.signal);

    expect(transcript).toBe("[0:00:00] Bienvenidos a la misa.\n[0:00:01] Lectura del día.");
    expect(audioRequests).toHaveLength(1);
    expect(audioRequests[0].mime).toBe("audio/ogg");
    expect(audioRequests[0].bytes).toBeGreaterThan(100);
    expect(existsSync(path.join(process.env.DATA_DIR!, "tmp", `audio-${video.id}`))).toBe(false);
  });

  it("splits long audio into chunks and shifts each chunk's marks", async () => {
    const wf = createWorkflow();
    const video = insertVideo(wf.id);
    const { audioRequests } = services();
    const transcript = await transcribeVideo(video, wf, ctx.signal, { chunkSeconds: 1 });

    expect(audioRequests.length).toBeGreaterThanOrEqual(3);
    expect(transcript).toContain("[0:00:00] Bienvenidos");
    expect(transcript).toContain("[0:00:02] Bienvenidos");
  });
});

describe("naming with the transcript", () => {
  it("transcribes before naming, gives the transcript to the AI and appends chapters", async () => {
    const wf = createWorkflow({ useAi: true, useTranscript: true, addChapters: true });
    const video = insertVideo(wf.id);
    const { namingPrompts } = services({
      chapters: [
        { start: "0:00:00", title: "Bienvenida" },
        { start: "0:15:00", title: "Lecturas" },
        { start: "0:40:00", title: "Homilía" },
      ],
    });
    await generateMetadata({ videoId: video.id }, ctx);

    const saved = getDb().select().from(videos).where(eq(videos.id, video.id)).get()!;
    expect(saved.transcript).toContain("Bienvenidos a la misa");
    expect(namingPrompts[0]).toContain("<transcripcion>");
    expect(saved).toMatchObject({
      status: "pending_review",
      title: "Misa con lectura",
      titleSource: "ai",
      description: "Celebración.\n\nCapítulos:\n00:00 Bienvenida\n15:00 Lecturas\n40:00 Homilía",
    });
  });

  it("names the video anyway when transcription fails for good", async () => {
    const wf = createWorkflow({ useAi: true, useTranscript: true });
    const video = insertVideo(wf.id);
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/content")) return new Response(null, { status: 302, headers: { Location: sample } });
      if (Array.isArray(JSON.parse(init.body as string).input)) return json({ error: { code: 400, message: "bad audio" } }, { status: 400 });
      return reply(JSON.stringify({ title: "Sin transcripción", description: "", tags: [] }));
    });
    await generateMetadata({ videoId: video.id }, ctx);
    expect(getDb().select().from(videos).where(eq(videos.id, video.id)).get()).toMatchObject({
      status: "pending_review",
      title: "Sin transcripción",
      transcript: null,
    });
  });
});
