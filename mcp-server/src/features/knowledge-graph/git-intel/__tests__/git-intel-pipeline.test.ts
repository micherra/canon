/**
 * git-intel-pipeline.test.ts
 *
 * Tests for the pipeline orchestrator:
 * - isGitIntelStale
 * - getCurrentHead
 * - runGitIntelPipeline
 * - ensureGitIntelFresh
 * - computeGitIntel
 */

import { describe, expect, test, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase } from "@graph/kg-schema.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock git-adapter at module level
// ---------------------------------------------------------------------------

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: vi.fn(),
  gitDiff: vi.fn(),
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  gitWorktreeAdd: vi.fn(),
}));

// Import after mocking
import { gitExec } from "@platform/adapters/git-adapter.ts";
import {
  isGitIntelStale,
  getCurrentHead,
  runGitIntelPipeline,
  ensureGitIntelFresh,
  computeGitIntel,
} from "../git-intel-pipeline.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory SQLite DB with the tables needed for pipeline tests. */
const makeDb = (): Database.Database => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '4');

    CREATE TABLE IF NOT EXISTS files (
      file_id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      mtime_ms REAL NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'unknown',
      layer TEXT NOT NULL DEFAULT 'unknown',
      last_indexed_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS entities (
      entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      is_exported INTEGER NOT NULL DEFAULT 0,
      is_default_export INTEGER NOT NULL DEFAULT 0,
      signature TEXT,
      metadata TEXT,
      UNIQUE(file_id, qualified_name)
    );

    CREATE TABLE IF NOT EXISTS hotspot_scores (
      file_path TEXT PRIMARY KEY,
      churn_raw REAL NOT NULL,
      churn_percentile REAL NOT NULL,
      complexity_raw REAL NOT NULL,
      complexity_pctile REAL NOT NULL,
      score REAL NOT NULL,
      is_hotspot INTEGER NOT NULL DEFAULT 0,
      computed_at_commit TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS co_change_edges (
      file_a TEXT NOT NULL,
      file_b TEXT NOT NULL,
      co_commit_count INTEGER NOT NULL,
      jaccard REAL NOT NULL,
      computed_at_commit TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (file_a, file_b)
    );

    CREATE INDEX IF NOT EXISTS idx_co_change_a ON co_change_edges(file_a);
    CREATE INDEX IF NOT EXISTS idx_co_change_b ON co_change_edges(file_b);
  `);

  return db;
};

/** Seed a hotspot_scores row with a given commit SHA for staleness tests. */
const seedHotspot = (db: Database.Database, sha: string): void => {
  db.prepare(`
    INSERT INTO hotspot_scores
      (file_path, churn_raw, churn_percentile, complexity_raw, complexity_pctile,
       score, is_hotspot, computed_at_commit, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("src/foo.ts", 1.0, 0.5, 2, 0.5, 0.25, 0, sha, new Date().toISOString());
};

const makeOkResult = (stdout: string): ProcessResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  duration_ms: 1,
});

const makeFailResult = (): ProcessResult => ({
  ok: false,
  stdout: "",
  stderr: "not a git repository",
  exitCode: 128,
  timedOut: false,
  duration_ms: 1,
});

// ---------------------------------------------------------------------------
// isGitIntelStale
// ---------------------------------------------------------------------------

describe("isGitIntelStale", () => {
  const FAKE_HEAD = "aabbccddee112233445566778899aabbccddeeff";

  beforeEach(() => {
    vi.mocked(gitExec).mockReset();
    vi.mocked(gitExec).mockReturnValue(makeOkResult(FAKE_HEAD + "\n"));
  });

  test("returns true when no data exists (empty hotspot_scores table)", () => {
    const db = makeDb();
    const result = isGitIntelStale(db, "/fake/repo");
    expect(result).toBe(true);
    db.close();
  });

  test("returns true when HEAD differs from stored SHA", () => {
    const db = makeDb();
    seedHotspot(db, "different-sha-than-head");
    const result = isGitIntelStale(db, "/fake/repo");
    expect(result).toBe(true);
    db.close();
  });

  test("returns false when HEAD matches stored SHA", () => {
    const db = makeDb();
    seedHotspot(db, FAKE_HEAD);
    const result = isGitIntelStale(db, "/fake/repo");
    expect(result).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// getCurrentHead
// ---------------------------------------------------------------------------

describe("getCurrentHead", () => {
  beforeEach(() => {
    vi.mocked(gitExec).mockReset();
  });

  test("returns trimmed SHA when git succeeds", () => {
    vi.mocked(gitExec).mockReturnValueOnce(makeOkResult("abc123\n"));
    const result = getCurrentHead("/fake/repo");
    expect(result).toBe("abc123");
  });

  test("returns null when git fails", () => {
    vi.mocked(gitExec).mockReturnValueOnce(makeFailResult());
    const result = getCurrentHead("/not-a-git-repo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runGitIntelPipeline
// ---------------------------------------------------------------------------

describe("runGitIntelPipeline", () => {
  beforeEach(() => {
    vi.mocked(gitExec).mockReset();
  });

  test("handles git failure gracefully (no throw) when rev-parse fails", () => {
    vi.mocked(gitExec).mockReturnValue(makeFailResult());

    const db = makeDb();
    expect(() => runGitIntelPipeline(db, "/not-a-git-repo")).not.toThrow();
    db.close();
  });

  test("handles git log failure gracefully (no throw)", () => {
    vi.mocked(gitExec)
      .mockReturnValueOnce(makeOkResult("deadbeef00000000000000000000000000000000\n"))
      .mockReturnValueOnce(makeFailResult());

    const db = makeDb();
    expect(() => runGitIntelPipeline(db, "/fake/repo")).not.toThrow();
    db.close();
  });

  test("filters excluded files before computation", () => {
    const HEAD_SHA = "deadbeef00000000000000000000000000000000";
    const now = Math.floor(Date.now() / 1000);

    vi.mocked(gitExec)
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      .mockReturnValueOnce(
        makeOkResult(`COMMIT:${HEAD_SHA} ${now}\n\nsrc/foo.ts\npackage-lock.json\n`),
      );

    const db = makeDb();
    runGitIntelPipeline(db, "/fake/repo");

    const rows = db.prepare("SELECT file_path FROM hotspot_scores").all() as Array<{
      file_path: string;
    }>;
    const paths = rows.map((r) => r.file_path);
    expect(paths).not.toContain("package-lock.json");
    expect(paths).toContain("src/foo.ts");
    db.close();
  });

  test("persists hotspots and co-changes — both tables populated on success", () => {
    const HEAD_SHA = "cafebabe00000000000000000000000000000000";
    const now = Math.floor(Date.now() / 1000);

    const gitLogOutput = [
      `COMMIT:aaaa111111111111111111111111111111111111 ${now}`,
      "",
      "src/a.ts",
      "src/b.ts",
      "",
      `COMMIT:bbbb222222222222222222222222222222222222 ${now - 100}`,
      "",
      "src/a.ts",
      "src/b.ts",
      "",
    ].join("\n");

    vi.mocked(gitExec)
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      .mockReturnValueOnce(makeOkResult(gitLogOutput));

    const db = makeDb();
    runGitIntelPipeline(db, "/fake/repo");

    const hotspotCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM hotspot_scores").get() as { cnt: number }
    ).cnt;
    const coChangeCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM co_change_edges").get() as { cnt: number }
    ).cnt;

    expect(hotspotCount).toBe(2);
    expect(coChangeCount).toBe(1);
    db.close();
  });

  test("clears and repopulates tables on each run (empty repo produces empty tables)", () => {
    const HEAD_SHA = "feedface00000000000000000000000000000000";

    vi.mocked(gitExec)
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      .mockReturnValueOnce(makeOkResult("")); // Empty git log

    const db = makeDb();
    // Seed stale data first
    seedHotspot(db, "old-sha");
    runGitIntelPipeline(db, "/fake/repo");

    const hotspotCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM hotspot_scores").get() as { cnt: number }
    ).cnt;
    expect(hotspotCount).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// ensureGitIntelFresh
// ---------------------------------------------------------------------------

describe("ensureGitIntelFresh", () => {
  beforeEach(() => {
    vi.mocked(gitExec).mockReset();
  });

  test("calls runGitIntelPipeline when stale (empty DB)", () => {
    const HEAD_SHA = "1111111111111111111111111111111111111111";
    const now = Math.floor(Date.now() / 1000);

    vi.mocked(gitExec)
      // isGitIntelStale: rev-parse HEAD
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      // runGitIntelPipeline: rev-parse HEAD
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      // runGitIntelPipeline: git log
      .mockReturnValueOnce(makeOkResult(`COMMIT:${HEAD_SHA} ${now}\n\nsrc/app.ts\n`));

    const db = makeDb();
    ensureGitIntelFresh(db, "/fake/repo");

    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM hotspot_scores").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
    db.close();
  });

  test("is a no-op when fresh (HEAD matches stored SHA)", () => {
    const HEAD_SHA = "2222222222222222222222222222222222222222";

    vi.mocked(gitExec)
      // Only called once for isGitIntelStale's rev-parse
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"));

    const db = makeDb();
    seedHotspot(db, HEAD_SHA); // Data is fresh

    ensureGitIntelFresh(db, "/fake/repo");

    // gitExec should have been called only once (for the staleness check)
    expect(vi.mocked(gitExec)).toHaveBeenCalledTimes(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeGitIntel
// ---------------------------------------------------------------------------

describe("computeGitIntel", () => {
  beforeEach(() => {
    vi.mocked(gitExec).mockReset();
  });

  test("opens DB, runs pipeline, closes DB (end-to-end with tmp file)", () => {
    const HEAD_SHA = "3333333333333333333333333333333333333333";
    const now = Math.floor(Date.now() / 1000);

    vi.mocked(gitExec)
      // isGitIntelStale: rev-parse HEAD
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      // runGitIntelPipeline: rev-parse HEAD
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      // runGitIntelPipeline: git log
      .mockReturnValueOnce(makeOkResult(`COMMIT:${HEAD_SHA} ${now}\n\nsrc/main.ts\n`));

    const tmpDir = os.tmpdir();
    const dbPath = path.join(tmpDir, `test-git-intel-${Date.now()}.db`);

    try {
      computeGitIntel(dbPath, "/fake/repo");

      // Verify data was persisted to the file-backed DB
      const db = initDatabase(dbPath);
      const count = (
        db.prepare("SELECT COUNT(*) as cnt FROM hotspot_scores").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
      db.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(dbPath + suffix);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end: mock git log output -> verify both tables populated
// ---------------------------------------------------------------------------

describe("Full end-to-end pipeline", () => {
  beforeEach(() => {
    vi.mocked(gitExec).mockReset();
  });

  test("mock git log output populates hotspot_scores and co_change_edges", () => {
    const HEAD_SHA = "aaaa000000000000000000000000000000000000";
    const now = Math.floor(Date.now() / 1000);

    const gitLogOutput = [
      `COMMIT:aaaa001111111111111111111111111111111111 ${now}`,
      "",
      "src/alpha.ts",
      "src/beta.ts",
      "",
      `COMMIT:aaaa002222222222222222222222222222222222 ${now - 86400}`,
      "",
      "src/alpha.ts",
      "src/beta.ts",
      "",
      `COMMIT:aaaa003333333333333333333333333333333333 ${now - 86400 * 2}`,
      "",
      "src/gamma.ts",
      "",
    ].join("\n");

    vi.mocked(gitExec)
      .mockReturnValueOnce(makeOkResult(HEAD_SHA + "\n"))
      .mockReturnValueOnce(makeOkResult(gitLogOutput));

    const db = makeDb();
    runGitIntelPipeline(db, "/fake/repo");

    const hotspotRows = db
      .prepare("SELECT file_path, computed_at_commit FROM hotspot_scores ORDER BY file_path")
      .all() as Array<{ file_path: string; computed_at_commit: string }>;
    expect(hotspotRows).toHaveLength(3);
    const filePaths = hotspotRows.map((r) => r.file_path);
    expect(filePaths).toContain("src/alpha.ts");
    expect(filePaths).toContain("src/beta.ts");
    expect(filePaths).toContain("src/gamma.ts");

    // All rows stamped with HEAD SHA
    for (const row of hotspotRows) {
      expect(row.computed_at_commit).toBe(HEAD_SHA);
    }

    // co_change_edges: alpha-beta co-changed twice, Jaccard = 2/(2+2-2) = 1.0
    const coRows = db
      .prepare("SELECT file_a, file_b, co_commit_count FROM co_change_edges")
      .all() as Array<{ file_a: string; file_b: string; co_commit_count: number }>;
    expect(coRows).toHaveLength(1);
    expect(coRows[0].file_a).toBe("src/alpha.ts");
    expect(coRows[0].file_b).toBe("src/beta.ts");
    expect(coRows[0].co_commit_count).toBe(2);

    db.close();
  });
});
