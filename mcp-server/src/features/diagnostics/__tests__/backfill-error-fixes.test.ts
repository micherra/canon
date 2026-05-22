/**
 * Tests for the backfill-error-fixes service.
 *
 * Each test creates an in-memory drift.db, seeds data via DriftDbSignals,
 * and calls backfillErrorFixes to verify the output shape and idempotency.
 *
 * Test plan:
 * - Empty database: returns { processed: 0, inserted: 0, skipped: 0 }
 * - Single violation history row → creates one error_fix entry
 * - Multiple rows for the same file+principle → processed once, inserted once
 * - Multiple distinct file+principle pairs → each is inserted
 * - Idempotency: calling backfill twice returns skipped on second run
 * - error_pattern includes principle_id and violation count
 * - fix_pattern describes resolution
 * - getAllFileViolationHistory returns empty array for empty database
 * - getAllFileViolationHistory returns all rows across multiple files
 */

import { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { describe, expect, test } from "vitest";
import { backfillErrorFixes } from "../services/backfill-error-fixes.ts";

// ---- Setup helpers ----

function makeSignalsDb(): {
  db: ReturnType<typeof initDriftDb>;
  signals: DriftDbSignals;
} {
  const db = initDriftDb(":memory:");
  const signals = new DriftDbSignals(db);
  return { db, signals };
}

// ---- getAllFileViolationHistory (via DriftDbSignals) ----

describe("DriftDbSignals.getAllFileViolationHistory", () => {
  test("returns empty array for an empty database", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getAllFileViolationHistory();
    expect(result).toEqual([]);
    db.close();
  });

  test("returns all rows across multiple files", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });
    signals.upsertFileViolation({
      file_path: "src/bar.ts",
      first_seen: "2026-05-02T00:00:00.000Z",
      last_seen: "2026-05-02T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 1,
    });

    const result = signals.getAllFileViolationHistory();
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.file_path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
    db.close();
  });

  test("returns rows for single file with multiple principles", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 5,
    });

    const result = signals.getAllFileViolationHistory();
    expect(result).toHaveLength(2);
    const principles = result.map((r) => r.principle_id);
    expect(principles).toContain("simplicity-first");
    expect(principles).toContain("deep-modules");
    db.close();
  });
});

// ---- backfillErrorFixes — empty database ----

describe("backfillErrorFixes — empty database", () => {
  test("returns { processed: 0, inserted: 0, skipped: 0 } for empty database", () => {
    const { signals, db } = makeSignalsDb();
    const result = backfillErrorFixes(signals);
    expect(result).toEqual({ inserted: 0, processed: 0, skipped: 0 });
    db.close();
  });
});

// ---- backfillErrorFixes — single row ----

describe("backfillErrorFixes — single violation history row", () => {
  test("returns { processed: 1, inserted: 1, skipped: 0 } for one row", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    const result = backfillErrorFixes(signals);
    expect(result).toEqual({ inserted: 1, processed: 1, skipped: 0 });
    db.close();
  });

  test("inserts an error_fix entry for the file+principle pair", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    backfillErrorFixes(signals);

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      file_path: "src/foo.ts",
      principle_id: "simplicity-first",
    });
    db.close();
  });

  test("error_pattern includes principle_id and violation count", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    backfillErrorFixes(signals);

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes[0].error_pattern).toContain("simplicity-first");
    expect(fixes[0].error_pattern).toContain("3");
    db.close();
  });

  test("fix_pattern describes resolution", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    backfillErrorFixes(signals);

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes[0].fix_pattern).toContain("3");
    expect(fixes[0].fix_pattern.toLowerCase()).toContain("resolv");
    db.close();
  });

  test("occurrences matches violation_count", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 7,
    });

    backfillErrorFixes(signals);

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes[0].occurrences).toBe(7);
    db.close();
  });

  test("last_seen and first_seen are copied from violation history", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });

    backfillErrorFixes(signals);

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes[0].last_seen).toBe("2026-05-01T00:00:00.000Z");
    expect(fixes[0].first_seen).toBe("2026-04-01T00:00:00.000Z");
    db.close();
  });
});

// ---- backfillErrorFixes — multiple rows ----

describe("backfillErrorFixes — multiple distinct rows", () => {
  test("processes each file+principle pair independently", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });
    signals.upsertFileViolation({
      file_path: "src/bar.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-05-02T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 4,
    });

    const result = backfillErrorFixes(signals);
    expect(result).toEqual({ inserted: 2, processed: 2, skipped: 0 });
    db.close();
  });

  test("inserts error_fix for each distinct pair", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });
    signals.upsertFileViolation({
      file_path: "src/bar.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-05-02T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 4,
    });

    backfillErrorFixes(signals);

    const fooFixes = signals.getErrorFixes(["src/foo.ts"]);
    const barFixes = signals.getErrorFixes(["src/bar.ts"]);
    expect(fooFixes).toHaveLength(1);
    expect(barFixes).toHaveLength(1);
    db.close();
  });

  test("handles single file with multiple principle violations", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 5,
    });

    const result = backfillErrorFixes(signals);
    expect(result).toEqual({ inserted: 2, processed: 2, skipped: 0 });

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes).toHaveLength(2);
    db.close();
  });
});

// ---- backfillErrorFixes — idempotency ----

describe("backfillErrorFixes — idempotency", () => {
  test("second call on same data returns all skipped (INSERT OR UPDATE is idempotent)", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    const first = backfillErrorFixes(signals);
    expect(first).toEqual({ inserted: 1, processed: 1, skipped: 0 });

    const second = backfillErrorFixes(signals);
    // processed = 1 (row still present), inserted = 0, skipped = 1
    expect(second.processed).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    db.close();
  });

  test("running backfill twice does not duplicate records", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    backfillErrorFixes(signals);
    backfillErrorFixes(signals);

    const fixes = signals.getErrorFixes(["src/foo.ts"]);
    expect(fixes).toHaveLength(1);
    db.close();
  });

  test("backfill is safe to call multiple times on empty database", () => {
    const { signals, db } = makeSignalsDb();
    expect(() => backfillErrorFixes(signals)).not.toThrow();
    expect(() => backfillErrorFixes(signals)).not.toThrow();
    db.close();
  });
});
