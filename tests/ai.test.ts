import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { videos } from "@/server/db/schema";
import { buildMetadata } from "@/server/naming/metadata";
import { updateSettings } from "@/server/settings";
import { createWorkflow, json, mockFetch } from "./helpers";

process.env.ANTHROPIC_API_KEY = "sk-ant-test";

function message(text: string, stopReason = "end_turn") {
  return json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function setup() {
  updateSettings({ timeZone: "America/Mexico_City", aiModel: "claude-opus-5-5" });
  const workflow = createWorkflow({
    titleTemplate: "Misa {date:d 'de' MMMM} #{n}",
    descriptionTemplate: "Grabado el {date}",
    tagsTemplate: "misa, parroquia",
    useAi: true,
    aiContext: "Canal de la parroquia San José. Siempre incluir: www.sanjose.org",
  });
  const video = getDb()
    .insert(videos)
    .values({
      workflowId: workflow.id,
      driveId: "d",
      itemId: `i-${Math.random()}`,
      name: "VID_20260510_120000.mp4",
      path: "/Videos/Misas",
      size: 10,
      lastSeenSize: 10,
      stableSince: new Date(),
      sequence: 4,
    })
    .returning()
    .get();
  return { workflow, video };
}

describe("buildMetadata", () => {
  it("renders the templates without calling the API when AI is off", async () => {
    const { workflow, video } = setup();
    const calls = mockFetch(() => {
      throw new Error("no network expected");
    });
    const result = await buildMetadata(video, workflow, { useAi: false });
    expect(result).toEqual({
      title: "Misa 10 de mayo #4",
      description: "Grabado el 10/05/2026",
      tags: ["misa", "parroquia"],
      source: "template",
    });
    expect(calls).toHaveLength(0);
  });

  it("uses Claude's structured answer, sanitized", async () => {
    const { workflow, video } = setup();
    const calls = mockFetch(() =>
      message(JSON.stringify({ title: "Misa dominical <en vivo>", description: "Visítanos en www.sanjose.org", tags: ["Misa", "misa", "San José"] })),
    );
    const result = await buildMetadata(video, workflow, { useAi: true });
    expect(result).toEqual({
      title: "Misa dominical en vivo",
      description: "Visítanos en www.sanjose.org",
      tags: ["Misa", "San José"],
      source: "ai",
    });

    const request = JSON.parse(calls[0].init.body as string);
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(request.fallbacks).toBe("default");
    const prompt = request.messages[0].content as string;
    expect(prompt).toContain("VID_20260510_120000.mp4");
    expect(prompt).toContain("www.sanjose.org");
    expect(prompt).toContain("Misa 10 de mayo #4");
  });

  it("falls back to the template when Claude declines", async () => {
    const { workflow, video } = setup();
    mockFetch(() => message("", "refusal"));
    const result = await buildMetadata(video, workflow, { useAi: true });
    expect(result.source).toBe("template");
    expect(result.title).toBe("Misa 10 de mayo #4");
    expect(result.aiError).toMatch(/no generó/);
  });

  it("falls back to the template on API errors", async () => {
    const { workflow, video } = setup();
    mockFetch(() => json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: 400 }));
    const result = await buildMetadata(video, workflow, { useAi: true });
    expect(result.source).toBe("template");
    expect(result.aiError).toBeDefined();
  });
});
