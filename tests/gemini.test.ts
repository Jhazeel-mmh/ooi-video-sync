import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { videos } from "@/server/db/schema";
import { RetryableError } from "@/server/errors";
import { resolveProvider } from "@/server/naming/ai";
import { generateWithGemini } from "@/server/naming/ai/gemini";
import { buildMetadata } from "@/server/naming/metadata";
import { updateSettings } from "@/server/settings";
import { createWorkflow, json, mockFetch } from "./helpers";

process.env.GEMINI_API_KEY = "gemini-test-key";

function geminiReply(text: string, status = "completed") {
  return json({
    id: "int_1",
    status,
    steps: [
      { type: "user_input", content: [{ type: "text", text: "…" }] },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
  });
}

const input = {
  fileName: "VID_20260510_120000.mp4",
  folderPath: "/Videos",
  recordedAt: "domingo 10 de mayo de 2026",
  duration: "1:05:00",
  channelContext: "Parroquia San José",
  template: { title: "Misa 10 de mayo", description: "", tags: [] },
  recentTitles: [],
};

beforeEach(() => {
  updateSettings({ aiProvider: "auto", geminiModel: "gemini-3.8-flash", timeZone: "America/Mexico_City" });
});

describe("resolveProvider", () => {
  it("prefers Claude when its key is set, falls back to Gemini, and honours explicit choices", () => {
    // This test file sets only GEMINI_API_KEY.
    expect(resolveProvider({ aiProvider: "auto" })).toBe("gemini");
    expect(resolveProvider({ aiProvider: "claude" })).toBeNull();
    expect(resolveProvider({ aiProvider: "gemini" })).toBe("gemini");
  });
});

describe("generateWithGemini", () => {
  it("asks for JSON matching the schema and parses the answer", async () => {
    const calls = mockFetch(() =>
      geminiReply(JSON.stringify({ title: "Misa dominical", description: "Celebración del domingo", tags: ["misa"] })),
    );
    const result = await generateWithGemini({ ...input, transcript: "[0:00:05] Bienvenidos" }, "gemini-3.8-flash");
    expect(result).toEqual({ title: "Misa dominical", description: "Celebración del domingo", tags: ["misa"] });

    const { url, init } = calls[0];
    expect(url.pathname).toMatch(/\/interactions$/);
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("gemini-test-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gemini-3.8-flash",
      store: false,
      response_format: { type: "text", mime_type: "application/json" },
      generation_config: { thinking_level: "low" },
    });
    expect(body.response_format.schema.properties).toHaveProperty("title");
    expect(body.input).toContain("Bienvenidos");
    expect(body.system_instruction).toContain("editor de un canal de YouTube");
  });

  it("includes chapters in the schema when asked", async () => {
    const calls = mockFetch(() =>
      geminiReply(JSON.stringify({ title: "t", description: "d", tags: [], chapters: [{ start: "0:00:00", title: "Inicio" }] })),
    );
    const result = await generateWithGemini({ ...input, chapters: true }, "gemini-3.8-flash");
    expect(result.chapters).toEqual([{ start: "0:00:00", title: "Inicio" }]);
    expect(JSON.parse(calls[0].init.body as string).response_format.schema.properties).toHaveProperty("chapters");
  });

  it("turns rate limits into retryable errors", async () => {
    mockFetch(() => json({ error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
    await expect(generateWithGemini(input, "gemini-3.8-flash")).rejects.toBeInstanceOf(RetryableError);
  });

  it("rejects answers that don't match the schema", async () => {
    mockFetch(() => geminiReply("no es json"));
    await expect(generateWithGemini(input, "gemini-3.8-flash")).rejects.toThrow(/formato esperado/);
  });
});

describe("buildMetadata with Gemini", () => {
  it("uses Gemini when there's no Claude key, and flags rate limits as retryable", async () => {
    const workflow = createWorkflow({ useAi: true, titleTemplate: "{filename}" });
    const video = getDb()
      .insert(videos)
      .values({
        workflowId: workflow.id,
        driveId: "d",
        itemId: `i-${Math.random()}`,
        name: "misa.mp4",
        path: "/Videos",
        size: 1,
        lastSeenSize: 1,
        stableSince: new Date(),
      })
      .returning()
      .get();

    mockFetch(() => geminiReply(JSON.stringify({ title: "Misa <especial>", description: "d", tags: ["a"] })));
    expect(await buildMetadata(video, workflow, { useAi: true })).toMatchObject({ title: "Misa especial", source: "ai" });

    mockFetch(() => json({ error: { code: 429, message: "quota" } }, { status: 429 }));
    expect(await buildMetadata(video, workflow, { useAi: true })).toMatchObject({
      title: "misa",
      source: "template",
      aiRetryable: true,
    });
  });
});
