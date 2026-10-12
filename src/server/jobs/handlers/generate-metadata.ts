import { logEvent } from "../../events";
import { buildMetadata } from "../../naming/metadata";
import { loadVideo, queueTransfer, setVideoStatus } from "../../videos";
import type { JobPayloads } from "../queue";

export async function generateMetadata({ videoId }: JobPayloads["generate_metadata"]): Promise<void> {
  const loaded = loadVideo(videoId);
  if (!loaded || loaded.video.status !== "discovered") return;
  const { video, workflow } = loaded;

  const metadata = await buildMetadata(video, workflow, { useAi: workflow.useAi });
  if (metadata.aiError) {
    logEvent({ videoId }, `La IA no pudo generar el título, se usó la plantilla: ${metadata.aiError}`, "warn");
  }

  setVideoStatus(videoId, workflow.mode === "auto" ? "queued" : "pending_review", {
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    titleSource: metadata.source,
    privacyStatus: workflow.privacyStatus,
    error: null,
  });
  logEvent(
    { videoId },
    `Título generado (${metadata.source === "ai" ? "IA" : "plantilla"}): ${metadata.title}${
      workflow.mode === "review" ? " — pendiente de revisión" : ""
    }`,
  );
  if (workflow.mode === "auto") queueTransfer(videoId);
}
