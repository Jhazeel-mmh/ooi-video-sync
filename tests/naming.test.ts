import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX_BYTES,
  sanitizeDescription,
  sanitizeTags,
  sanitizeTitle,
  tagsLength,
  utf8Length,
} from "@/server/naming/sanitize";
import { cleanFilename, dateFromFilename, formatDuration, renderTemplate } from "@/server/naming/template";

const TZ = "America/Mexico_City";

describe("cleanFilename", () => {
  it("removes the extension and separators", () => {
    expect(cleanFilename("misa_dominical--domingo.mp4")).toBe("misa dominical domingo");
    expect(cleanFilename(".hidden")).toBe(".hidden");
  });
});

describe("dateFromFilename", () => {
  it("reads compact dates with time", () => {
    const date = dateFromFilename("VID_20260512_101500.mp4", TZ);
    expect(date?.toISOString()).toBe("2026-05-12T16:15:00.000Z");
  });

  it("reads separated dates", () => {
    expect(dateFromFilename("Culto 2026-03-01.mov", TZ)?.toISOString()).toBe("2026-03-01T06:00:00.000Z");
  });

  it("rejects impossible dates and long digit runs", () => {
    expect(dateFromFilename("20260231.mp4", TZ)).toBeNull();
    expect(dateFromFilename("1234567890123.mp4", TZ)).toBeNull();
    expect(dateFromFilename("sin fecha.mp4", TZ)).toBeNull();
  });
});

describe("renderTemplate", () => {
  const vars = {
    originalName: "misa_especial.mp4",
    folderPath: "/Videos/Misas",
    date: new Date("2026-05-12T16:15:00Z"),
    sequence: 7,
    durationMs: 3_725_000,
  };

  it("replaces every variable", () => {
    expect(renderTemplate("{filename} #{n} — {folder} ({duration}) {original_name}", vars, TZ)).toBe(
      "misa especial #7 — Misas (1:02:05) misa_especial.mp4",
    );
  });

  it("formats dates in the configured time zone and Spanish locale", () => {
    expect(renderTemplate("{date}", vars, TZ)).toBe("12/05/2026");
    expect(renderTemplate("{date:EEEE d 'de' MMMM}", vars, TZ)).toBe("martes 12 de mayo");
  });

  it("leaves unknown or broken placeholders untouched", () => {
    expect(renderTemplate("{nope} {date:YYYY}", vars, TZ)).toBe("{nope} {date:YYYY}");
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(null)).toBe("");
  });
});

describe("sanitize", () => {
  it("limits titles to 100 characters without angle brackets", () => {
    const title = sanitizeTitle(`<b>${"á".repeat(150)}</b>`);
    expect(Array.from(title)).toHaveLength(100);
    expect(title).not.toMatch(/[<>]/);
    expect(sanitizeTitle("   ")).toBe("Video");
  });

  it("limits descriptions to 5000 UTF-8 bytes without splitting characters", () => {
    const description = sanitizeDescription("🎥".repeat(2000));
    expect(utf8Length(description)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(description).toBe("🎥".repeat(1250));
  });

  it("dedupes tags and keeps the total under 500 characters", () => {
    expect(sanitizeTags(["Misa", "misa", " dos  palabras ", "<x>", ""])).toEqual(["Misa", "dos palabras", "x"]);
    const many = sanitizeTags(Array.from({ length: 100 }, (_, i) => `etiqueta ${i}`));
    expect(tagsLength(many)).toBeLessThanOrEqual(500);
  });
});
