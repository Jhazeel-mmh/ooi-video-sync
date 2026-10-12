import { DESCRIPTION_MAX_BYTES, sanitizeLine, truncateToBytes, utf8Length } from "./sanitize";

/** YouTube only shows chapters with at least 3 entries of 10+ seconds, the first at 0:00. */
const MIN_CHAPTERS = 3;
const MIN_CHAPTER_SECONDS = 10;

export type Chapter = { start: string; title: string };
type ParsedChapter = { seconds: number; title: string };

/** "1:02:03", "02:03" or "2:03" → seconds. */
export function parseTimestamp(text: string): number | null {
  const match = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const [, h = "0", m, s] = match;
  if (Number(m) > 59 || Number(s) > 59) return null;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Seconds → "05:12" or "1:02:03", the format YouTube recognises in descriptions. */
export function formatChapterTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Cleans the chapters proposed by the AI so YouTube accepts them, or returns
 * null when there aren't enough valid ones.
 */
export function normalizeChapters(chapters: Chapter[], durationMs: number | null): ParsedChapter[] | null {
  const durationSec = durationMs ? Math.floor(durationMs / 1000) : null;
  const parsed = chapters
    .map((c) => ({ seconds: parseTimestamp(c.start), title: sanitizeLine(c.title) }))
    .filter((c): c is ParsedChapter => c.seconds !== null && c.title !== "")
    .filter((c) => durationSec === null || c.seconds < durationSec - MIN_CHAPTER_SECONDS)
    .sort((a, b) => a.seconds - b.seconds);
  if (parsed.length === 0) return null;

  // The first chapter must start at 0:00.
  if (parsed[0].seconds > 0) {
    if (parsed[0].seconds < MIN_CHAPTER_SECONDS) parsed[0].seconds = 0;
    else parsed.unshift({ seconds: 0, title: "Inicio" });
  }
  const result: ParsedChapter[] = [];
  for (const chapter of parsed) {
    const previous = result.at(-1);
    if (!previous || chapter.seconds - previous.seconds >= MIN_CHAPTER_SECONDS) result.push(chapter);
  }
  return result.length >= MIN_CHAPTERS ? result : null;
}

/**
 * Appends a chapter list to the description, keeping the whole thing within
 * YouTube's 5000 bytes (the description is shortened, not the chapters).
 */
export function appendChapters(description: string, chapters: Chapter[], durationMs: number | null): string {
  const list = normalizeChapters(chapters, durationMs);
  if (!list) return description;
  const block = ["Capítulos:", ...list.map((c) => `${formatChapterTime(c.seconds)} ${c.title}`)].join("\n");
  const room = DESCRIPTION_MAX_BYTES - utf8Length(block) - 2;
  if (room < 0) return description;
  const text = truncateToBytes(description.trim(), room);
  return text ? `${text}\n\n${block}` : block;
}
