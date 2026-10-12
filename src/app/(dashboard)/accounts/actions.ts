"use server";

import { eq, or } from "drizzle-orm";
import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { getDb } from "@/server/db/client";
import { accounts, workflows } from "@/server/db/schema";
import { requireAdmin } from "@/server/session";

export async function disconnectAccount(accountId: number): Promise<ActionResult> {
  await requireAdmin();
  const db = getDb();
  const usedBy = db
    .select({ name: workflows.name })
    .from(workflows)
    .where(or(eq(workflows.onedriveAccountId, accountId), eq(workflows.youtubeAccountId, accountId)))
    .all();
  if (usedBy.length > 0) {
    return {
      ok: false,
      error: `La usan estos workflows: ${usedBy.map((w) => w.name).join(", ")}. Cámbialos o elimínalos primero.`,
    };
  }
  db.delete(accounts).where(eq(accounts.id, accountId)).run();
  refresh();
  return { ok: true, message: "Cuenta desconectada" };
}
