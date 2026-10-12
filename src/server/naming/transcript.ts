import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Video, Workflow } from "../db/schema";
import { env } from "../env";
import { logEvent } from "../events";
import { cutAudio, extractAudio, isFfmpegAvailable, probeDuration } from "../media/ffmpeg";
import { getDownloadUrl } from "../providers/onedrive";
import { getSettings } from "../settings";
import { updateVideo } from "../videos";
import { transcribeAudio } from "./ai/gemini";

/** 30 minutes ≈ 58k audio tokens and ~5 MB of Opus: fits free-tier limits and inline requests. */
const CHUNK_SECONDS = 30 * 60;

/** Transcription always uses Gemini (Claude doesn't take audio) plus ffmpeg. */
export function transcriptionUnavailableReason(): string | null {
  if (!env().GEMINI_API_KEY) return "Falta GEMINI_API_KEY (la transcripción siempre usa Gemini).";
  if (!isFfmpegAvailable()) return "ffmpeg no está disponible.";
  return null;
}

export function isTranscriptionAvailable(): boolean {
  return transcriptionUnavailableReason() === null;
}

function formatMark(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `[${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
}

/** Rewrites `[mm:ss]` / `[h:mm:ss]` marks of one chunk as `[h:mm:ss]` from the start of the video. */
export function shiftTimestamps(text: string, offsetSeconds: number): string {
  return text.replace(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g, (_mark, h: string | undefined, m: string, s: string) =>
    formatMark(Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + offsetSeconds),
  );
}

/** Extracts the audio (streamed from OneDrive), splits it and transcribes each part with Gemini. */
export async function transcribeVideo(
  video: Video,
  workflow: Workflow,
  signal: AbortSignal,
  { chunkSeconds = CHUNK_SECONDS } = {},
): Promise<string> {
  const unavailable = transcriptionUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  const settings = getSettings();
  const dir = path.join(path.resolve(env().DATA_DIR), "tmp", `audio-${video.id}`);
  await mkdir(dir, { recursive: true });
  try {
    const audio = path.join(dir, "audio.ogg");
    const url = await getDownloadUrl(workflow.onedriveAccountId, video.driveId, video.itemId, signal);
    await extractAudio(url, audio, { maxSeconds: settings.transcriptMaxMinutes * 60 || undefined, signal });
    const totalSeconds = Math.ceil(((await probeDuration(audio)) ?? 0) / 1000);

    const parts: string[] = [];
    for (let start = 0; start === 0 || start < totalSeconds; start += chunkSeconds) {
      signal.throwIfAborted();
      let chunk = audio;
      if (totalSeconds > chunkSeconds) {
        chunk = path.join(dir, `part-${start}.ogg`);
        await cutAudio(audio, chunk, start, chunkSeconds);
      }
      const text = (await transcribeAudio(chunk, settings.geminiModel)).trim();
      if (text && text !== "[sin habla]") parts.push(shiftTimestamps(text, start));
    }
    return parts.join("\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Transcribes once and stores it on the video; returns the existing one unless `force`. */
export async function ensureTranscript(
  video: Video,
  workflow: Workflow,
  signal: AbortSignal,
  options: { force?: boolean } = {},
): Promise<string> {
  if (video.transcript !== null && !options.force) return video.transcript;
  logEvent({ videoId: video.id }, "Transcribiendo el audio con Gemini");
  const transcript = await transcribeVideo(video, workflow, signal);
  updateVideo(video.id, { transcript });
  const words = transcript.split(/\s+/).filter(Boolean).length;
  logEvent({ videoId: video.id }, transcript ? `Transcripción lista (${words} palabras)` : "El audio no tiene habla para transcribir");
  return transcript;
}
