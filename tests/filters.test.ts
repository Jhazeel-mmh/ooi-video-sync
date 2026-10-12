import { describe, expect, it } from "vitest";
import {
  describeFilters,
  filterFailure,
  filterFormErrors,
  filtersFromForm,
  filtersToForm,
  type FilterFormValues,
  type FilterSettings,
} from "@/server/filters";

const TZ = "America/Mexico_City";
const MB = 1024 * 1024;

const none: FilterSettings = {
  includeExisting: true,
  sinceDate: null,
  untilDate: null,
  minSizeBytes: null,
  maxSizeBytes: null,
  minDurationSec: null,
  maxDurationSec: null,
  nameInclude: "",
  nameExclude: "",
  skipDuplicates: false,
};

const video = {
  name: "Misa Dominical 2026-05-10.mp4",
  size: 500 * MB,
  durationMs: 75 * 60_000,
  recordedAt: new Date("2026-05-10T15:00:00Z"),
};

const form = (values: Partial<FilterFormValues>): FilterFormValues => ({
  includeExisting: true,
  sinceDate: "",
  untilDate: "",
  minSizeMb: "",
  maxSizeMb: "",
  minDurationMin: "",
  maxDurationMin: "",
  nameInclude: "",
  nameExclude: "",
  skipDuplicates: false,
  ...values,
});

describe("filterFailure", () => {
  it("passes everything when no filter is set", () => {
    expect(filterFailure(none, video, TZ)).toBeNull();
  });

  it("checks each filter", () => {
    const f = (values: Partial<FilterFormValues>) => filterFailure(filtersFromForm(form(values), TZ), video, TZ);
    expect(f({ sinceDate: "2026-05-11" })).toBe("Grabado antes del 11/05/2026");
    expect(f({ untilDate: "2026-05-09" })).toBe("Grabado después del 09/05/2026");
    expect(f({ untilDate: "2026-05-10" })).toBeNull(); // "hasta" includes the whole day
    expect(f({ minSizeMb: "600" })).toBe("Pesa menos de 600 MB");
    expect(f({ maxSizeMb: "0,4" })).toMatch(/^Pesa más de/);
    expect(f({ minDurationMin: "90" })).toBe("Dura menos de 1 h 30 min");
    expect(f({ maxDurationMin: "60" })).toBe("Dura más de 1 h");
    expect(f({ nameInclude: "culto, vigilia" })).toBe("El nombre no contiene «culto» ni «vigilia»");
    expect(f({ nameInclude: "culto, DOMÍNICAL" })).toBeNull(); // case and accents don't matter
    expect(f({ nameExclude: "prueba, misa" })).toBe("El nombre contiene «misa»");
  });

  it("requires every filter to pass", () => {
    const filters = filtersFromForm(form({ sinceDate: "2026-05-01", minSizeMb: "100", maxDurationMin: "60" }), TZ);
    expect(filterFailure(filters, video, TZ)).toBe("Dura más de 1 h");
    expect(filterFailure(filters, { ...video, durationMs: 59 * 60_000 }, TZ)).toBeNull();
  });

  it("skips the duration filter while the duration is unknown", () => {
    const filters = filtersFromForm(form({ minDurationMin: "90" }), TZ);
    expect(filterFailure(filters, { ...video, durationMs: null }, TZ)).toBeNull();
  });
});

describe("form conversion", () => {
  it("round-trips through the stored values", () => {
    const values = form({
      includeExisting: false,
      sinceDate: "2026-05-01",
      untilDate: "2026-06-30",
      minSizeMb: "50",
      maxSizeMb: "4096",
      minDurationMin: "1.5",
      maxDurationMin: "120",
      nameInclude: "misa",
      skipDuplicates: true,
    });
    const stored = filtersFromForm(values, TZ);
    expect(stored.untilDate?.toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(stored.minDurationSec).toBe(90);
    expect(filtersToForm(stored, TZ)).toEqual(values);
  });

  it("reports impossible combinations", () => {
    expect(
      filterFormErrors(form({ minSizeMb: "10", maxSizeMb: "5", sinceDate: "2026-06-01", untilDate: "2026-05-01", minDurationMin: "-1" })),
    ).toEqual({
      maxSizeMb: "El mínimo no puede ser mayor que el máximo",
      untilDate: "La fecha final no puede ser anterior a la inicial",
      minDurationMin: "Escribe un número positivo",
    });
    expect(filterFormErrors(form({ minSizeMb: "5", maxSizeMb: "10" }))).toEqual({});
  });

  it("summarizes the filters", () => {
    const filters = filtersFromForm(
      form({ includeExisting: false, sinceDate: "2026-05-01", minSizeMb: "50", maxDurationMin: "120", nameExclude: "prueba", skipDuplicates: true }),
      TZ,
    );
    expect(describeFilters(filters, TZ)).toEqual([
      "solo los que lleguen después de crear el workflow",
      "grabados desde el 01/05/2026",
      "de 50 MB o más",
      "de hasta 2 h de duración",
      "sin «prueba» en el nombre",
      "sin duplicados",
    ]);
  });
});
