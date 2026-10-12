import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegStatic from "ffmpeg-static";
import { env } from "../env";

export function ffmpegPath(): string | null {
  const path = env().FFMPEG_PATH ?? ffmpegStatic;
  return path && (path === "ffmpeg" || existsSync(path)) ? path : null;
}

export function isFfmpegAvailable(): boolean {
  return ffmpegPath() !== null;
}

type RunResult = { code: number | null; stderr: string };

/** Runs ffmpeg and resolves with its exit code and (truncated) stderr. */
export function runFfmpeg(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  const binary = ffmpegPath();
  if (!binary) return Promise.reject(new Error("ffmpeg no está disponible"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep the tail only: long runs print progress continuously.
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    const kill = () => child.kill("SIGKILL");
    const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
    options.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      if (options.signal?.aborted) reject(options.signal.reason ?? new Error("Cancelado"));
      else resolve({ code, stderr });
    });
  });
}

export function parseDuration(stderr: string): number | null {
  const match = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  const [, h, m, s] = match;
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
}

/**
 * Duration in milliseconds of a local file or URL. For remote MP4/MOV files
 * ffmpeg reads only the headers via range requests, not the whole video.
 */
export async function probeDuration(input: string, options: { signal?: AbortSignal } = {}): Promise<number | null> {
  // Without an output ffmpeg exits with an error, after printing the input info.
  const { stderr } = await runFfmpeg(["-i", input], { timeoutMs: 120_000, signal: options.signal });
  return parseDuration(stderr);
}
