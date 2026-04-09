/**
 * Drift Schema Tests — v3 migration, FTS5, and ADR-019 columns
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Tests cover fresh DB creation, v1→v3 migration, v2→v3 migration,
 * idempotency, FTS5 virtual table, and new DAO methods.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DecisionEntry } from "../drift-analytics-types.ts";
import type { FlowRunEntry } from "../analytics.ts";
import { DriftDb } from "../drift-db.ts";
import { DRIFT_SCHEMA_VERSION, initDriftDb, runDriftMigrations } from "../drift-schema.ts";

// ---- Helpers ----

function makeDecisionEntry(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    content: "Use SQLite for drift tracking",
    decision_id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    title: "Storage approach",
    ...overrides,
  };
}

function makeFlowRunEntry(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: new Date().toISOString(),
    flow: "feature",
    run_id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    skipped_states: [],
    started: new Date().toISOString(),
    state_durations: { implement: 5000 },
    state_iterations: { implement: 1 },
    task: "Add feature Y",
    tier: "full",
    total_duration_ms: 10000,
    total_spawns: 3,
    ...overrides,
  };
}

function makeDb(): { db: Database.Database; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

// ---- Schema creation ----

describe("initDriftDb — fresh DB gets schema v3", () => {
  test("creates all required tables including decisions and history_fts", () => {
    const db = initDriftDb(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("meta");
    expect(names).toContain("reviews");
    expect(names).toContain("violations");
    expect(names).toContain("flow_runs");
    expect(names).toContain("decisions");
    db.close();
  });

  test("sets schema_version to 3", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("3");
    expect(DRIFT_SCHEMA_VERSION).toBe("3");
    db.close();
  });

  test("decisions table has all ADR-019 columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db
      .prepare(`PRAGMA table_info(decisions)`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("decision_id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("content");
    expect(colNames).toContain("timestamp");
    // v3 additions
    expect(colNames).toContain("decision_type");
    expect(colNames).toContain("summary");
    expect(colNames).toContain("rationale");
    expect(colNames).toContain("alternatives");
    expect(colNames).toContain("evidence_ref");
    expect(colNames).toContain("files_affected");
    db.close();
  });

  test("flow_runs table has commits and diff_stat columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db
      .prepare(`PRAGMA table_info(flow_runs)`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("commits");
    expect(colNames).toContain("diff_stat");
    db.close();
  });

  test("FTS5 virtual table history_fts is created", () => {
    const db = initDriftDb(":memory:");
    // FTS5 tables appear as virtual tables in sqlite_master
    const vtables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table','shadow') AND name LIKE 'history_fts%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = vtables.map((t) => t.name);
    expect(names).toContain("history_fts");
    db.close();
  });
});

// ---- v1 → v3 migration ----

describe("v1 DB upgrades to v3", () => {
  test("v1 DB (no decisions, no commits) migrates to v3 with all columns added", () => {
    // Simulate a v1 DB: baseline DDL only, no migrations applied
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Apply v1-equivalent schema: meta + reviews + violations + flow_runs (no commits/diff_stat)
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
    db.exec(`CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL UNIQUE,
      timestamp TEXT NOT NULL,
      files TEXT NOT NULL,
      honored TEXT NOT NULL,
      score TEXT NOT NULL,
      verdict TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL,
      principle_id TEXT NOT NULL,
      severity TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS flow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      flow TEXT NOT NULL,
      tier TEXT NOT NULL,
      task TEXT NOT NULL,
      started TEXT NOT NULL,
      completed TEXT NOT NULL,
      total_duration_ms INTEGER NOT NULL,
      state_durations TEXT NOT NULL,
      state_iterations TEXT NOT NULL,
      skipped_states TEXT NOT NULL,
      total_spawns INTEGER NOT NULL
    )`);

    // Run migrations
    runDriftMigrations(db);

    // Verify schema version is now 3
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("3");

    // Verify decisions table exists with v3 columns
    const cols = db
      .prepare(`PRAGMA table_info(decisions)`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("decision_type");
    expect(colNames).toContain("summary");
    expect(colNames).toContain("alternatives");
    expect(colNames).toContain("files_affected");

    // Verify flow_runs has commits and diff_stat
    const runCols = db
      .prepare(`PRAGMA table_info(flow_runs)`)
      .all() as Array<{ name: string }>;
    const runColNames = runCols.map((c) => c.name);
    expect(runColNames).toContain("commits");
    expect(runColNames).toContain("diff_stat");

    // Verify FTS5 table
    const vtables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name LIKE 'history_fts%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(vtables.map((t) => t.name)).toContain("history_fts");

    db.close();
  });
});

// ---- v2 → v3 migration ----

describe("v2 DB upgrades to v3", () => {
  test("v2 DB (has decisions with old columns) upgrades and retains existing data", () => {
    // Build a v2-equivalent DB
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2')`);
    db.exec(`CREATE TABLE IF NOT EXISTS flow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      flow TEXT NOT NULL,
      tier TEXT NOT NULL,
      task TEXT NOT NULL,
      started TEXT NOT NULL,
      completed TEXT NOT NULL,
      total_duration_ms INTEGER NOT NULL,
      state_durations TEXT NOT NULL,
      state_iterations TEXT NOT NULL,
      skipped_states TEXT NOT NULL,
      total_spawns INTEGER NOT NULL,
      commits TEXT,
      diff_stat TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT NOT NULL UNIQUE,
      run_id TEXT,
      flow TEXT,
      task TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT,
      timestamp TEXT NOT NULL
    )`);

    // Insert an existing v2 decision (without new columns)
    db.exec(`
      INSERT INTO decisions (decision_id, title, content, timestamp)
      VALUES ('dec_v2_001', 'Old decision', 'Old content', '2026-01-01T00:00:00Z')
    `);

    // Apply v3 migration only
    runDriftMigrations(db);

    // Schema version is now 3
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("3");

    // New columns exist
    const cols = db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("decision_type");
    expect(colNames).toContain("summary");
    expect(colNames).toContain("rationale");
    expect(colNames).toContain("alternatives");
    expect(colNames).toContain("evidence_ref");
    expect(colNames).toContain("files_affected");

    // Old data is still present and readable
    const existing = db
      .prepare(`SELECT * FROM decisions WHERE decision_id = 'dec_v2_001'`)
      .get() as Record<string, unknown>;
    expect(existing).toBeDefined();
    expect(existing["title"]).toBe("Old decision");
    expect(existing["content"]).toBe("Old content");
    // New columns default to NULL for old rows
    expect(existing["decision_type"]).toBeNull();
    expect(existing["summary"]).toBeNull();

    db.close();
  });
});

// ---- Idempotency ----

describe("runDriftMigrations idempotency", () => {
  test("calling initDriftDb twice on same in-memory state does not error", () => {
    const db = initDriftDb(":memory:");

    // Run migrations again on the same db — should be no-op
    expect(() => runDriftMigrations(db)).not.toThrow();

    // Schema version is still 3
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("3");
    db.close();
  });

  test("v3 migration is safe to call multiple times (columnExists guards)", () => {
    const db = initDriftDb(":memory:");

    // Running migrations repeatedly should be safe
    runDriftMigrations(db);
    runDriftMigrations(db);

    const cols = db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    // No duplicate columns
    const decisionTypeCount = colNames.filter((c) => c === "decision_type").length;
    expect(decisionTypeCount).toBe(1);
    db.close();
  });
});

// ---- FTS5 virtual table ----

describe("FTS5 history_fts virtual table", () => {
  let db: Database.Database;
  let store: DriftDb;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("accepts inserts and returns ranked results for matching query", () => {
    store.indexHistoryEntry("decision", "dec_001", "Use SQLite for drift tracking decisions");
    store.indexHistoryEntry("decision", "dec_002", "Use PostgreSQL for production workloads");
    store.indexHistoryEntry("flow_run", "run_001", "Feature flow completed successfully");

    const results = store.searchHistory("SQLite");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entity_id).toBe("dec_001");
    expect(results[0].entity_type).toBe("decision");
    expect(typeof results[0].rank).toBe("number");
  });

  test("returns empty array when no matches found", () => {
    store.indexHistoryEntry("decision", "dec_001", "Use SQLite for persistence");
    const results = store.searchHistory("nonexistent_term_xyz");
    expect(results).toEqual([]);
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.indexHistoryEntry("decision", `dec_00${i}`, `SQLite decision number ${i}`);
    }
    const results = store.searchHistory("SQLite decision", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("uses default limit of 20 when not specified", () => {
    for (let i = 0; i < 25; i++) {
      store.indexHistoryEntry("decision", `dec_${i}`, `SQLite persistence architecture decision ${i}`);
    }
    const results = store.searchHistory("SQLite");
    expect(results.length).toBeLessThanOrEqual(20);
  });
});

// ---- appendDecision with new fields ----

describe("appendDecision with ADR-019 fields", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("persists and reads back all new v3 fields", () => {
    const entry = makeDecisionEntry({
      alternatives: ["PostgreSQL", "MySQL", "DynamoDB"],
      decision_id: "dec_full_001",
      decision_type: "architecture",
      evidence_ref: "transcripts/session-01.md#L45-L120",
      files_affected: ["src/platform/storage/drift/drift-db.ts", "src/platform/storage/drift/drift-schema.ts"],
      rationale: "SQLite is embedded and requires no separate process",
      summary: "Choose SQLite as the drift database",
    });

    store.appendDecision(entry);
    const results = store.getRecentDecisions(1);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.decision_id).toBe("dec_full_001");
    expect(r.decision_type).toBe("architecture");
    expect(r.summary).toBe("Choose SQLite as the drift database");
    expect(r.rationale).toBe("SQLite is embedded and requires no separate process");
    expect(r.alternatives).toEqual(["PostgreSQL", "MySQL", "DynamoDB"]);
    expect(r.evidence_ref).toBe("transcripts/session-01.md#L45-L120");
    expect(r.files_affected).toEqual([
      "src/platform/storage/drift/drift-db.ts",
      "src/platform/storage/drift/drift-schema.ts",
    ]);
  });

  test("stores minimal decision (no new fields) without error", () => {
    const entry = makeDecisionEntry({ decision_id: "dec_minimal_001" });
    store.appendDecision(entry);

    const results = store.getRecentDecisions(1);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.decision_id).toBe("dec_minimal_001");
    expect(r.decision_type).toBeUndefined();
    expect(r.summary).toBeUndefined();
    expect(r.alternatives).toBeUndefined();
    expect(r.files_affected).toBeUndefined();
  });

  test("INSERT OR IGNORE silently skips duplicate decision_ids", () => {
    const entry = makeDecisionEntry({ decision_id: "dec_dup_001" });
    store.appendDecision(entry);
    store.appendDecision(entry); // duplicate

    const results = store.getRecentDecisions(10);
    expect(results.filter((r) => r.decision_id === "dec_dup_001")).toHaveLength(1);
  });

  test("alternatives and files_affected round-trip as arrays (JSON serialization)", () => {
    const entry = makeDecisionEntry({
      alternatives: ["option-a", "option-b"],
      decision_id: "dec_arrays_001",
      files_affected: ["src/foo.ts", "src/bar.ts"],
    });
    store.appendDecision(entry);

    const results = store.getRecentDecisions(1);
    expect(results[0].alternatives).toEqual(["option-a", "option-b"]);
    expect(results[0].files_affected).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});

// ---- getFlowRuns ----

describe("getFlowRuns", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns empty array for empty DB", () => {
    expect(store.getFlowRuns()).toEqual([]);
  });

  test("returns all runs ordered by completed DESC when no options provided", () => {
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-10T12:00:00Z", run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-12T12:00:00Z", run_id: "r2" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-11T12:00:00Z", run_id: "r3" }));

    const runs = store.getFlowRuns();
    expect(runs).toHaveLength(3);
    expect(runs[0].run_id).toBe("r2"); // most recent first
    expect(runs[1].run_id).toBe("r3");
    expect(runs[2].run_id).toBe("r1");
  });

  test("respects limit option", () => {
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-10T12:00:00Z", run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-11T12:00:00Z", run_id: "r2" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-12T12:00:00Z", run_id: "r3" }));

    const runs = store.getFlowRuns({ limit: 2 });
    expect(runs).toHaveLength(2);
    expect(runs[0].run_id).toBe("r3"); // most recent
    expect(runs[1].run_id).toBe("r2");
  });

  test("respects since option — excludes runs before the timestamp", () => {
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-05T00:00:00Z", run_id: "r_before" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-10T00:00:00Z", run_id: "r_after" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-15T00:00:00Z", run_id: "r_latest" }));

    const runs = store.getFlowRuns({ since: "2026-01-08T00:00:00Z" });
    const ids = runs.map((r) => r.run_id);
    expect(ids).toContain("r_after");
    expect(ids).toContain("r_latest");
    expect(ids).not.toContain("r_before");
  });

  test("respects both since and limit together", () => {
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-05T00:00:00Z", run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-10T00:00:00Z", run_id: "r2" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-15T00:00:00Z", run_id: "r3" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-20T00:00:00Z", run_id: "r4" }));

    const runs = store.getFlowRuns({ limit: 2, since: "2026-01-08T00:00:00Z" });
    expect(runs).toHaveLength(2);
    const ids = runs.map((r) => r.run_id);
    // Should be the 2 most recent runs after since (r3, r4)
    expect(ids).toContain("r4");
    expect(ids).toContain("r3");
    expect(ids).not.toContain("r1");
  });
});

// ---- getFlowRunsByFilePath ----

describe("getFlowRunsByFilePath", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns empty array when no runs match the path", () => {
    store.appendFlowRun(makeFlowRunEntry({ diff_stat: "src/other.ts +10 -2", run_id: "r1" }));
    const results = store.getFlowRunsByFilePath("src/missing.ts", 10);
    expect(results).toEqual([]);
  });

  test("returns matching runs when diff_stat contains the file path", () => {
    store.appendFlowRun(makeFlowRunEntry({
      completed: "2026-01-10T00:00:00Z",
      diff_stat: "src/platform/drift-db.ts +25 -10\nsrc/other.ts +5 -1",
      run_id: "r_match",
    }));
    store.appendFlowRun(makeFlowRunEntry({
      completed: "2026-01-11T00:00:00Z",
      diff_stat: "src/app/index.ts +3 -1",
      run_id: "r_no_match",
    }));

    const results = store.getFlowRunsByFilePath("drift-db.ts", 10);
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("r_match");
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      store.appendFlowRun(makeFlowRunEntry({
        completed: `2026-01-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
        diff_stat: "src/shared/target-file.ts +5 -2",
        run_id: `r${i}`,
      }));
    }

    const results = store.getFlowRunsByFilePath("target-file.ts", 2);
    expect(results).toHaveLength(2);
  });

  test("returns empty array when no runs have diff_stat", () => {
    store.appendFlowRun(makeFlowRunEntry({ run_id: "r_no_stat" }));
    const results = store.getFlowRunsByFilePath("any-file.ts", 10);
    expect(results).toEqual([]);
  });
});

// ---- getDecisionsByFilesAffected ----

describe("getDecisionsByFilesAffected", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns decisions where files_affected contains the path", () => {
    store.appendDecision(makeDecisionEntry({
      decision_id: "dec_match",
      files_affected: ["src/platform/drift-db.ts", "src/platform/drift-schema.ts"],
    }));
    store.appendDecision(makeDecisionEntry({
      decision_id: "dec_no_match",
      files_affected: ["src/app/index.ts"],
    }));

    const results = store.getDecisionsByFilesAffected("drift-db.ts");
    expect(results).toHaveLength(1);
    expect(results[0].decision_id).toBe("dec_match");
  });

  test("returns empty array when no decisions match the path", () => {
    store.appendDecision(makeDecisionEntry({
      decision_id: "dec_001",
      files_affected: ["src/app/other.ts"],
    }));
    const results = store.getDecisionsByFilesAffected("nonexistent-file.ts");
    expect(results).toEqual([]);
  });

  test("returns empty array when no decisions have files_affected set", () => {
    store.appendDecision(makeDecisionEntry({ decision_id: "dec_no_files" }));
    const results = store.getDecisionsByFilesAffected("any-file.ts");
    expect(results).toEqual([]);
  });

  test("returns multiple matching decisions", () => {
    store.appendDecision(makeDecisionEntry({
      decision_id: "dec_a",
      files_affected: ["src/shared/utils.ts"],
    }));
    store.appendDecision(makeDecisionEntry({
      decision_id: "dec_b",
      files_affected: ["src/shared/utils.ts", "src/other.ts"],
    }));
    store.appendDecision(makeDecisionEntry({
      decision_id: "dec_c",
      files_affected: ["src/app/index.ts"],
    }));

    const results = store.getDecisionsByFilesAffected("utils.ts");
    const ids = results.map((r) => r.decision_id);
    expect(ids).toContain("dec_a");
    expect(ids).toContain("dec_b");
    expect(ids).not.toContain("dec_c");
  });
});
