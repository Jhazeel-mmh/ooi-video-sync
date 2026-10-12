import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db/client";
import { settings } from "./db/schema";

export const AI_PROVIDERS = ["auto", "claude", "gemini"] as const;
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
/** Both are on Gemini's free tier. */
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"] as const;

export const settingsSchema = z.object({
  /** Daily YouTube Data API quota for the Google Cloud project. */
  dailyQuotaUnits: z.coerce.number().int().min(0).default(10_000),
  /** Units charged per `videos.insert`; verify the current value in the Cloud console. */
  uploadCostUnits: z.coerce.number().int().min(0).default(1600),
  /** Extra cap on uploads per day; 0 means "only limited by quota". */
  maxUploadsPerDay: z.coerce.number().int().min(0).default(0),
  maxParallelTransfers: z.coerce.number().int().min(1).max(4).default(1),
  /** "auto": Claude when ANTHROPIC_API_KEY is set, otherwise Gemini. */
  aiProvider: z.enum(AI_PROVIDERS).default("auto"),
  /** Claude model (key kept as `aiModel` for existing installs). */
  aiModel: z.enum(CLAUDE_MODELS).default("claude-opus-5-5"),
  geminiModel: z.enum(GEMINI_MODELS).default("gemini-3.8-flash"),
  /** Minutes of audio to transcribe per video; 0 = the whole video. */
  transcriptMaxMinutes: z.coerce.number().int().min(0).default(0),
  timeZone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  regionCode: z.string().length(2).default("US"),
});

export type Settings = z.infer<typeof settingsSchema>;

export function getSettings(): Settings {
  const rows = getDb().select().from(settings).all();
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const parsed = settingsSchema.safeParse(raw);
  // A bad stored value shouldn't take the app down; fall back to defaults.
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function updateSettings(values: Partial<Settings>): void {
  const db = getDb();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
    }
  });
}

const WORKER_HEARTBEAT_KEY = "worker.heartbeat";

export function recordWorkerHeartbeat(): void {
  const value = new Date().toISOString();
  getDb()
    .insert(settings)
    .values({ key: WORKER_HEARTBEAT_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function lastWorkerHeartbeat(): Date | null {
  const row = getDb().select().from(settings).where(eq(settings.key, WORKER_HEARTBEAT_KEY)).get();
  return typeof row?.value === "string" ? new Date(row.value) : null;
}
