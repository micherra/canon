/**
 * Tests for ADR-015 transcript schema additions:
 * - Migration v4 adds transcript_path column on execution_states
 * - ExecutionStore setTranscriptPath / getTranscriptPath methods
 * - TranscriptEntrySchema validation
 * - initWorkspace creates transcripts/ subdirectory
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import Database from "better-sqlite3";

import {
  initExecutionDb,
  SCHEMA_VERSION,
  columnExists,
  runMigrations,
} from "../orchestration/execution-schema.ts";
import { ExecutionStore } from "../orchestration/execution-store.ts";
import { TranscriptEntrySchema } from "../orchestration/flow-schema.ts";
import { initWorkspace } from "../orchestration/workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDb(prefix = "transcript-schema-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return join(dir, "orchestration.db");
}

function makeTmpDir(prefix = "transcript-workspace-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Creates a v3 database (without transcript_path), simulating a pre-v4 DB. */
function createV3Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '3')`);

  db.exec(`CREATE TABLE IF NOT EXISTS execution_states (
    state_id                  TEXT PRIMARY KEY,
    status                    TEXT NOT NULL DEFAULT 'pending',
    entries                   INTEGER NOT NULL DEFAULT 0,
    entered_at                TEXT,
    completed_at              TEXT,
    result                    TEXT,
    artifacts                 TEXT,
    artifact_history          TEXT,
    error                     TEXT,
    wave                      INTEGER,
    wave_total                INTEGER,
    wave_results              TEXT,
    metrics                   TEXT,
    gate_results              TEXT,
    postcondition_results     TEXT,
    discovered_gates          TEXT,
    discovered_postconditions TEXT,
    parallel_results          TEXT,
    compete_results           TEXT,
    synthesized               INTEGER
  )`);

  // Add all other required tables so migrations can run cleanly
  db.exec(`CREATE TABLE IF NOT EXISTS execution (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    flow            TEXT NOT NULL,
    task            TEXT NOT NULL,
    entry           TEXT NOT NULL,
    current_state   TEXT NOT NULL,
    base_commit     TEXT NOT NULL,
    started         TEXT NOT NULL,
    last_updated    TEXT NOT NULL,
    blocked         TEXT,
    concerns        TEXT NOT NULL DEFAULT '[]',
    skipped         TEXT NOT NULL DEFAULT '[]',
    metadata        TEXT,
    branch          TEXT NOT NULL,
    sanitized       TEXT NOT NULL,
    created         TEXT NOT NULL,
    original_task   TEXT,
    tier            TEXT NOT NULL,
    flow_name       TEXT NOT NULL,
    slug            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    completed_at    TEXT,
    rolled_back_at  TEXT,
    rolled_back_to  TEXT,
    correlation_id  TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS iterations (
    state_id    TEXT PRIMARY KEY,
    count       INTEGER NOT NULL DEFAULT 0,
    max         INTEGER NOT NULL,
    history     TEXT NOT NULL DEFAULT '[]',
    cannot_fix  TEXT NOT NULL DEFAULT '[]'
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS progress_entries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    line      TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    channel   TEXT NOT NULL,
    sender    TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS wave_events (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL,
    payload          TEXT NOT NULL,
    timestamp        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    applied_at       TEXT,
    resolution       TEXT,
    rejection_reason TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT NOT NULL,
    payload        TEXT NOT NULL,
    correlation_id TEXT,
    timestamp      TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS iteration_results (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    state_id  TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    status    TEXT NOT NULL,
    data      TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL,
    UNIQUE(state_id, iteration)
  )`);

  return db;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// 1. SCHEMA_VERSION is '4'
// ---------------------------------------------------------------------------

describe("schema version", () => {
  it("SCHEMA_VERSION is '4'", () => {
    expect(SCHEMA_VERSION).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// 2. Migration v4 adds transcript_path column to execution_states on fresh DB
// ---------------------------------------------------------------------------

describe("migration v4 — fresh DB", () => {
  it("fresh DB has transcript_path column on execution_states", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "execution_states", "transcript_path")).toBe(true);

    db.close();
  });

  it("fresh DB meta table has schema_version '4'", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Migration v4 is idempotent (running twice does not error)
// ---------------------------------------------------------------------------

describe("migration v4 — idempotency", () => {
  it("calling initExecutionDb twice does not throw", () => {
    const dbPath = makeTmpDb();
    const db1 = initExecutionDb(dbPath);
    db1.close();

    expect(() => {
      const db2 = initExecutionDb(dbPath);
      db2.close();
    }).not.toThrow();
  });

  it("schema_version is still '5' after two consecutive inits", () => {
    const dbPath = makeTmpDb();

    const db1 = initExecutionDb(dbPath);
    db1.close();

    const db2 = initExecutionDb(dbPath);

    const row = db2
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");
    db2.close();
  });

  it("running runMigrations twice on a v4 DB does not error", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath); // already at v4

    expect(() => runMigrations(db)).not.toThrow();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Migration v4 upgrades existing v3 database correctly
// ---------------------------------------------------------------------------

describe("migration v4 — v3 to v4 upgrade", () => {
  it("migrates v3 DB: transcript_path column added to execution_states", () => {
    const dbPath = makeTmpDb();
    const v3db = createV3Db(dbPath);
    v3db.close();

    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "execution_states", "transcript_path")).toBe(true);

    db.close();
  });

  it("migrates v3 DB: schema_version updated to '5'", () => {
    const dbPath = makeTmpDb();
    const v3db = createV3Db(dbPath);
    v3db.close();

    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");

    db.close();
  });

  it("existing execution_states rows survive v3→v4 migration (transcript_path is NULL)", () => {
    const dbPath = makeTmpDb();
    const v3db = createV3Db(dbPath);

    // Insert a row before migration
    v3db
      .prepare(
        `INSERT INTO execution_states (state_id, status, entries) VALUES ('build', 'pending', 0)`,
      )
      .run();
    v3db.close();

    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT state_id, status, transcript_path FROM execution_states WHERE state_id = 'build'")
      .get() as { state_id: string; status: string; transcript_path: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.state_id).toBe("build");
    expect(row!.status).toBe("pending");
    expect(row!.transcript_path).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. setTranscriptPath stores and getTranscriptPath retrieves the path
// ---------------------------------------------------------------------------

describe("ExecutionStore — setTranscriptPath / getTranscriptPath", () => {
  it("setTranscriptPath stores and getTranscriptPath retrieves the path", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    // Insert a state row first
    store.upsertState("build", { status: "pending", entries: 0 });

    const transcriptPath = "/workspace/transcripts/build-001.jsonl";
    const result = store.setTranscriptPath("build", transcriptPath);

    expect(result).toBe(true);
    expect(store.getTranscriptPath("build")).toBe(transcriptPath);

    db.close();
  });

  it("setTranscriptPath returns false for non-existent state", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const result = store.setTranscriptPath("nonexistent", "/some/path.jsonl");

    expect(result).toBe(false);

    db.close();
  });

  it("getTranscriptPath returns null for state with no transcript", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    store.upsertState("review", { status: "pending", entries: 0 });

    expect(store.getTranscriptPath("review")).toBeNull();

    db.close();
  });

  it("getTranscriptPath returns null for non-existent state", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    expect(store.getTranscriptPath("ghost-state")).toBeNull();

    db.close();
  });

  it("setTranscriptPath can overwrite an existing path", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    store.upsertState("build", { status: "pending", entries: 0 });
    store.setTranscriptPath("build", "/first/path.jsonl");
    store.setTranscriptPath("build", "/second/path.jsonl");

    expect(store.getTranscriptPath("build")).toBe("/second/path.jsonl");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 6. upsert preserves existing transcript_path
// ---------------------------------------------------------------------------

describe("ExecutionStore — upsert preserves transcript_path", () => {
  it("upsertState does not clear an existing transcript_path", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    store.upsertState("build", { status: "pending", entries: 0 });
    store.setTranscriptPath("build", "/transcripts/build.jsonl");

    // Re-upsert the state (simulating a status update)
    store.upsertState("build", { status: "in_progress", entries: 1 });

    expect(store.getTranscriptPath("build")).toBe("/transcripts/build.jsonl");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 7. TranscriptEntrySchema validation
// ---------------------------------------------------------------------------

describe("TranscriptEntrySchema", () => {
  it("validates a correct entry", () => {
    const entry = {
      role: "assistant",
      timestamp: "2026-04-02T00:00:00Z",
      content: "I will implement the feature.",
      turn_number: 1,
    };

    const result = TranscriptEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("validates a correct entry with optional fields", () => {
    const entry = {
      role: "tool_use",
      timestamp: "2026-04-02T00:00:00Z",
      content: '{"tool": "Read", "path": "/foo.ts"}',
      tool_name: "Read",
      tokens: 42,
      cumulative_tokens: 1234,
      turn_number: 3,
    };

    const result = TranscriptEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("rejects entry with invalid role", () => {
    const entry = {
      role: "bot", // invalid — not in enum
      timestamp: "2026-04-02T00:00:00Z",
      content: "hello",
      turn_number: 1,
    };

    const result = TranscriptEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("rejects entry missing required turn_number", () => {
    const entry = {
      role: "user",
      timestamp: "2026-04-02T00:00:00Z",
      content: "hello",
      // turn_number missing
    };

    const result = TranscriptEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("rejects entry missing required content", () => {
    const entry = {
      role: "user",
      timestamp: "2026-04-02T00:00:00Z",
      turn_number: 1,
      // content missing
    };

    const result = TranscriptEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("accepts all valid role values", () => {
    const validRoles = ["system", "user", "assistant", "tool_use", "tool_result"] as const;
    for (const role of validRoles) {
      const result = TranscriptEntrySchema.safeParse({
        role,
        timestamp: "2026-04-02T00:00:00Z",
        content: "test",
        turn_number: 1,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. initWorkspace creates transcripts/ subdirectory
// ---------------------------------------------------------------------------

describe("initWorkspace — transcripts subdirectory", () => {
  it("creates transcripts/ subdirectory", async () => {
    const projectDir = makeTmpDir();
    const ws = await initWorkspace(projectDir, "my-branch");

    await expect(
      access(join(ws, "transcripts")).then(() => true),
    ).resolves.toBe(true);
  });

  it("creates all expected subdirectories including transcripts", async () => {
    const projectDir = makeTmpDir();
    const ws = await initWorkspace(projectDir, "my-branch");

    const expected = ["research", "decisions", "plans", "reviews", "transcripts"];
    for (const dir of expected) {
      await expect(
        access(join(ws, dir)).then(() => true),
      ).resolves.toBe(true);
    }
  });
});
