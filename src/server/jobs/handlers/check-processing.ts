import { PermanentError, RescheduleSignal } from "../../errors";
import { logEvent } from "../../events";
import { escapeMarkdown, notifyDiscord } from "../../notify";
import { getVideo } from "../../providers/youtube";
import { loadVideo, setVideoStatus } from "../../videos";
import type { JobPayloads } from "../queue";

const PRIVACY_LABELS = { private: "privado", unlisted: "no listado", public: "público" } as const;

export async function checkProcessing({ videoId, checks = 0 }: JobPayloads["check_processing"]): Promise<void> {
  const loaded = loadVideo(videoId);
  if (!loaded?.video.youtubeVideoId || loaded.video.status !== "processing") return;
  const { video, workflow } = loaded;

  const remote = await getVideo(workflow.youtubeAccountId, video.youtubeVideoId!);
  if (!remote) throw new PermanentError("El video ya no existe en YouTube");

  const uploadStatus = remote.status?.uploadStatus;
  const processing = remote.processingDetails?.processingStatus;

  if (uploadStatus === "processed" || processing === "succeeded") {
    setVideoStatus(videoId, "published", { publishedAt: new Date(), error: null });
    const privacy = remote.status?.privacyStatus;
    logEvent({ videoId }, `Listo en YouTube (${privacy ? PRIVACY_LABELS[privacy] : "procesado"})`);
    await notifyDiscord(
      `✅ Publicado en YouTube${privacy ? ` (${PRIVACY_LABELS[privacy]})` : ""}: **${escapeMarkdown(video.title ?? video.name)}**\n` +
        `https://youtu.be/${video.youtubeVideoId}`,
    );
    const requested = video.publishAt ? "private" : (video.privacyStatus ?? workflow.privacyStatus);
    if (privacy && privacy !== requested) {
      logEvent(
        { videoId },
        `YouTube dejó el video como ${PRIVACY_LABELS[privacy]} en lugar de ${PRIVACY_LABELS[requested]}. ` +
          "Si tu proyecto de Google Cloud no pasó la auditoría de la API, los videos subidos quedan privados.",
        "warn",
      );
    }
    return;
  }

  if (uploadStatus === "failed" || uploadStatus === "rejected" || uploadStatus === "deleted" || processing === "failed" || processing === "terminated") {
    const reason = remote.status?.rejectionReason ?? remote.status?.failureReason ?? processing ?? uploadStatus;
    throw new PermanentError(`YouTube no pudo procesar el video (${reason})`);
  }

  // Still processing: poll again with backoff (1, 2, 4… up to 15 minutes).
  const delayMs = Math.min(60_000 * 2 ** checks, 15 * 60_000);
  throw new RescheduleSignal(new Date(Date.now() + delayMs), { videoId, checks: checks + 1 });
}
