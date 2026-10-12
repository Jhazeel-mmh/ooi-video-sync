// Pure module: also imported by client components for the character counters.

/** YouTube limits for video metadata. */
export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5000;
export const TAGS_MAX_CHARS = 500;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** YouTube rejects `<` and `>` in titles and descriptions. */
function stripAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, "");
}

export function sanitizeTitle(title: string, fallback = "Video"): string {
  const clean = stripAngleBrackets(title).replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  const result = chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join("").trimEnd()}…` : clean;
  return result || fallback;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out.trimEnd();
}

export function sanitizeDescription(description: string): string {
  return truncateToBytes(stripAngleBrackets(description).replace(/\r\n/g, "\n").trim(), DESCRIPTION_MAX_BYTES);
}

/** A single line safe for titles of chapters and the like. */
export function sanitizeLine(text: string, maxChars = TITLE_MAX_CHARS): string {
  return Array.from(stripAngleBrackets(text).replace(/\s+/g, " ").trim()).slice(0, maxChars).join("");
}

/** Tags with spaces count their surrounding quotes; tags are joined by commas. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((sum, tag, i) => sum + Array.from(tag).length + (tag.includes(" ") ? 2 : 0) + (i > 0 ? 1 : 0), 0);
}

export function parseTags(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = stripAngleBrackets(raw).replace(/[",]/g, "").replace(/\s+/g, " ").trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    if (tagsLength([...result, tag]) > TAGS_MAX_CHARS) break;
    seen.add(key);
    result.push(tag);
  }
  return result;
}
