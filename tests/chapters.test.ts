import { describe, expect, it } from "vitest";
import { appendChapters, formatChapterTime, normalizeChapters, parseTimestamp } from "@/server/naming/chapters";
import { DESCRIPTION_MAX_BYTES, utf8Length } from "@/server/naming/sanitize";
import { shiftTimestamps } from "@/server/naming/transcript";

describe("timestamps", () => {
  it("parses and formats chapter times", () => {
    expect(parseTimestamp("0:05:12")).toBe(312);
    expect(parseTimestamp("05:12")).toBe(312);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("5:99")).toBeNull();
    expect(formatChapterTime(312)).toBe("05:12");
    expect(formatChapterTime(3723)).toBe("1:02:03");
  });

  it("shifts transcript marks by the chunk offset", () => {
    expect(shiftTimestamps("[00:05] Hola\n[12:30] Tema dos\n[1:00:01] Fin", 1800)).toBe(
      "[0:30:05] Hola\n[0:42:30] Tema dos\n[1:30:01] Fin",
    );
  });
});

describe("normalizeChapters", () => {
  const ch = (start: string, title: string) => ({ start, title });

  it("starts at 0:00, sorts, and drops chapters that are too close or past the end", () => {
    const result = normalizeChapters(
      [ch("0:20:00", "Homilía"), ch("0:00:04", "Bienvenida"), ch("0:20:05", "Repetido"), ch("0:45:00", "Ofertorio"), ch("1:59:55", "Fuera")],
      2 * 3600 * 1000,
    );
    expect(result).toEqual([
      { seconds: 0, title: "Bienvenida" },
      { seconds: 1200, title: "Homilía" },
      { seconds: 2700, title: "Ofertorio" },
    ]);
  });

  it("adds an 'Inicio' chapter when the first one starts later", () => {
    expect(normalizeChapters([ch("0:01:00", "A"), ch("0:02:00", "B")], null)?.[0]).toEqual({ seconds: 0, title: "Inicio" });
  });

  it("returns null with fewer than three valid chapters", () => {
    expect(normalizeChapters([ch("0:00:00", "A"), ch("nope", "B"), ch("0:01:00", " ")], null)).toBeNull();
  });
});

describe("appendChapters", () => {
  const chapters = [
    { start: "0:00:00", title: "Inicio" },
    { start: "0:10:00", title: "Lecturas <1>" },
    { start: "0:30:00", title: "Homilía" },
  ];

  it("adds the list after the description in YouTube's format", () => {
    expect(appendChapters("Misa del domingo.", chapters, null)).toBe(
      "Misa del domingo.\n\nCapítulos:\n00:00 Inicio\n10:00 Lecturas 1\n30:00 Homilía",
    );
  });

  it("shortens the description, not the chapters, to stay within 5000 bytes", () => {
    const result = appendChapters("ñ".repeat(4000), chapters, null);
    expect(utf8Length(result)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(result.endsWith("30:00 Homilía")).toBe(true);
  });

  it("leaves the description alone when the chapters aren't usable", () => {
    expect(appendChapters("Hola", chapters.slice(0, 2), null)).toBe("Hola");
  });
});
