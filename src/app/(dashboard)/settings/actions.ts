"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { isDiscordWebhook, notifyDiscord } from "@/server/notify";
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
  discordWebhookUrl: z
    .string()
    .trim()
    .refine((url) => url === "" || isDiscordWebhook(url), "La URL del webhook de Discord no es válida"),
  regionCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Usa un código de país de 2 letras"),
});

export async function sendTestNotice(url: string): Promise<ActionResult> {
  await requireAdmin();
  if (!isDiscordWebhook(url)) return { ok: false, error: "Pega la URL del webhook de Discord (https://discord.com/api/webhooks/…)" };
  const ok = await notifyDiscord("👋 Aviso de prueba de OOI Video Sync: los avisos llegarán a este canal.", url.trim());
  return ok ? { ok: true, message: "Aviso de prueba enviado" } : { ok: false, error: "Discord no aceptó el mensaje; revisa la URL del webhook" };
}

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
