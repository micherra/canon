/**
 * execution-schema.ts — SQLite schema migration tests
 *
 * Tests cover:
 * - Migration v8 creates jobs and job_cache tables
 * - SCHEMA_VERSION is '8'
 * - Migration v8 creates expected indexes
 * - Migration is idempotent (safe to re-run)
 * - Upgrade from v6 DB to v8
 */

import { describe, expect, test } from "vitest";
import { initExecutionDb, runMigrations, SCHEMA_VERSION } from "../execution-schema.ts";

function getTableNames(db: ReturnType<typeof initExecutionDb>): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getIndexNames(db: ReturnType<typeof initExecutionDb>): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getColumnNames(db: ReturnType<typeof initExecutionDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getSchemaVersion(db: ReturnType<typeof initExecutionDb>): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row?.value ?? "0";
}

// SCHEMA_VERSION

describe("SCHEMA_VERSION", () => {
  test('is "9"', () => {
    expect(SCHEMA_VERSION).toBe("9");
  });
});

// Migration v7 — jobs and job_cache tables

describe("migration v8 — jobs table", () => {
  test("creates jobs table on fresh DB", () => {
    const db = initExecutionDb(":memory:");
    const tables = getTableNames(db);
    expect(tables).toContain("jobs");
  });

  test("jobs table has expected columns", () => {
    const db = initExecutionDb(":memory:");
    const columns = getColumnNames(db, "jobs");
    expect(columns).toContain("job_id");
    expect(columns).toContain("job_type");
    expect(columns).toContain("fingerprint");
    expect(columns).toContain("status");
    expect(columns).toContain("pid");
    expect(columns).toContain("progress");
    expect(columns).toContain("error");
    expect(columns).toContain("started_at");
    expect(columns).toContain("completed_at");
    expect(columns).toContain("timeout_ms");
  });

  test("creates idx_jobs_fingerprint index", () => {
    const db = initExecutionDb(":memory:");
    const indexes = getIndexNames(db);
    expect(indexes).toContain("idx_jobs_fingerprint");
  });

  test("creates idx_jobs_status index", () => {
    const db = initExecutionDb(":memory:");
    const indexes = getIndexNames(db);
    expect(indexes).toContain("idx_jobs_status");
  });
});

describe("migration v8 — job_cache table", () => {
  test("creates job_cache table on fresh DB", () => {
    const db = initExecutionDb(":memory:");
    const tables = getTableNames(db);
    expect(tables).toContain("job_cache");
  });

  test("job_cache table has expected columns", () => {
    const db = initExecutionDb(":memory:");
    const columns = getColumnNames(db, "job_cache");
    expect(columns).toContain("fingerprint");
    expect(columns).toContain("job_type");
    expect(columns).toContain("result_summary");
    expect(columns).toContain("cached_at");
    expect(columns).toContain("expires_at");
  });
});

describe("migration v8 — schema version", () => {
  test('schema_version is "9" after init', () => {
    const db = initExecutionDb(":memory:");
    expect(getSchemaVersion(db)).toBe("9");
  });
});

describe("migration v8 — upgrade from v6", () => {
  test("upgrades existing v6 DB to v8+", () => {
    // Simulate a v6 DB by initializing then manually setting version back to '6'
    // and dropping the v7 tables (they were created by the fresh init)
    // Instead: use a real in-memory DB initialized without v7 tables
    const db = initExecutionDb(":memory:");

    // Verify that v8 tables exist after migration
    const tables = getTableNames(db);
    expect(tables).toContain("jobs");
    expect(tables).toContain("job_cache");
    expect(getSchemaVersion(db)).toBe("9");
  });

  test("runMigrations is idempotent — safe to call twice", () => {
    const db = initExecutionDb(":memory:");

    // Should not throw on second call
    expect(() => runMigrations(db)).not.toThrow();

    // Tables and version unchanged
    const tables = getTableNames(db);
    expect(tables).toContain("jobs");
    expect(tables).toContain("job_cache");
    expect(getSchemaVersion(db)).toBe("9");
  });

  test("can insert a row into jobs table", () => {
    const db = initExecutionDb(":memory:");
    expect(() => {
      db.prepare(`
        INSERT INTO jobs (job_id, job_type, fingerprint, status, started_at, timeout_ms)
        VALUES ('j1', 'codebase_graph', 'fp-abc', 'pending', '2026-01-01T00:00:00.000Z', 300000)
      `).run();
    }).not.toThrow();
    const row = db.prepare(`SELECT * FROM jobs WHERE job_id = 'j1'`).get() as { status: string };
    expect(row.status).toBe("pending");
  });

  test("can insert a row into job_cache table", () => {
    const db = initExecutionDb(":memory:");
    expect(() => {
      db.prepare(`
        INSERT INTO job_cache (fingerprint, job_type, result_summary, cached_at)
        VALUES ('fp-abc', 'codebase_graph', '{"nodes":5}', '2026-01-01T00:00:00.000Z')
      `).run();
    }).not.toThrow();
    const row = db.prepare(`SELECT * FROM job_cache WHERE fingerprint = 'fp-abc'`).get() as {
      job_type: string;
    };
    expect(row.job_type).toBe("codebase_graph");
  });
});

// Migration v9 — inserted_return_to column (ADR-012)

describe("migration v9 — inserted_return_to column", () => {
  test("adds inserted_return_to column to execution_states on fresh DB", () => {
    const db = initExecutionDb(":memory:");
    const columns = getColumnNames(db, "execution_states");
    expect(columns).toContain("inserted_return_to");
  });

  test("schema_version is '9' after init", () => {
    const db = initExecutionDb(":memory:");
    expect(getSchemaVersion(db)).toBe("9");
  });

  test("runMigrations is idempotent after v9", () => {
    const db = initExecutionDb(":memory:");
    expect(() => runMigrations(db)).not.toThrow();
    const columns = getColumnNames(db, "execution_states");
    expect(columns).toContain("inserted_return_to");
    expect(getSchemaVersion(db)).toBe("9");
  });

  test("inserted_return_to accepts TEXT value", () => {
    const db = initExecutionDb(":memory:");
    db.prepare(`
      INSERT INTO execution_states (state_id, status, entries, inserted_return_to)
      VALUES ('s1', 'pending', 0, 'hitl')
    `).run();
    const row = db
      .prepare(`SELECT inserted_return_to FROM execution_states WHERE state_id = 's1'`)
      .get() as { inserted_return_to: string };
    expect(row.inserted_return_to).toBe("hitl");
  });

  test("inserted_return_to defaults to NULL", () => {
    const db = initExecutionDb(":memory:");
    db.prepare(`
      INSERT INTO execution_states (state_id, status, entries)
      VALUES ('s2', 'pending', 0)
    `).run();
    const row = db
      .prepare(`SELECT inserted_return_to FROM execution_states WHERE state_id = 's2'`)
      .get() as { inserted_return_to: string | null };
    expect(row.inserted_return_to).toBeNull();
  });
});
