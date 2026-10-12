// Pure module: also imported by client components for the live preview.
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";

export type TemplateVars = {
  /** Exact file name, e.g. `VID_20260512_101500.mp4`. */
  originalName: string;
  /** Folder path inside the drive, e.g. `/Videos/Misas`. */
  folderPath: string;
  /** Best guess of the recording date. */
  date: Date;
  /** Per-workflow counter. */
  sequence: number;
  durationMs?: number | null;
};

export const TEMPLATE_VARIABLES = [
  { token: "{filename}", description: "Nombre del archivo sin extensión; _ y - se vuelven espacios" },
  { token: "{original_name}", description: "Nombre exacto del archivo" },
  { token: "{date}", description: "Fecha de grabación (dd/MM/yyyy)" },
  { token: "{date:d 'de' MMMM yyyy}", description: "Fecha con formato propio (sintaxis de date-fns)" },
  { token: "{folder}", description: "Nombre de la carpeta" },
  { token: "{n}", description: "Número consecutivo del workflow" },
  { token: "{duration}", description: "Duración (h:mm:ss)" },
] as const;

const DEFAULT_DATE_FORMAT = "dd/MM/yyyy";

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** `misa_dominical-2026.05.12.mp4` → `misa dominical 2026.05.12`. */
export function cleanFilename(name: string): string {
  return stripExtension(name)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds a date like `20260512`, `2026-05-12` or `2026_05_12` (optionally
 * followed by a time such as `_101500`) in the file name, interpreted in `timeZone`.
 */
export function dateFromFilename(name: string, timeZone: string): Date | null {
  const match = /(?<!\d)((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T-]?(\d{2})[-_.:h]?(\d{2})(?:[-_.:m]?(\d{2}))?)?(?!\d)/.exec(
    name,
  );
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const parts = [y, mo, d, h, mi, s].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new TZDate(year, month - 1, day, hour, minute, second, timeZone);
  // Reject overflowed dates such as Feb 31.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return new Date(date.getTime());
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

/** Replaces `{variable}` / `{variable:format}` placeholders; unknown ones are left as typed. */
export function renderTemplate(template: string, vars: TemplateVars, timeZone: string): string {
  return template.replace(/\{(\w+)(?::([^{}]*))?\}/g, (whole, name: string, arg: string | undefined) => {
    switch (name) {
      case "filename":
        return cleanFilename(vars.originalName);
      case "original_name":
        return vars.originalName;
      case "folder":
        return lastSegment(vars.folderPath);
      case "n":
        return String(vars.sequence);
      case "duration":
        return formatDuration(vars.durationMs);
      case "date":
        try {
          return format(new TZDate(vars.date.getTime(), timeZone), arg || DEFAULT_DATE_FORMAT, { locale: es });
        } catch {
          return whole;
        }
      default:
        return whole;
    }
  });
}
