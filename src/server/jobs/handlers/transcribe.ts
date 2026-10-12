import { ensureTranscript } from "../../naming/transcript";
import { loadVideo } from "../../videos";
import type { JobPayloads } from "../queue";
import type { JobContext } from "../runner";

/** Transcribes on demand (from the video page) without changing the video's status. */
export async function transcribeVideoJob({ videoId }: JobPayloads["transcribe_video"], ctx: JobContext): Promise<void> {
  const loaded = loadVideo(videoId);
  if (!loaded) return;
  await ensureTranscript(loaded.video, loaded.workflow, ctx.signal, { force: true });
}
