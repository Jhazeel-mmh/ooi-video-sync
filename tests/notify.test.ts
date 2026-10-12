import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { videos } from "@/server/db/schema";
import { checkProcessing } from "@/server/jobs/handlers/check-processing";
import { escapeMarkdown, isDiscordWebhook, notifyDiscord, notifyPendingReviews } from "@/server/notify";
import { updateSettings } from "@/server/settings";
import { createWorkflow, json, mockFetch } from "./helpers";

const WEBHOOK = "https://discord.com/api/webhooks/123456/abc-DEF_ghi";

function discord() {
  const messages: string[] = [];
  const calls = mockFetch((url, init) => {
    if (url.href === WEBHOOK) {
      messages.push(JSON.parse(init.body as string).content);
      return new Response(null, { status: 204 });
    }
    return json({ items: [{ id: "yt1", status: { uploadStatus: "processed", privacyStatus: "private" } }] });
  });
  return { messages, calls };
}

function insertVideo(workflowId: number, values: Partial<typeof videos.$inferInsert> = {}) {
  return getDb()
    .insert(videos)
    .values({
      workflowId,
      driveId: "d",
      itemId: `i-${Math.random()}`,
      name: "misa.mp4",
      path: "/Videos",
      size: 1,
      lastSeenSize: 1,
      stableSince: new Date(),
      status: "pending_review",
      title: "Misa",
      ...values,
    })
    .returning()
    .get();
}

beforeEach(() => {
  updateSettings({ discordWebhookUrl: WEBHOOK });
  getDb().delete(videos).run();
});

describe("notifyDiscord", () => {
  it("posts the message without mentions and never throws", async () => {
    const { calls, messages } = discord();
    expect(await notifyDiscord("hola @everyone")).toBe(true);
    expect(messages).toEqual(["hola @everyone"]);
    expect(JSON.parse(calls[0].init.body as string).allowed_mentions).toEqual({ parse: [] });

    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await notifyDiscord("x")).toBe(false);
    updateSettings({ discordWebhookUrl: "" });
    expect(await notifyDiscord("x")).toBe(false);
  });

  it("validates webhook URLs and escapes markdown", () => {
    expect(isDiscordWebhook(WEBHOOK)).toBe(true);
    expect(isDiscordWebhook("https://example.com/api/webhooks/1/x")).toBe(false);
    expect(escapeMarkdown("*Misa* _especial_")).toBe("\\*Misa\\* \\_especial\\_");
  });
});

describe("notifyPendingReviews", () => {
  it("groups new videos per workflow and waits 30 minutes between notices", async () => {
    const wf = createWorkflow({ name: "Misas" });
    for (let i = 0; i < 3; i++) insertVideo(wf.id);
    const { messages } = discord();
    const now = new Date();

    expect(await notifyPendingReviews(now)).toBe(1);
    expect(messages[0]).toMatch(/^🔔 3 videos nuevos por revisar en «Misas»\nhttp:\/\/localhost:3000\/videos\?status=review&workflow=\d+$/);

    // Nothing new: nothing sent. A new one soon after waits for the window.
    expect(await notifyPendingReviews(now)).toBe(0);
    insertVideo(wf.id);
    expect(await notifyPendingReviews(new Date(now.getTime() + 10 * 60_000))).toBe(0);
    expect(await notifyPendingReviews(new Date(now.getTime() + 31 * 60_000))).toBe(1);
    expect(messages[1]).toContain("1 video nuevo por revisar");
  });

  it("keeps videos pending when the notice fails, to retry on the next tick", async () => {
    const wf = createWorkflow();
    const video = insertVideo(wf.id);
    mockFetch(() => new Response(null, { status: 500 }));
    expect(await notifyPendingReviews()).toBe(0);
    expect(getDb().select().from(videos).where(eq(videos.id, video.id)).get()?.reviewNotifiedAt).toBeNull();
  });
});

describe("published notice", () => {
  it("announces videos that finished processing", async () => {
    const wf = createWorkflow();
    const video = insertVideo(wf.id, { status: "processing", youtubeVideoId: "yt1", title: "Misa *especial*" });
    const { messages } = discord();
    await checkProcessing({ videoId: video.id });
    expect(messages).toEqual(["✅ Publicado en YouTube (privado): **Misa \\*especial\\***\nhttps://youtu.be/yt1"]);
  });
});
