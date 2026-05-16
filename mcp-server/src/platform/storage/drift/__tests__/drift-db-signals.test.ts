/**
 * DriftDbSignals Tests — DAO for file_violation_history and path_effects tables
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each test gets a fresh DB via initDriftDb(':memory:') which runs all migrations
 * including v4 (file_violation_history, path_effects).
 */

import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { DriftDb } from "../drift-db.ts";
import { DriftDbSignals } from "../drift-db-signals.ts";
import { initDriftDb } from "../drift-schema.ts";

// ---- Setup helpers ----

function makeSignalsDb(): { db: Database.Database; signals: DriftDbSignals } {
  const db = initDriftDb(":memory:");
  const signals = new DriftDbSignals(db);
  return { db, signals };
}

// ---- getFileViolationHistory ----

describe("DriftDbSignals.getFileViolationHistory", () => {
  test("returns empty array for empty input", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getFileViolationHistory([]);
    expect(result).toEqual([]);
    db.close();
  });

  test("returns empty array when no data exists for the path", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getFileViolationHistory(["src/nonexistent.ts"]);
    expect(result).toEqual([]);
    db.close();
  });

  test("inserts and retrieves a violation record", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 3,
    });

    const result = signals.getFileViolationHistory(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 3,
    });
    db.close();
  });

  test("updates existing record on duplicate (file_path, principle_id)", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-04-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 1,
    });
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 5,
    });

    const result = signals.getFileViolationHistory(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].violation_count).toBe(5);
    expect(result[0].last_seen).toBe("2026-05-01T00:00:00.000Z");
    db.close();
  });

  test("preserves first_seen on upsert — only updates violation_count and last_seen", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      last_seen: "2026-04-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 1,
    });
    // second upsert provides a different first_seen — should be ignored by DO UPDATE SET
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2099-01-01T00:00:00.000Z", // should NOT overwrite
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 2,
    });

    const result = signals.getFileViolationHistory(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].first_seen).toBe("2026-03-01T00:00:00.000Z");
    expect(result[0].violation_count).toBe(2);
    expect(result[0].last_seen).toBe("2026-05-01T00:00:00.000Z");
    db.close();
  });

  test("returns results for multiple file paths", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 1,
    });
    signals.upsertFileViolation({
      file_path: "src/bar.ts",
      first_seen: "2026-04-02T00:00:00.000Z",
      last_seen: "2026-05-02T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });

    const result = signals.getFileViolationHistory(["src/foo.ts", "src/bar.ts"]);
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.file_path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
    db.close();
  });
});

// ---- markFixed ----

describe("DriftDbSignals.markFixed", () => {
  test("removes the record — getFileViolationHistory no longer returns it", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 3,
    });

    signals.markFixed("src/foo.ts", "deep-modules");
    const result = signals.getFileViolationHistory(["src/foo.ts"]);
    expect(result).toHaveLength(0);
    db.close();
  });

  test("is a no-op for non-existent records — does not throw", () => {
    const { signals, db } = makeSignalsDb();
    expect(() => {
      signals.markFixed("src/nonexistent.ts", "deep-modules");
    }).not.toThrow();
    db.close();
  });

  test("only removes the matching (file_path, principle_id) pair", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "deep-modules",
      violation_count: 1,
    });
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      last_seen: "2026-05-01T00:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 2,
    });

    signals.markFixed("src/foo.ts", "deep-modules");
    const result = signals.getFileViolationHistory(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("simplicity-first");
    db.close();
  });
});

// ---- getPathEffects ----

describe("DriftDbSignals.getPathEffects", () => {
  test("returns empty array for empty input", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getPathEffects([]);
    expect(result).toEqual([]);
    db.close();
  });

  test("returns empty array when no data exists for the path", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getPathEffects(["src/nonexistent.ts"]);
    expect(result).toEqual([]);
    db.close();
  });

  test("inserts and retrieves a path effect record", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertPathEffect({
      clean_streak: 0,
      file_path: "src/foo.ts",
      last_clean_at: "2026-04-15T00:00:00.000Z",
      last_violation_at: "2026-05-01T00:00:00.000Z",
      total_reviews: 5,
      total_violations: 10,
      violation_streak: 2,
    });

    const result = signals.getPathEffects(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      clean_streak: 0,
      file_path: "src/foo.ts",
      last_clean_at: "2026-04-15T00:00:00.000Z",
      last_violation_at: "2026-05-01T00:00:00.000Z",
      total_reviews: 5,
      total_violations: 10,
      violation_streak: 2,
    });
    db.close();
  });

  test("updates all fields on duplicate file_path", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertPathEffect({
      clean_streak: 0,
      file_path: "src/foo.ts",
      last_clean_at: null,
      last_violation_at: "2026-04-01T00:00:00.000Z",
      total_reviews: 3,
      total_violations: 5,
      violation_streak: 1,
    });
    signals.upsertPathEffect({
      clean_streak: 3,
      file_path: "src/foo.ts",
      last_clean_at: "2026-04-30T00:00:00.000Z",
      last_violation_at: "2026-05-01T00:00:00.000Z",
      total_reviews: 10,
      total_violations: 20,
      violation_streak: 0,
    });

    const result = signals.getPathEffects(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].total_violations).toBe(20);
    expect(result[0].total_reviews).toBe(10);
    expect(result[0].last_violation_at).toBe("2026-05-01T00:00:00.000Z");
    expect(result[0].last_clean_at).toBe("2026-04-30T00:00:00.000Z");
    expect(result[0].clean_streak).toBe(3);
    expect(result[0].violation_streak).toBe(0);
    db.close();
  });

  test("handles null nullable fields correctly", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertPathEffect({
      clean_streak: 1,
      file_path: "src/foo.ts",
      last_clean_at: null,
      last_violation_at: null,
      total_reviews: 1,
      total_violations: 0,
      violation_streak: 0,
    });

    const result = signals.getPathEffects(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].last_violation_at).toBeNull();
    expect(result[0].last_clean_at).toBeNull();
    db.close();
  });
});

// ---- DriftDb.getSignals() integration ----

describe("DriftDb.getSignals()", () => {
  test("returns a DriftDbSignals instance", () => {
    const db = initDriftDb(":memory:");
    const driftDb = new DriftDb(db);

    const signals = driftDb.getSignals();
    expect(signals).toBeInstanceOf(DriftDbSignals);
    driftDb.close();
  });

  test("returns the same instance on repeated calls (lazy singleton)", () => {
    const db = initDriftDb(":memory:");
    const driftDb = new DriftDb(db);

    const signals1 = driftDb.getSignals();
    const signals2 = driftDb.getSignals();
    expect(signals1).toBe(signals2);
    driftDb.close();
  });

  test("DriftDbSignals returned by getSignals() can read and write signal data", () => {
    const db = initDriftDb(":memory:");
    const driftDb = new DriftDb(db);
    const signals = driftDb.getSignals();

    signals.upsertFileViolation({
      file_path: "src/integration-test.ts",
      first_seen: "2026-05-15T00:00:00.000Z",
      last_seen: "2026-05-15T00:00:00.000Z",
      principle_id: "validate-at-trust-boundaries",
      violation_count: 1,
    });

    const result = signals.getFileViolationHistory(["src/integration-test.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("validate-at-trust-boundaries");
    driftDb.close();
  });
});
