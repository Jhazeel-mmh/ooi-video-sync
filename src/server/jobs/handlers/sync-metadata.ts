import { logEvent } from "../../events";
import { updateVideo as updateYoutubeVideo } from "../../providers/youtube";
import { loadVideo, updateVideo, youtubeMetadata } from "../../videos";
import type { JobPayloads } from "../queue";

export async function syncMetadata({ videoId }: JobPayloads["sync_metadata"]): Promise<void> {
  const loaded = loadVideo(videoId);
  if (!loaded?.video.youtubeVideoId) return;
  const { video, workflow } = loaded;

  await updateYoutubeVideo(workflow.youtubeAccountId, video.youtubeVideoId!, youtubeMetadata(video, workflow));
  updateVideo(videoId, { error: null });
  logEvent({ videoId }, "Título y descripción actualizados en YouTube");
}
