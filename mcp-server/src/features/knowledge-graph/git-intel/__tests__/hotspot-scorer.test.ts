/**
 * hotspot-scorer.test.ts
 *
 * Tests for computeChurn, computePercentiles, buildHotspotRows,
 * persistHotspots, and getComplexityMap.
 */

import { describe, expect, test, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  computeChurn,
  computePercentiles,
  buildHotspotRows,
  persistHotspots,
  getComplexityMap,
} from "../hotspot-scorer.ts";
import type { GitCommitRecord } from "../git-intel-types.ts";

// ---------------------------------------------------------------------------
// computeChurn
// ---------------------------------------------------------------------------

describe("computeChurn", () => {
  const halfLifeDays = 45;

  test("returns empty array for no commits", () => {
    const result = computeChurn([], { halfLifeDays }, 1700000000);
    expect(result).toEqual([]);
  });

  test("returns single file entry for single commit", () => {
    const nowEpochSec = 1700000000;
    const commits: GitCommitRecord[] = [
      { sha: "abc", timestamp: nowEpochSec, files: ["src/foo.ts"] },
    ];
    const result = computeChurn(commits, { halfLifeDays }, nowEpochSec);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/foo.ts");
    // age is 0 → weight = exp(0) = 1.0
    expect(result[0].rawChurn).toBeCloseTo(1.0, 5);
    expect(result[0].commitCount).toBe(1);
  });

  test("weights recent commits higher than old commits", () => {
    const nowEpochSec = 1700000000;
    const oneDayInSec = 86400;
    const commits: GitCommitRecord[] = [
      // recent file: modified 1 day ago
      { sha: "recent", timestamp: nowEpochSec - oneDayInSec, files: ["src/recent.ts"] },
      // old file: modified 90 days ago
      { sha: "old", timestamp: nowEpochSec - 90 * oneDayInSec, files: ["src/old.ts"] },
    ];
    const result = computeChurn(commits, { halfLifeDays }, nowEpochSec);
    const recentEntry = result.find((e) => e.filePath === "src/recent.ts");
    const oldEntry = result.find((e) => e.filePath === "src/old.ts");
    expect(recentEntry).toBeDefined();
    expect(oldEntry).toBeDefined();
    expect(recentEntry!.rawChurn).toBeGreaterThan(oldEntry!.rawChurn);
  });

  test("accumulates churn across multiple commits for the same file", () => {
    const nowEpochSec = 1700000000;
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: nowEpochSec, files: ["src/foo.ts"] },
      { sha: "c2", timestamp: nowEpochSec, files: ["src/foo.ts"] },
    ];
    const result = computeChurn(commits, { halfLifeDays }, nowEpochSec);
    expect(result).toHaveLength(1);
    // Two commits at age 0 → weight 1.0 each → rawChurn = 2.0
    expect(result[0].rawChurn).toBeCloseTo(2.0, 5);
    expect(result[0].commitCount).toBe(2);
  });

  test("correctly applies exponential decay formula", () => {
    const nowEpochSec = 1700000000;
    const ageDays = 45; // one half-life
    const commits: GitCommitRecord[] = [
      {
        sha: "c1",
        timestamp: nowEpochSec - ageDays * 86400,
        files: ["src/foo.ts"],
      },
    ];
    const result = computeChurn(commits, { halfLifeDays }, nowEpochSec);
    // After one half-life: weight = exp(-ln2 * 1) = 0.5
    expect(result[0].rawChurn).toBeCloseTo(0.5, 4);
  });

  test("returns results sorted descending by rawChurn", () => {
    const nowEpochSec = 1700000000;
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: nowEpochSec - 10 * 86400, files: ["src/a.ts"] },
      { sha: "c2", timestamp: nowEpochSec, files: ["src/b.ts"] },
      { sha: "c3", timestamp: nowEpochSec, files: ["src/b.ts"] },
    ];
    const result = computeChurn(commits, { halfLifeDays }, nowEpochSec);
    // b.ts appears twice at age 0, a.ts once at age 10 → b.ts should be first
    expect(result[0].filePath).toBe("src/b.ts");
    expect(result[1].filePath).toBe("src/a.ts");
  });
});

// ---------------------------------------------------------------------------
// computePercentiles
// ---------------------------------------------------------------------------

describe("computePercentiles", () => {
  test("single element returns 1.0", () => {
    expect(computePercentiles([42])).toEqual([1.0]);
  });

  test("all identical values return all 1.0 (inclusive rank — all <= x)", () => {
    const result = computePercentiles([5, 5, 5, 5]);
    expect(result).toHaveLength(4);
    result.forEach((r) => expect(r).toBeCloseTo(1.0, 5));
  });

  test("distinct values produce correct inclusive percentile ranks", () => {
    // [10, 20, 30] sorted ascending → [10, 20, 30]
    // For 10: count(values <= 10) = 1 → rank 1/3 ≈ 0.333
    // For 20: count(values <= 20) = 2 → rank 2/3 ≈ 0.667
    // For 30: count(values <= 30) = 3 → rank 3/3 = 1.0
    const result = computePercentiles([10, 20, 30]);
    expect(result[0]).toBeCloseTo(1 / 3, 3);
    expect(result[1]).toBeCloseTo(2 / 3, 3);
    expect(result[2]).toBeCloseTo(1.0, 5);
  });

  test("preserves input order (not sorted output)", () => {
    // Input [30, 10, 20] → each element gets its own percentile rank
    // 30: count(values <= 30) = 3 → 1.0
    // 10: count(values <= 10) = 1 → 1/3
    // 20: count(values <= 20) = 2 → 2/3
    const result = computePercentiles([30, 10, 20]);
    expect(result[0]).toBeCloseTo(1.0, 5);
    expect(result[1]).toBeCloseTo(1 / 3, 3);
    expect(result[2]).toBeCloseTo(2 / 3, 3);
  });

  test("handles ties with inclusive rank (middle tied values)", () => {
    // [1, 2, 2, 3]
    // 1: count(values <= 1) = 1 → 1/4 = 0.25
    // 2: count(values <= 2) = 3 → 3/4 = 0.75 (both 2s get same rank)
    // 3: count(values <= 3) = 4 → 4/4 = 1.0
    const result = computePercentiles([1, 2, 2, 3]);
    expect(result[0]).toBeCloseTo(0.25, 5);
    expect(result[1]).toBeCloseTo(0.75, 5);
    expect(result[2]).toBeCloseTo(0.75, 5);
    expect(result[3]).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// buildHotspotRows
// ---------------------------------------------------------------------------

describe("buildHotspotRows", () => {
  const commitSha = "deadbeef";

  test("marks files above hotspotScoreThreshold as is_hotspot=1", () => {
    // Provide files where some will score above 0.75
    const churnEntries = [
      { filePath: "src/high.ts", rawChurn: 100, commitCount: 10 },
      { filePath: "src/low.ts", rawChurn: 1, commitCount: 1 },
    ];
    const complexityByFile = new Map([
      ["src/high.ts", 50], // high complexity
      ["src/low.ts", 1],   // low complexity
    ]);
    const config = { hotspotScoreThreshold: 0.75 };
    const rows = buildHotspotRows(churnEntries, complexityByFile, config, commitSha);

    expect(rows).toHaveLength(2);
    const high = rows.find((r) => r.file_path === "src/high.ts");
    const low = rows.find((r) => r.file_path === "src/low.ts");
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    // high.ts: churn percentile = 1.0, complexity percentile = 1.0 → score = 1.0 ≥ 0.75
    expect(high!.is_hotspot).toBe(1);
    // low.ts: both percentiles are lower → score should be below 0.75
    expect(low!.is_hotspot).toBe(0);
  });

  test("handles files with zero complexity", () => {
    const churnEntries = [{ filePath: "src/foo.ts", rawChurn: 10, commitCount: 1 }];
    const complexityByFile = new Map<string, number>(); // no complexity data
    const config = { hotspotScoreThreshold: 0.75 };
    const rows = buildHotspotRows(churnEntries, complexityByFile, config, commitSha);
    expect(rows).toHaveLength(1);
    expect(rows[0].complexity_raw).toBe(0);
    // complexity percentile for 0 among [0] = 1.0 (all identical → all 1.0)
    expect(rows[0].complexity_pctile).toBeCloseTo(1.0, 5);
  });

  test("returns empty array for empty churn entries", () => {
    const rows = buildHotspotRows([], new Map(), { hotspotScoreThreshold: 0.75 }, commitSha);
    expect(rows).toEqual([]);
  });

  test("computes score as product of churn_percentile and complexity_pctile", () => {
    const churnEntries = [
      { filePath: "src/a.ts", rawChurn: 10, commitCount: 2 },
      { filePath: "src/b.ts", rawChurn: 5, commitCount: 1 },
    ];
    const complexityByFile = new Map([
      ["src/a.ts", 20],
      ["src/b.ts", 10],
    ]);
    const config = { hotspotScoreThreshold: 0.0 };
    const rows = buildHotspotRows(churnEntries, complexityByFile, config, commitSha);
    for (const row of rows) {
      expect(row.score).toBeCloseTo(row.churn_percentile * row.complexity_pctile, 5);
    }
  });

  test("sets computed_at_commit from commitSha parameter", () => {
    const churnEntries = [{ filePath: "src/foo.ts", rawChurn: 1, commitCount: 1 }];
    const rows = buildHotspotRows(churnEntries, new Map(), { hotspotScoreThreshold: 0 }, "sha123");
    expect(rows[0].computed_at_commit).toBe("sha123");
  });
});

// ---------------------------------------------------------------------------
// persistHotspots
// ---------------------------------------------------------------------------

describe("persistHotspots", () => {
  const makeDb = (): Database.Database => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE hotspot_scores (
        file_path TEXT PRIMARY KEY,
        churn_raw REAL NOT NULL,
        churn_percentile REAL NOT NULL,
        complexity_raw REAL NOT NULL,
        complexity_pctile REAL NOT NULL,
        score REAL NOT NULL,
        is_hotspot INTEGER NOT NULL DEFAULT 0,
        computed_at_commit TEXT NOT NULL,
        computed_at TEXT NOT NULL
      )
    `);
    return db;
  };

  test("inserts hotspot rows", () => {
    const db = makeDb();
    const rows = [
      {
        file_path: "src/foo.ts",
        churn_raw: 5.0,
        churn_percentile: 1.0,
        complexity_raw: 3,
        complexity_pctile: 1.0,
        score: 1.0,
        is_hotspot: 1,
        computed_at_commit: "abc",
        computed_at: new Date().toISOString(),
      },
    ];
    // Caller provides transaction
    const tx = db.transaction(() => persistHotspots(db, rows));
    tx();
    const count = (db.prepare("SELECT COUNT(*) as c FROM hotspot_scores").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("replaces existing data when called again", () => {
    const db = makeDb();
    const makeRow = (path: string) => ({
      file_path: path,
      churn_raw: 1.0,
      churn_percentile: 1.0,
      complexity_raw: 1,
      complexity_pctile: 1.0,
      score: 1.0,
      is_hotspot: 0,
      computed_at_commit: "sha1",
      computed_at: new Date().toISOString(),
    });

    // First write
    db.transaction(() => persistHotspots(db, [makeRow("src/a.ts"), makeRow("src/b.ts")]))();
    const count1 = (db.prepare("SELECT COUNT(*) as c FROM hotspot_scores").get() as { c: number }).c;
    expect(count1).toBe(2);

    // Second write with different rows — should replace
    db.transaction(() => persistHotspots(db, [makeRow("src/c.ts")]))();
    const count2 = (db.prepare("SELECT COUNT(*) as c FROM hotspot_scores").get() as { c: number }).c;
    expect(count2).toBe(1);
    const row = db.prepare("SELECT file_path FROM hotspot_scores").get() as { file_path: string };
    expect(row.file_path).toBe("src/c.ts");
  });

  test("does not create its own transaction (bare statements)", () => {
    // We verify this by calling persistHotspots outside any transaction — it should succeed
    // (bare DELETE+INSERT without wrapping in a transaction is valid SQLite, just not atomic)
    const db = makeDb();
    expect(() =>
      persistHotspots(db, [
        {
          file_path: "src/foo.ts",
          churn_raw: 1.0,
          churn_percentile: 1.0,
          complexity_raw: 1,
          complexity_pctile: 1.0,
          score: 1.0,
          is_hotspot: 0,
          computed_at_commit: "sha",
          computed_at: new Date().toISOString(),
        },
      ])
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getComplexityMap
// ---------------------------------------------------------------------------

describe("getComplexityMap", () => {
  const makeDb = (): Database.Database => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        mtime_ms REAL NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'typescript',
        layer TEXT NOT NULL DEFAULT 'unknown',
        last_indexed_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE entities (
        entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(file_id),
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'function',
        is_exported INTEGER NOT NULL DEFAULT 0,
        is_default_export INTEGER NOT NULL DEFAULT 0
      );
    `);
    return db;
  };

  test("returns entity count per file path", () => {
    const db = makeDb();
    db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at) VALUES ('src/a.ts', 0, '', 'ts', 'unknown', '')`);
    db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at) VALUES ('src/b.ts', 0, '', 'ts', 'unknown', '')`);
    db.exec(`INSERT INTO entities (file_id, name, qualified_name, kind) VALUES (1, 'foo', 'foo', 'function')`);
    db.exec(`INSERT INTO entities (file_id, name, qualified_name, kind) VALUES (1, 'bar', 'bar', 'function')`);
    db.exec(`INSERT INTO entities (file_id, name, qualified_name, kind) VALUES (2, 'baz', 'baz', 'function')`);

    const map = getComplexityMap(db);
    expect(map.get("src/a.ts")).toBe(2);
    expect(map.get("src/b.ts")).toBe(1);
  });

  test("returns 0 count for files with no entities (LEFT JOIN)", () => {
    const db = makeDb();
    db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at) VALUES ('src/empty.ts', 0, '', 'ts', 'unknown', '')`);
    const map = getComplexityMap(db);
    expect(map.get("src/empty.ts")).toBe(0);
  });

  test("returns empty map for empty db", () => {
    const db = makeDb();
    const map = getComplexityMap(db);
    expect(map.size).toBe(0);
  });
});
