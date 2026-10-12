"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { requireAdmin } from "@/server/session";
import { settingsSchema, updateSettings } from "@/server/settings";

const input = settingsSchema.extend({
  timeZone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("es", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Zona horaria desconocida"),
  regionCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Usa un código de país de 2 letras"),
});

export async function saveSettings(formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const parsed = input.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(". ") };
  }
  updateSettings(parsed.data);
  refresh();
  return { ok: true, message: "Ajustes guardados" };
}
