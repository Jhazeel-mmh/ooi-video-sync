"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { PRIVACY_STATUSES } from "@/server/db/schema";
import { logEvent } from "@/server/events";
import { enqueue } from "@/server/jobs/queue";
import { buildMetadata } from "@/server/naming/metadata";
import { transcriptionUnavailableReason } from "@/server/naming/transcript";
import { parseTags, sanitizeDescription, sanitizeTags, sanitizeTitle } from "@/server/naming/sanitize";
import { requireAdmin } from "@/server/session";
import {
  canIgnore,
  canRegenerate,
  ignoreVideo,
  loadVideo,
  queueMetadata,
  queueTransfer,
  restoreVideo,
  retryVideo,
  setVideoStatus,
  updateVideo,
  videosByIds,
} from "@/server/videos";

export type BulkAction = "approve" | "retry" | "ignore" | "restore" | "regenerate";

const BULK_LABELS: Record<BulkAction, string> = {
  approve: "aprobado(s) para subir",
  retry: "enviado(s) a reintentar",
  ignore: "ignorado(s)",
  restore: "restaurado(s)",
  regenerate: "con título en regeneración",
};

export async function bulkVideoAction(ids: number[], action: BulkAction): Promise<ActionResult> {
  await requireAdmin();
  let applied = 0;
  for (const video of videosByIds(ids)) {
    switch (action) {
      case "approve":
        if (video.status !== "pending_review") continue;
        queueTransfer(video.id);
        logEvent({ videoId: video.id }, "Aprobado para subir");
        break;
      case "retry":
        if (video.status !== "failed" && video.status !== "waiting_quota") continue;
        retryVideo(video);
        logEvent({ videoId: video.id }, "Reintento manual");
        break;
      case "ignore":
        if (!canIgnore(video)) continue;
        ignoreVideo(video);
        logEvent({ videoId: video.id }, "Marcado como ignorado");
        break;
      case "restore":
        if (video.status !== "ignored") continue;
        restoreVideo(video);
        logEvent({ videoId: video.id }, "Restaurado");
        break;
      case "regenerate":
        if (!canRegenerate(video)) continue;
        setVideoStatus(video.id, "discovered", { error: null });
        queueMetadata(video.id);
        break;
    }
    applied += 1;
  }
  refresh();
  if (applied === 0) return { ok: false, error: "Ninguno de los videos seleccionados admite esa acción" };
  return { ok: true, message: `${applied} video(s) ${BULK_LABELS[action]}` };
}

const videoInput = z.object({
  title: z.string(),
  description: z.string(),
  tags: z.string(),
  privacyStatus: z.enum(PRIVACY_STATUSES),
  /** `datetime-local` value already converted to ISO by the client; empty = publish now. */
  publishAt: z.string(),
});

export async function saveVideo(
  videoId: number,
  input: z.input<typeof videoInput>,
  options: { approve?: boolean } = {},
): Promise<ActionResult> {
  await requireAdmin();
  const loaded = loadVideo(videoId);
  if (!loaded) return { ok: false, error: "El video no existe" };
  const { video } = loaded;

  const parsed = videoInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };
  const values = parsed.data;
  const title = sanitizeTitle(values.title, "");
  if (!title) return { ok: false, error: "El título no puede quedar vacío" };
  const publishAt = values.publishAt ? new Date(values.publishAt) : null;
  if (publishAt && Number.isNaN(publishAt.getTime())) return { ok: false, error: "Fecha de publicación inválida" };
  if (publishAt && publishAt.getTime() < Date.now() && !video.youtubeVideoId) {
    return { ok: false, error: "La fecha de publicación programada ya pasó" };
  }

  const description = sanitizeDescription(values.description);
  const tags = sanitizeTags(parseTags(values.tags));
  const changed = title !== video.title || description !== video.description || tags.join(",") !== (video.tags ?? []).join(",");
  updateVideo(videoId, {
    title,
    description,
    tags,
    privacyStatus: values.privacyStatus,
    publishAt,
    ...(changed ? { titleSource: "manual" as const } : {}),
  });

  let message = "Cambios guardados";
  if (video.youtubeVideoId) {
    enqueue("sync_metadata", { videoId }, { dedupeKey: `sync:${videoId}` });
    logEvent({ videoId }, "Editado en el dashboard; se actualizará en YouTube");
    message = "Cambios guardados; se actualizarán en YouTube en unos segundos";
  } else if (options.approve && (video.status === "pending_review" || video.status === "failed")) {
    queueTransfer(videoId);
    logEvent({ videoId }, "Aprobado para subir");
    message = "Aprobado: el video entró a la cola de subida";
  }
  refresh();
  return { ok: true, message };
}

export async function suggestMetadata(
  videoId: number,
  useAi: boolean,
): Promise<ActionResult<{ title: string; description: string; tags: string[] }>> {
  await requireAdmin();
  const loaded = loadVideo(videoId);
  if (!loaded) return { ok: false, error: "El video no existe" };
  const result = await buildMetadata(loaded.video, loaded.workflow, { useAi });
  if (useAi && result.aiError) return { ok: false, error: `La IA no respondió: ${result.aiError}` };
  return {
    ok: true,
    message: useAi ? "Propuesta de la IA lista; revisa y guarda" : "Plantilla aplicada; revisa y guarda",
    data: { title: result.title, description: result.description, tags: result.tags },
  };
}

export async function transcribeVideoNow(videoId: number): Promise<ActionResult> {
  await requireAdmin();
  const unavailable = transcriptionUnavailableReason();
  if (unavailable) return { ok: false, error: unavailable };
  if (!loadVideo(videoId)) return { ok: false, error: "El video no existe" };
  enqueue("transcribe_video", { videoId }, { dedupeKey: `transcribe:${videoId}`, maxAttempts: 3 });
  refresh();
  return { ok: true, message: "Transcripción en cola; aparecerá aquí en unos minutos" };
}
