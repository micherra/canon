/**
 * Tests for the Pitfall Enrichment service.
 *
 * Each test creates an in-memory drift.db, seeds data via DriftDbSignals,
 * and calls the pitfall enrichment functions to verify output shape,
 * filtering, sorting, and markdown formatting.
 *
 * Test plan:
 * queryDriftSignalPitfalls:
 * - empty filePaths returns []
 * - returns [] when no qualifying rows (violation_count < 2 filtered)
 * - filters out rows with violation_count < 2
 * - includes rows with violation_count >= 2
 * - sorts by violation_count DESC
 * - tie-breaks by file_path ASC
 * - caps output at 5 entries
 * - maps row fields to DriftPitfall shape
 *
 * queryErrorFixPitfalls:
 * - empty filePaths returns []
 * - returns [] when no rows exist
 * - sorts by occurrences DESC
 * - tie-breaks by file_path ASC
 * - caps output at 5 entries
 * - maps row fields to ErrorFixPitfall shape
 *
 * formatPitfallsSection:
 * - empty arrays return empty string
 * - only drift pitfalls renders drift section only
 * - only error fix pitfalls renders error section only
 * - both present renders both sections
 * - output contains correct header and intro line
 * - output contains correct drift bullet format
 * - output contains correct error fix bullet format
 */

import { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DriftPitfall,
  type ErrorFixPitfall,
  formatPitfallsSection,
  queryDriftSignalPitfalls,
  queryErrorFixPitfalls,
} from "../services/pitfall-enrichment.ts";

// ---- Setup helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; signals: DriftDbSignals } {
  const db = initDriftDb(":memory:");
  const signals = new DriftDbSignals(db);
  return { db, signals };
}

function seedViolation(
  signals: DriftDbSignals,
  overrides: {
    file_path?: string;
    principle_id?: string;
    violation_count?: number;
    last_seen?: string;
    first_seen?: string;
  } = {},
): void {
  signals.upsertFileViolation({
    file_path: "src/foo.ts",
    first_seen: "2026-04-01T00:00:00.000Z",
    last_seen: "2026-05-01T00:00:00.000Z",
    principle_id: "simplicity-first",
    violation_count: 3,
    ...overrides,
  });
}

function seedErrorFix(
  signals: DriftDbSignals,
  overrides: {
    file_path?: string;
    principle_id?: string;
    error_pattern?: string;
    fix_pattern?: string;
    occurrences?: number;
    last_seen?: string;
    first_seen?: string;
  } = {},
): void {
  signals.upsertErrorFix({
    error_pattern: "Used try/catch for control flow",
    file_path: "src/foo.ts",
    first_seen: "2026-04-01T00:00:00.000Z",
    fix_pattern: "Return Result type instead",
    last_seen: "2026-05-01T00:00:00.000Z",
    occurrences: 2,
    principle_id: "simplicity-first",
    ...overrides,
  });
}

// ---- queryDriftSignalPitfalls ----

describe("queryDriftSignalPitfalls", () => {
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ signals } = makeDb());
  });

  it("returns empty array for empty filePaths", () => {
    const result = queryDriftSignalPitfalls([], signals);
    expect(result).toEqual([]);
  });

  it("returns empty array when no rows exist", () => {
    const result = queryDriftSignalPitfalls(["src/foo.ts"], signals);
    expect(result).toEqual([]);
  });

  it("filters out rows with violation_count < 2", () => {
    seedViolation(signals, { violation_count: 1 });
    const result = queryDriftSignalPitfalls(["src/foo.ts"], signals);
    expect(result).toEqual([]);
  });

  it("includes rows with violation_count === 2 (boundary)", () => {
    seedViolation(signals, { violation_count: 2 });
    const result = queryDriftSignalPitfalls(["src/foo.ts"], signals);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation_count).toBe(2);
  });

  it("includes rows with violation_count > 2", () => {
    seedViolation(signals, { violation_count: 5 });
    const result = queryDriftSignalPitfalls(["src/foo.ts"], signals);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation_count).toBe(5);
  });

  it("sorts by violation_count DESC", () => {
    seedViolation(signals, { file_path: "src/a.ts", principle_id: "p1", violation_count: 3 });
    seedViolation(signals, { file_path: "src/b.ts", principle_id: "p2", violation_count: 7 });
    seedViolation(signals, { file_path: "src/c.ts", principle_id: "p3", violation_count: 5 });

    const result = queryDriftSignalPitfalls(["src/a.ts", "src/b.ts", "src/c.ts"], signals);

    expect(result[0]!.violation_count).toBe(7);
    expect(result[1]!.violation_count).toBe(5);
    expect(result[2]!.violation_count).toBe(3);
  });

  it("tie-breaks by file_path ASC", () => {
    seedViolation(signals, { file_path: "src/z.ts", principle_id: "p1", violation_count: 4 });
    seedViolation(signals, { file_path: "src/a.ts", principle_id: "p2", violation_count: 4 });

    const result = queryDriftSignalPitfalls(["src/z.ts", "src/a.ts"], signals);

    expect(result[0]!.file_path).toBe("src/a.ts");
    expect(result[1]!.file_path).toBe("src/z.ts");
  });

  it("caps output at 5 entries", () => {
    // Seed 7 qualifying rows across different files/principles
    const files = [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g.ts",
    ];
    for (let i = 0; i < files.length; i++) {
      seedViolation(signals, {
        file_path: files[i],
        principle_id: `p${i}`,
        violation_count: 3 + i,
      });
    }

    const result = queryDriftSignalPitfalls(files, signals);
    expect(result).toHaveLength(5);
  });

  it("maps row fields to DriftPitfall shape", () => {
    seedViolation(signals, {
      file_path: "src/bar.ts",
      last_seen: "2026-05-10T12:00:00.000Z",
      principle_id: "errors-are-values",
      violation_count: 4,
    });

    const result = queryDriftSignalPitfalls(["src/bar.ts"], signals);

    expect(result[0]).toEqual({
      file_path: "src/bar.ts",
      last_seen: "2026-05-10T12:00:00.000Z",
      principle_id: "errors-are-values",
      violation_count: 4,
    } satisfies DriftPitfall);
  });
});

// ---- queryErrorFixPitfalls ----

describe("queryErrorFixPitfalls", () => {
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ signals } = makeDb());
  });

  it("returns empty array for empty filePaths", () => {
    const result = queryErrorFixPitfalls([], signals);
    expect(result).toEqual([]);
  });

  it("returns empty array when no rows exist", () => {
    const result = queryErrorFixPitfalls(["src/foo.ts"], signals);
    expect(result).toEqual([]);
  });

  it("sorts by occurrences DESC", () => {
    seedErrorFix(signals, { file_path: "src/a.ts", occurrences: 2, principle_id: "p1" });
    seedErrorFix(signals, { file_path: "src/b.ts", occurrences: 8, principle_id: "p2" });
    seedErrorFix(signals, { file_path: "src/c.ts", occurrences: 5, principle_id: "p3" });

    const result = queryErrorFixPitfalls(["src/a.ts", "src/b.ts", "src/c.ts"], signals);

    expect(result[0]!.occurrences).toBe(8);
    expect(result[1]!.occurrences).toBe(5);
    expect(result[2]!.occurrences).toBe(2);
  });

  it("tie-breaks by file_path ASC", () => {
    seedErrorFix(signals, { file_path: "src/z.ts", occurrences: 3, principle_id: "p1" });
    seedErrorFix(signals, { file_path: "src/a.ts", occurrences: 3, principle_id: "p2" });

    const result = queryErrorFixPitfalls(["src/z.ts", "src/a.ts"], signals);

    expect(result[0]!.file_path).toBe("src/a.ts");
    expect(result[1]!.file_path).toBe("src/z.ts");
  });

  it("caps output at 5 entries", () => {
    const files = [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g.ts",
    ];
    for (let i = 0; i < files.length; i++) {
      seedErrorFix(signals, {
        file_path: files[i],
        occurrences: 2 + i,
        principle_id: `p${i}`,
      });
    }

    const result = queryErrorFixPitfalls(files, signals);
    expect(result).toHaveLength(5);
  });

  it("maps row fields to ErrorFixPitfall shape", () => {
    seedErrorFix(signals, {
      error_pattern: "Threw exception for expected case",
      file_path: "src/bar.ts",
      fix_pattern: "Return Result<T, E> instead",
      occurrences: 6,
      principle_id: "errors-are-values",
    });

    const result = queryErrorFixPitfalls(["src/bar.ts"], signals);

    expect(result[0]).toEqual({
      error_pattern: "Threw exception for expected case",
      file_path: "src/bar.ts",
      fix_pattern: "Return Result<T, E> instead",
      occurrences: 6,
      principle_id: "errors-are-values",
    } satisfies ErrorFixPitfall);
  });
});

// ---- formatPitfallsSection ----

describe("formatPitfallsSection", () => {
  const driftPitfall: DriftPitfall = {
    file_path: "src/foo.ts",
    last_seen: "2026-05-01T00:00:00.000Z",
    principle_id: "simplicity-first",
    violation_count: 3,
  };

  const errorFixPitfall: ErrorFixPitfall = {
    error_pattern: "Used try/catch for control flow",
    file_path: "src/bar.ts",
    fix_pattern: "Return Result type instead",
    occurrences: 4,
    principle_id: "errors-are-values",
  };

  it("returns empty string when both arrays are empty", () => {
    const result = formatPitfallsSection([], []);
    expect(result).toBe("");
  });

  it("renders only drift section when errorFix array is empty", () => {
    const result = formatPitfallsSection([driftPitfall], []);
    expect(result).toContain("## Known Pitfalls");
    expect(result).toContain("### Drift Signals (violation history)");
    expect(result).not.toContain("### Prior Error→Fix Pairs");
  });

  it("renders only error-fix section when drift array is empty", () => {
    const result = formatPitfallsSection([], [errorFixPitfall]);
    expect(result).toContain("## Known Pitfalls");
    expect(result).toContain("### Prior Error→Fix Pairs");
    expect(result).not.toContain("### Drift Signals (violation history)");
  });

  it("renders both sections when both arrays are non-empty", () => {
    const result = formatPitfallsSection([driftPitfall], [errorFixPitfall]);
    expect(result).toContain("### Drift Signals (violation history)");
    expect(result).toContain("### Prior Error→Fix Pairs");
  });

  it("includes header and intro line", () => {
    const result = formatPitfallsSection([driftPitfall], []);
    expect(result).toContain("## Known Pitfalls");
    expect(result).toContain(
      "The following area-specific pitfalls have been observed in prior builds. Avoid these patterns:",
    );
  });

  it("formats drift bullet with correct file_path, principle_id, count, and date", () => {
    const result = formatPitfallsSection([driftPitfall], []);
    expect(result).toContain(
      "- **src/foo.ts** — Principle `simplicity-first` violated 3 times (last: 2026-05-01T00:00:00.000Z)",
    );
  });

  it("formats error-fix bullet with correct file_path, error_pattern, fix_pattern, and occurrences", () => {
    const result = formatPitfallsSection([], [errorFixPitfall]);
    expect(result).toContain(
      "- **src/bar.ts** — Used try/catch for control flow. Fix: Return Result type instead (seen 4 times)",
    );
  });

  it("renders multiple drift pitfalls as multiple bullet lines", () => {
    const second: DriftPitfall = {
      file_path: "src/baz.ts",
      last_seen: "2026-04-01T00:00:00.000Z",
      principle_id: "errors-are-values",
      violation_count: 5,
    };
    const result = formatPitfallsSection([driftPitfall, second], []);
    const lines = result.split("\n").filter((l) => l.startsWith("- **"));
    expect(lines).toHaveLength(2);
  });

  it("renders multiple error-fix pitfalls as multiple bullet lines", () => {
    const second: ErrorFixPitfall = {
      error_pattern: "Imported across feature boundary",
      file_path: "src/baz.ts",
      fix_pattern: "Use domain types instead",
      occurrences: 2,
      principle_id: "bounded-context",
    };
    const result = formatPitfallsSection([], [errorFixPitfall, second]);
    const lines = result.split("\n").filter((l) => l.startsWith("- **"));
    expect(lines).toHaveLength(2);
  });
});
