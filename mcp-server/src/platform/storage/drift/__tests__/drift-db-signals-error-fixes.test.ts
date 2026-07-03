/**
 * DriftDbSignals — error_fixes table DAO tests (v6 migration)
 *
 * Tests the v6 migration (error_fixes table) and getErrorFixes / upsertErrorFix methods.
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 *
 * Test plan:
 * - v6 migration creates error_fixes table with correct columns
 * - v6 migration creates indexes on file_path and principle_id
 * - UNIQUE(file_path, principle_id) constraint is enforced
 * - Fresh DB schema_version is '7'
 * - runDriftMigrations on a v5 DB upgrades to v6
 * - getErrorFixes([]) returns empty array (define-errors-out-of-existence)
 * - getErrorFixes returns matching rows for given file paths
 * - upsertErrorFix inserts new record
 * - upsertErrorFix on conflict updates occurrences and last_seen; preserves first_seen, error_pattern, fix_pattern
 * - getErrorFixes returns multiple rows for multiple file paths
 * - Idempotency: running v6 migration twice does not error
 */

import { describe, expect, test } from "vitest";
import type { UpsertErrorFixInput } from "../drift-db-signals.ts";
import { DriftDbSignals } from "../drift-db-signals.ts";
import { DRIFT_SCHEMA_VERSION, initDriftDb, runDriftMigrations } from "../drift-schema.ts";

// ---- Setup helpers ----

function makeSignalsDb(): {
  db: ReturnType<typeof initDriftDb>;
  signals: DriftDbSignals;
} {
  const db = initDriftDb(":memory:");
  const signals = new DriftDbSignals(db);
  return { db, signals };
}

// Helper: create a v5 database (without v6 migration)
// Simulates an existing drift.db at v5 before the v6 migration runs.
function _createV5Db(): ReturnType<typeof initDriftDb> {
  // initDriftDb runs all migrations including v5; we need a db stuck at v5
  // We do this by running initDriftDb and then manually rolling back the version
  // Actually — the cleanest approach is to run v1 base + v2 + v3 + v4 + v5 manually.
  // But since we can't easily "undo" v6, we use a different approach:
  // create the db, then patch the schema_version back to 5.
  // The table will already have error_fixes if DRIFT_SCHEMA_VERSION includes v6,
  // so we test v5→v6 by creating a bare db and running migrations selectively.

  // Use an in-memory db that starts at v1 and we manually apply v2–v5 only.
  const { Database } = require("better-sqlite3") as { Database: typeof import("better-sqlite3") };
  const db = new (Database as unknown as new (path: string) => ReturnType<typeof initDriftDb>)(
    ":memory:",
  );

  // Attempt import using the module directly
  return db;
}

// ---- DRIFT_SCHEMA_VERSION ----

describe("DRIFT_SCHEMA_VERSION", () => {
  test("is '11' after v11 migration added", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("13");
  });
});

// ---- v6 migration — fresh database ----

describe("initDriftDb — v6 fresh database", () => {
  test("meta table has schema_version = '10' after init", () => {
    const { db } = makeSignalsDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("13");
    db.close();
  });

  test("error_fixes table is created on fresh DB", () => {
    const { db } = makeSignalsDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("error_fixes");
    db.close();
  });

  test("error_fixes table has all expected columns", () => {
    const { db } = makeSignalsDb();
    const cols = db.prepare(`PRAGMA table_info(error_fixes)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("file_path");
    expect(colNames).toContain("principle_id");
    expect(colNames).toContain("error_pattern");
    expect(colNames).toContain("fix_pattern");
    expect(colNames).toContain("occurrences");
    expect(colNames).toContain("last_seen");
    expect(colNames).toContain("first_seen");
    db.close();
  });

  test("error_fixes table has indexes on file_path and principle_id", () => {
    const { db } = makeSignalsDb();
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='error_fixes' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_ef_file");
    expect(indexNames).toContain("idx_ef_principle");
    db.close();
  });
});

// ---- UNIQUE constraint ----

describe("error_fixes schema — UNIQUE(file_path, principle_id)", () => {
  test("rejects duplicate (file_path, principle_id) pair", () => {
    const { db } = makeSignalsDb();
    db.exec(`INSERT INTO error_fixes (file_path, principle_id, error_pattern, fix_pattern, occurrences, last_seen, first_seen)
      VALUES ('src/foo.ts', 'deep-modules', 'error A', 'fix A', 1, '2026-01-01', '2026-01-01')`);
    expect(() =>
      db.exec(`INSERT INTO error_fixes (file_path, principle_id, error_pattern, fix_pattern, occurrences, last_seen, first_seen)
        VALUES ('src/foo.ts', 'deep-modules', 'error B', 'fix B', 2, '2026-01-02', '2026-01-01')`),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test("allows same file_path with different principle_id", () => {
    const { db } = makeSignalsDb();
    db.exec(`INSERT INTO error_fixes (file_path, principle_id, error_pattern, fix_pattern, occurrences, last_seen, first_seen)
      VALUES ('src/foo.ts', 'deep-modules', 'error A', 'fix A', 1, '2026-01-01', '2026-01-01')`);
    expect(() =>
      db.exec(`INSERT INTO error_fixes (file_path, principle_id, error_pattern, fix_pattern, occurrences, last_seen, first_seen)
        VALUES ('src/foo.ts', 'simplicity-first', 'error B', 'fix B', 1, '2026-01-01', '2026-01-01')`),
    ).not.toThrow();
    db.close();
  });

  test("allows same principle_id with different file_path", () => {
    const { db } = makeSignalsDb();
    db.exec(`INSERT INTO error_fixes (file_path, principle_id, error_pattern, fix_pattern, occurrences, last_seen, first_seen)
      VALUES ('src/foo.ts', 'deep-modules', 'error A', 'fix A', 1, '2026-01-01', '2026-01-01')`);
    expect(() =>
      db.exec(`INSERT INTO error_fixes (file_path, principle_id, error_pattern, fix_pattern, occurrences, last_seen, first_seen)
        VALUES ('src/bar.ts', 'deep-modules', 'error A', 'fix A', 1, '2026-01-01', '2026-01-01')`),
    ).not.toThrow();
    db.close();
  });
});

// ---- v5 → v6 migration ----

describe("runDriftMigrations — v5 to v6 upgrade", () => {
  // We test that runDriftMigrations on a "current" db with schema_version='5'
  // will create the error_fixes table. We simulate a v5 db by patching schema_version.
  test("migrates a v5 DB: creates error_fixes table", () => {
    // Create fresh DB (which runs to v6), then downgrade version and drop table to simulate v5
    const db = initDriftDb(":memory:");
    db.exec(`DROP TABLE IF EXISTS error_fixes`);
    db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

    // Now run migrations — should create error_fixes
    runDriftMigrations(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("error_fixes");
    db.close();
  });

  test("migrates a v5 DB to current version: updates schema_version to '10'", () => {
    const db = initDriftDb(":memory:");
    db.exec(`DROP TABLE IF EXISTS error_fixes`);
    db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

    runDriftMigrations(db);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("13");
    db.close();
  });
});

// ---- Idempotency ----

describe("runDriftMigrations — v6 idempotency", () => {
  test("calling runDriftMigrations twice on a v6 DB does not error", () => {
    const { db } = makeSignalsDb();
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });
});

// ---- DriftDbSignals.getErrorFixes ----

describe("DriftDbSignals.getErrorFixes", () => {
  test("returns empty array for empty input", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getErrorFixes([]);
    expect(result).toEqual([]);
    db.close();
  });

  test("returns empty array when no data exists for the path", () => {
    const { signals, db } = makeSignalsDb();
    const result = signals.getErrorFixes(["src/nonexistent.ts"]);
    expect(result).toEqual([]);
    db.close();
  });

  test("returns matching rows for a given file path", () => {
    const { signals, db } = makeSignalsDb();
    const input: UpsertErrorFixInput = {
      error_pattern: "Too many parameters in handler",
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      fix_pattern: "Extract logic into service layer",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 3,
      principle_id: "deep-modules",
    };
    signals.upsertErrorFix(input);

    const result = signals.getErrorFixes(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      error_pattern: "Too many parameters in handler",
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      fix_pattern: "Extract logic into service layer",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 3,
      principle_id: "deep-modules",
    });
    db.close();
  });

  test("returns rows for multiple file paths", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertErrorFix({
      error_pattern: "error A",
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      fix_pattern: "fix A",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 1,
      principle_id: "deep-modules",
    });
    signals.upsertErrorFix({
      error_pattern: "error B",
      file_path: "src/bar.ts",
      first_seen: "2026-04-02T00:00:00.000Z",
      fix_pattern: "fix B",
      last_seen: "2026-05-02T00:00:00.000Z",
      occurrences: 2,
      principle_id: "simplicity-first",
    });

    const result = signals.getErrorFixes(["src/foo.ts", "src/bar.ts"]);
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.file_path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
    db.close();
  });

  test("does not return rows for file paths not in the input list", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertErrorFix({
      error_pattern: "error",
      file_path: "src/other.ts",
      first_seen: "2026-04-01T00:00:00.000Z",
      fix_pattern: "fix",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 1,
      principle_id: "deep-modules",
    });

    const result = signals.getErrorFixes(["src/foo.ts"]);
    expect(result).toEqual([]);
    db.close();
  });
});

// ---- DriftDbSignals.upsertErrorFix ----

describe("DriftDbSignals.upsertErrorFix", () => {
  test("inserts a new record", () => {
    const { signals, db } = makeSignalsDb();
    const input: UpsertErrorFixInput = {
      error_pattern: "Handler has too much logic",
      file_path: "src/new.ts",
      first_seen: "2026-05-10T00:00:00.000Z",
      fix_pattern: "Move to service",
      last_seen: "2026-05-10T00:00:00.000Z",
      occurrences: 1,
      principle_id: "thin-handlers",
    };

    expect(() => signals.upsertErrorFix(input)).not.toThrow();

    const result = signals.getErrorFixes(["src/new.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(input);
    db.close();
  });

  test("updates occurrences and last_seen on conflict", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertErrorFix({
      error_pattern: "Too many parameters",
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      fix_pattern: "Extract to service",
      last_seen: "2026-04-01T00:00:00.000Z",
      occurrences: 1,
      principle_id: "deep-modules",
    });
    signals.upsertErrorFix({
      error_pattern: "Too many parameters",
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z", // same — should be preserved
      fix_pattern: "Extract to service",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 5,
      principle_id: "deep-modules",
    });

    const result = signals.getErrorFixes(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(5);
    expect(result[0].last_seen).toBe("2026-05-01T00:00:00.000Z");
    db.close();
  });

  test("preserves first_seen on conflict — DO UPDATE SET only updates occurrences and last_seen", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertErrorFix({
      error_pattern: "Too many parameters",
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      fix_pattern: "Extract to service",
      last_seen: "2026-04-01T00:00:00.000Z",
      occurrences: 1,
      principle_id: "deep-modules",
    });
    signals.upsertErrorFix({
      error_pattern: "Too many parameters",
      file_path: "src/foo.ts",
      first_seen: "2099-01-01T00:00:00.000Z", // should NOT overwrite original first_seen
      fix_pattern: "Extract to service",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 2,
      principle_id: "deep-modules",
    });

    const result = signals.getErrorFixes(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].first_seen).toBe("2026-03-01T00:00:00.000Z");
    expect(result[0].occurrences).toBe(2);
    expect(result[0].last_seen).toBe("2026-05-01T00:00:00.000Z");
    db.close();
  });

  test("preserves error_pattern and fix_pattern on conflict", () => {
    const { signals, db } = makeSignalsDb();
    signals.upsertErrorFix({
      error_pattern: "original error pattern",
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      fix_pattern: "original fix pattern",
      last_seen: "2026-04-01T00:00:00.000Z",
      occurrences: 1,
      principle_id: "deep-modules",
    });
    signals.upsertErrorFix({
      error_pattern: "should not overwrite",
      file_path: "src/foo.ts",
      first_seen: "2026-03-01T00:00:00.000Z",
      fix_pattern: "should not overwrite",
      last_seen: "2026-05-01T00:00:00.000Z",
      occurrences: 2,
      principle_id: "deep-modules",
    });

    const result = signals.getErrorFixes(["src/foo.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].error_pattern).toBe("original error pattern");
    expect(result[0].fix_pattern).toBe("original fix pattern");
    db.close();
  });
});
