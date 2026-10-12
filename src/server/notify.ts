import { and, eq, isNull, max } from "drizzle-orm";
import { getDb } from "./db/client";
import { videos, workflows } from "./db/schema";
import { env } from "./env";
import { getSettings } from "./settings";

const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** At most one "new videos to review" notice per workflow in this window. */
const REVIEW_NOTICE_EVERY_MS = 30 * 60_000;

export function isDiscordWebhook(url: string): boolean {
  return DISCORD_WEBHOOK.test(url.trim());
}

/** Escapes Discord markdown in user content such as video titles. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_~`|>\\])/g, "\\$1");
}

export function appLink(pathname: string): string {
  return new URL(pathname, env().APP_URL).toString();
}

/**
 * Posts a message to the configured Discord webhook. Never throws: a failed
 * notice must not break the job that sent it.
 */
export async function notifyDiscord(content: string, url = getSettings().discordWebhookUrl): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No pings: titles could contain @everyone.
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`Discord respondió ${res.status} al enviar un aviso`);
    return res.ok;
  } catch (error) {
    console.warn("No se pudo enviar el aviso a Discord:", error);
    return false;
  }
}

/** Sends a notice without waiting for it. */
export function notifyInBackground(content: string): void {
  void notifyDiscord(content);
}

/**
 * One grouped notice per workflow with videos newly waiting for review, at
 * most every 30 minutes, so a batch of videos doesn't flood the channel.
 */
export async function notifyPendingReviews(now = new Date()): Promise<number> {
  if (!getSettings().discordWebhookUrl) return 0;
  const db = getDb();
  const pending = db
    .select({ id: videos.id, workflowId: videos.workflowId, workflowName: workflows.name })
    .from(videos)
    .innerJoin(workflows, eq(videos.workflowId, workflows.id))
    .where(and(eq(videos.status, "pending_review"), isNull(videos.reviewNotifiedAt)))
    .all();

  const byWorkflow = Map.groupBy(pending, (v) => v.workflowId);
  let sent = 0;
  for (const [workflowId, items] of byWorkflow) {
    const last = db
      .select({ at: max(videos.reviewNotifiedAt) })
      .from(videos)
      .where(eq(videos.workflowId, workflowId))
      .get()?.at;
    if (last && now.getTime() - last.getTime() < REVIEW_NOTICE_EVERY_MS) continue;

    const count = items.length;
    const ok = await notifyDiscord(
      `🔔 ${count} video${count === 1 ? "" : "s"} nuevo${count === 1 ? "" : "s"} por revisar en «${escapeMarkdown(items[0].workflowName)}»\n` +
        appLink(`/videos?status=review&workflow=${workflowId}`),
    );
    if (!ok) continue;
    for (const item of items) {
      db.update(videos).set({ reviewNotifiedAt: now }).where(eq(videos.id, item.id)).run();
    }
    sent += 1;
  }
  return sent;
}
