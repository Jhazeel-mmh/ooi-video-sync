// Pure module: also imported by the workflow form for its live summary.
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { formatBytes, formatDate } from "../lib/format";

const MB = 1024 * 1024;

/** Workflow filters as stored. All optional; a video must pass every one that is set. */
export type FilterSettings = {
  includeExisting: boolean;
  sinceDate: Date | null;
  /** Exclusive: start of the day after the chosen date. */
  untilDate: Date | null;
  minSizeBytes: number | null;
  maxSizeBytes: number | null;
  minDurationSec: number | null;
  maxDurationSec: number | null;
  nameInclude: string;
  nameExclude: string;
  skipDuplicates: boolean;
};

/** The same filters as typed in the form (empty string = not set). */
export type FilterFormValues = {
  includeExisting: boolean;
  sinceDate: string;
  untilDate: string;
  minSizeMb: string;
  maxSizeMb: string;
  minDurationMin: string;
  maxDurationMin: string;
  nameInclude: string;
  nameExclude: string;
  skipDuplicates: boolean;
};

export type FilterCandidate = { name: string; size: number; durationMs: number | null; recordedAt: Date };

/** Lowercase without accents, so "Misa" matches "misá". */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function parseWords(text: string): string[] {
  return text
    .split(",")
    .map((w) => normalizeText(w.trim()))
    .filter(Boolean);
}

export function needsDuration(filters: Pick<FilterSettings, "minDurationSec" | "maxDurationSec">): boolean {
  return filters.minDurationSec !== null || filters.maxDurationSec !== null;
}

export function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** Last included day of an exclusive `untilDate`. */
function lastDay(untilDate: Date): Date {
  return new Date(untilDate.getTime() - 1);
}

/**
 * Message for the first filter the video fails, or null when it passes.
 * The duration filter is skipped while the duration is unknown.
 */
export function filterFailure(filters: FilterSettings, video: FilterCandidate, timeZone: string): string | null {
  if (filters.sinceDate && video.recordedAt < filters.sinceDate) {
    return `Grabado antes del ${formatDate(filters.sinceDate, timeZone)}`;
  }
  if (filters.untilDate && video.recordedAt >= filters.untilDate) {
    return `Grabado después del ${formatDate(lastDay(filters.untilDate), timeZone)}`;
  }
  if (filters.minSizeBytes !== null && video.size < filters.minSizeBytes) {
    return `Pesa menos de ${formatBytes(filters.minSizeBytes)}`;
  }
  if (filters.maxSizeBytes !== null && video.size > filters.maxSizeBytes) {
    return `Pesa más de ${formatBytes(filters.maxSizeBytes)}`;
  }
  const name = normalizeText(video.name);
  const include = parseWords(filters.nameInclude);
  if (include.length > 0 && !include.some((w) => name.includes(w))) {
    return `El nombre no contiene ${include.map((w) => `«${w}»`).join(" ni ")}`;
  }
  const excluded = parseWords(filters.nameExclude).find((w) => name.includes(w));
  if (excluded) return `El nombre contiene «${excluded}»`;
  if (video.durationMs !== null) {
    if (filters.minDurationSec !== null && video.durationMs < filters.minDurationSec * 1000) {
      return `Dura menos de ${formatSeconds(filters.minDurationSec)}`;
    }
    if (filters.maxDurationSec !== null && video.durationMs > filters.maxDurationSec * 1000) {
      return `Dura más de ${formatSeconds(filters.maxDurationSec)}`;
    }
  }
  return null;
}

function range(min: string | null, max: string | null, unit?: string): string | null {
  if (min && max) return `de ${min} a ${max}${unit ?? ""}`;
  if (min) return `de ${min}${unit ?? ""} o más`;
  if (max) return `de hasta ${max}${unit ?? ""}`;
  return null;
}

/** Human summary, e.g. ["grabados desde 01/05/2026", "de 50 MB a 4 GB", "sin duplicados"]. */
export function describeFilters(filters: FilterSettings, timeZone: string): string[] {
  const parts: string[] = [];
  if (!filters.includeExisting) parts.push("solo los que lleguen después de crear el workflow");
  const since = filters.sinceDate ? formatDate(filters.sinceDate, timeZone) : null;
  const until = filters.untilDate ? formatDate(lastDay(filters.untilDate), timeZone) : null;
  if (since && until) parts.push(`grabados entre el ${since} y el ${until}`);
  else if (since) parts.push(`grabados desde el ${since}`);
  else if (until) parts.push(`grabados hasta el ${until}`);
  const size = range(
    filters.minSizeBytes !== null ? formatBytes(filters.minSizeBytes) : null,
    filters.maxSizeBytes !== null ? formatBytes(filters.maxSizeBytes) : null,
  );
  if (size) parts.push(size);
  const duration = range(
    filters.minDurationSec !== null ? formatSeconds(filters.minDurationSec) : null,
    filters.maxDurationSec !== null ? formatSeconds(filters.maxDurationSec) : null,
    " de duración",
  );
  if (duration) parts.push(duration);
  const include = parseWords(filters.nameInclude);
  if (include.length > 0) parts.push(`con ${include.map((w) => `«${w}»`).join(" o ")} en el nombre`);
  const exclude = parseWords(filters.nameExclude);
  if (exclude.length > 0) parts.push(`sin ${exclude.map((w) => `«${w}»`).join(" ni ")} en el nombre`);
  if (filters.skipDuplicates) parts.push("sin duplicados");
  return parts;
}

function parseNumber(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
}

function dayStart(date: string, timeZone: string, addDays = 0): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  return new Date(new TZDate(y, m - 1, d + addDays, 0, 0, 0, timeZone).getTime());
}

export function filtersFromForm(form: FilterFormValues, timeZone: string): FilterSettings {
  const minSize = parseNumber(form.minSizeMb);
  const maxSize = parseNumber(form.maxSizeMb);
  const minDuration = parseNumber(form.minDurationMin);
  const maxDuration = parseNumber(form.maxDurationMin);
  return {
    includeExisting: form.includeExisting,
    sinceDate: dayStart(form.sinceDate, timeZone),
    untilDate: dayStart(form.untilDate, timeZone, 1),
    minSizeBytes: minSize === null ? null : Math.round(minSize * MB),
    maxSizeBytes: maxSize === null ? null : Math.round(maxSize * MB),
    minDurationSec: minDuration === null ? null : Math.round(minDuration * 60),
    maxDurationSec: maxDuration === null ? null : Math.round(maxDuration * 60),
    nameInclude: form.nameInclude.trim(),
    nameExclude: form.nameExclude.trim(),
    skipDuplicates: form.skipDuplicates,
  };
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function filtersToForm(filters: FilterSettings, timeZone: string): FilterFormValues {
  const day = (date: Date | null) => (date ? format(new TZDate(date.getTime(), timeZone), "yyyy-MM-dd") : "");
  return {
    includeExisting: filters.includeExisting,
    sinceDate: day(filters.sinceDate),
    untilDate: day(filters.untilDate ? lastDay(filters.untilDate) : null),
    minSizeMb: filters.minSizeBytes === null ? "" : trimNumber(filters.minSizeBytes / MB),
    maxSizeMb: filters.maxSizeBytes === null ? "" : trimNumber(filters.maxSizeBytes / MB),
    minDurationMin: filters.minDurationSec === null ? "" : trimNumber(filters.minDurationSec / 60),
    maxDurationMin: filters.maxDurationSec === null ? "" : trimNumber(filters.maxDurationSec / 60),
    nameInclude: filters.nameInclude,
    nameExclude: filters.nameExclude,
    skipDuplicates: filters.skipDuplicates,
  };
}

/** Problems that make a filter combination impossible, keyed by form field. */
export function filterFormErrors(form: FilterFormValues): Partial<Record<keyof FilterFormValues, string>> {
  const errors: Partial<Record<keyof FilterFormValues, string>> = {};
  for (const key of ["minSizeMb", "maxSizeMb", "minDurationMin", "maxDurationMin"] as const) {
    const value = parseNumber(form[key]);
    if (form[key].trim() !== "" && (value === null || value < 0)) errors[key] = "Escribe un número positivo";
  }
  for (const key of ["sinceDate", "untilDate"] as const) {
    if (form[key] !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(form[key])) errors[key] = "Fecha inválida";
  }
  const pairs = [
    ["minSizeMb", "maxSizeMb", "El mínimo no puede ser mayor que el máximo"],
    ["minDurationMin", "maxDurationMin", "El mínimo no puede ser mayor que el máximo"],
  ] as const;
  for (const [min, max, message] of pairs) {
    const a = parseNumber(form[min]);
    const b = parseNumber(form[max]);
    if (a !== null && b !== null && a > b) errors[max] = message;
  }
  if (form.sinceDate && form.untilDate && form.sinceDate > form.untilDate) {
    errors.untilDate = "La fecha final no puede ser anterior a la inicial";
  }
  return errors;
}
