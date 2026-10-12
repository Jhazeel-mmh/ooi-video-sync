import { TZDate } from "@date-fns/tz";
import { addDays, format, startOfDay } from "date-fns";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { quotaUsage } from "./db/schema";
import { getSettings } from "./settings";

/** YouTube Data API quota resets at midnight Pacific Time. */
const QUOTA_TZ = "America/Los_Angeles";

/** Approximate costs (units) of the non-upload calls we make. */
export const QUOTA_COST = {
  list: 1,
  update: 50,
  playlistInsert: 50,
} as const;

export function quotaDay(now = new Date()): string {
  return format(new TZDate(now.getTime(), QUOTA_TZ), "yyyy-MM-dd");
}

export function nextQuotaReset(now = new Date()): Date {
  const reset = startOfDay(addDays(new TZDate(now.getTime(), QUOTA_TZ), 1));
  // A few minutes of slack: resets aren't always on the dot.
  return new Date(reset.getTime() + 5 * 60 * 1000);
}

export function recordQuota(units: number, { upload = false } = {}): void {
  getDb()
    .insert(quotaUsage)
    .values({ datePt: quotaDay(), units, uploads: upload ? 1 : 0 })
    .onConflictDoUpdate({
      target: quotaUsage.datePt,
      set: {
        units: sql`${quotaUsage.units} + ${units}`,
        uploads: sql`${quotaUsage.uploads} + ${upload ? 1 : 0}`,
      },
    })
    .run();
}

export function getTodayQuota(): { units: number; uploads: number } {
  const row = getDb().select().from(quotaUsage).where(eq(quotaUsage.datePt, quotaDay())).get();
  return { units: row?.units ?? 0, uploads: row?.uploads ?? 0 };
}

/** Whether one more upload fits in today's quota and upload cap. */
export function canStartUpload(): { ok: true } | { ok: false; reason: string } {
  const settings = getSettings();
  const today = getTodayQuota();
  if (settings.maxUploadsPerDay > 0 && today.uploads >= settings.maxUploadsPerDay) {
    return { ok: false, reason: `Límite diario de ${settings.maxUploadsPerDay} subidas alcanzado` };
  }
  if (settings.dailyQuotaUnits > 0 && today.units + settings.uploadCostUnits > settings.dailyQuotaUnits) {
    return { ok: false, reason: `Cuota diaria de YouTube agotada (${today.units}/${settings.dailyQuotaUnits} unidades)` };
  }
  return { ok: true };
}
