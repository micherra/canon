/**
 * co-change-detector.test.ts
 *
 * Tests for computeCoChangePairs and persistCoChangeEdges.
 */

import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import {
  computeCoChangePairs,
  persistCoChangeEdges,
} from "../co-change-detector.ts";
import type { GitCommitRecord } from "../git-intel-types.ts";

// ---------------------------------------------------------------------------
// computeCoChangePairs
// ---------------------------------------------------------------------------

describe("computeCoChangePairs", () => {
  const config = { jaccardThreshold: 0.3 };

  test("returns empty array for no commits", () => {
    const result = computeCoChangePairs([], config);
    expect(result).toEqual([]);
  });

  test("returns empty array for single-file commits only", () => {
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: 1000, files: ["src/a.ts"] },
      { sha: "c2", timestamp: 2000, files: ["src/b.ts"] },
    ];
    const result = computeCoChangePairs(commits, config);
    expect(result).toEqual([]);
  });

  test("calculates correct Jaccard coefficient", () => {
    // a.ts and b.ts co-change in 2 commits; each appears in those 2 commits only
    // |A ∩ B| = 2, |A ∪ B| = |A| + |B| - |A ∩ B| = 2 + 2 - 2 = 2 → Jaccard = 1.0
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: 1000, files: ["src/a.ts", "src/b.ts"] },
      { sha: "c2", timestamp: 2000, files: ["src/a.ts", "src/b.ts"] },
    ];
    const result = computeCoChangePairs(commits, { jaccardThreshold: 0.0 });
    expect(result).toHaveLength(1);
    expect(result[0].jaccard).toBeCloseTo(1.0, 5);
    expect(result[0].coCommitCount).toBe(2);
  });

  test("calculates partial overlap Jaccard correctly", () => {
    // a.ts appears in c1, c2, c3
    // b.ts appears in c1, c2
    // co-commit count = 2
    // |A| = 3, |B| = 2, |A ∩ B| = 2 → Jaccard = 2 / (3 + 2 - 2) = 2/3
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: 1000, files: ["src/a.ts", "src/b.ts"] },
      { sha: "c2", timestamp: 2000, files: ["src/a.ts", "src/b.ts"] },
      { sha: "c3", timestamp: 3000, files: ["src/a.ts"] },
    ];
    const result = computeCoChangePairs(commits, { jaccardThreshold: 0.0 });
    expect(result).toHaveLength(1);
    expect(result[0].jaccard).toBeCloseTo(2 / 3, 4);
  });

  test("filters pairs below jaccardThreshold", () => {
    // Low overlap: a.ts appears in 4 commits, b.ts in 4 commits, they co-appear in 1
    // |A| = 4, |B| = 4, |A ∩ B| = 1 → Jaccard = 1/(4+4-1) = 1/7 ≈ 0.143
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: 1000, files: ["src/a.ts", "src/b.ts"] },
      { sha: "c2", timestamp: 2000, files: ["src/a.ts", "src/c.ts"] },
      { sha: "c3", timestamp: 3000, files: ["src/a.ts", "src/d.ts"] },
      { sha: "c4", timestamp: 4000, files: ["src/a.ts", "src/e.ts"] },
      { sha: "c5", timestamp: 5000, files: ["src/b.ts", "src/f.ts"] },
      { sha: "c6", timestamp: 6000, files: ["src/b.ts", "src/g.ts"] },
      { sha: "c7", timestamp: 7000, files: ["src/b.ts", "src/h.ts"] },
    ];
    // With threshold 0.3, pair (a,b) with Jaccard ≈ 0.143 should be filtered out
    const result = computeCoChangePairs(commits, { jaccardThreshold: 0.3 });
    const abPair = result.find(
      (p) =>
        (p.fileA === "src/a.ts" && p.fileB === "src/b.ts") ||
        (p.fileA === "src/b.ts" && p.fileB === "src/a.ts")
    );
    expect(abPair).toBeUndefined();
  });

  test("normalizes pair ordering so (a,b) and (b,a) are treated the same", () => {
    // Two commits each with both files — order varies
    const commits: GitCommitRecord[] = [
      { sha: "c1", timestamp: 1000, files: ["src/b.ts", "src/a.ts"] },
      { sha: "c2", timestamp: 2000, files: ["src/a.ts", "src/b.ts"] },
    ];
    const result = computeCoChangePairs(commits, { jaccardThreshold: 0.0 });
    // Should produce exactly one pair
    expect(result).toHaveLength(1);
    // fileA should be alphabetically less than fileB
    expect(result[0].fileA <= result[0].fileB).toBe(true);
    expect(result[0].coCommitCount).toBe(2);
  });

  test("skips commits with more than 50 files to avoid O(n^2) explosion", () => {
    // Create a commit with 51 files plus a normal commit
    const manyFiles = Array.from({ length: 51 }, (_, i) => `src/file${i}.ts`);
    const commits: GitCommitRecord[] = [
      { sha: "huge", timestamp: 1000, files: manyFiles },
      { sha: "normal", timestamp: 2000, files: ["src/a.ts", "src/b.ts"] },
    ];
    const result = computeCoChangePairs(commits, { jaccardThreshold: 0.0 });
    // Only the normal commit contributes; Jaccard = 1.0 for (a,b)
    expect(result).toHaveLength(1);
    expect(result[0].fileA).toBe("src/a.ts");
    expect(result[0].fileB).toBe("src/b.ts");
    expect(result[0].coCommitCount).toBe(1);
  });

  test("handles exactly 50 files commit (boundary — should NOT be skipped)", () => {
    const exactlyFifty = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
    const commits: GitCommitRecord[] = [
      { sha: "boundary", timestamp: 1000, files: exactlyFifty },
    ];
    const result = computeCoChangePairs(commits, { jaccardThreshold: 0.0 });
    // C(50, 2) = 1225 pairs; all should be present with Jaccard 1.0
    expect(result).toHaveLength(50 * 49 / 2);
  });
});

// ---------------------------------------------------------------------------
// persistCoChangeEdges
// ---------------------------------------------------------------------------

describe("persistCoChangeEdges", () => {
  const makeDb = (): Database.Database => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE co_change_edges (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        co_commit_count INTEGER NOT NULL,
        jaccard REAL NOT NULL,
        computed_at_commit TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (file_a, file_b)
      )
    `);
    return db;
  };

  test("inserts co-change pairs", () => {
    const db = makeDb();
    const pairs = [
      { fileA: "src/a.ts", fileB: "src/b.ts", coCommitCount: 3, jaccard: 0.75 },
    ];
    const tx = db.transaction(() => persistCoChangeEdges(db, pairs, "sha1"));
    tx();
    const count = (db.prepare("SELECT COUNT(*) as c FROM co_change_edges").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("replaces existing data when called again", () => {
    const db = makeDb();
    const pairsV1 = [
      { fileA: "src/a.ts", fileB: "src/b.ts", coCommitCount: 2, jaccard: 0.5 },
      { fileA: "src/b.ts", fileB: "src/c.ts", coCommitCount: 1, jaccard: 0.33 },
    ];
    db.transaction(() => persistCoChangeEdges(db, pairsV1, "sha1"))();

    const count1 = (db.prepare("SELECT COUNT(*) as c FROM co_change_edges").get() as { c: number }).c;
    expect(count1).toBe(2);

    // Replace with different data
    const pairsV2 = [
      { fileA: "src/x.ts", fileB: "src/y.ts", coCommitCount: 5, jaccard: 0.8 },
    ];
    db.transaction(() => persistCoChangeEdges(db, pairsV2, "sha2"))();

    const count2 = (db.prepare("SELECT COUNT(*) as c FROM co_change_edges").get() as { c: number }).c;
    expect(count2).toBe(1);
    const row = db.prepare("SELECT file_a, file_b FROM co_change_edges").get() as { file_a: string; file_b: string };
    expect(row.file_a).toBe("src/x.ts");
    expect(row.file_b).toBe("src/y.ts");
  });

  test("stores computed_at_commit from parameter", () => {
    const db = makeDb();
    const pairs = [
      { fileA: "src/a.ts", fileB: "src/b.ts", coCommitCount: 1, jaccard: 0.5 },
    ];
    db.transaction(() => persistCoChangeEdges(db, pairs, "commit-sha-xyz"))();
    const row = db.prepare("SELECT computed_at_commit FROM co_change_edges").get() as { computed_at_commit: string };
    expect(row.computed_at_commit).toBe("commit-sha-xyz");
  });

  test("does not create its own transaction (bare statements)", () => {
    // Calling outside any explicit transaction should succeed
    const db = makeDb();
    expect(() =>
      persistCoChangeEdges(
        db,
        [{ fileA: "src/a.ts", fileB: "src/b.ts", coCommitCount: 1, jaccard: 0.5 }],
        "sha"
      )
    ).not.toThrow();
  });

  test("handles empty pairs array — just deletes all existing data", () => {
    const db = makeDb();
    // Insert some data first
    db.exec(`INSERT INTO co_change_edges VALUES ('a', 'b', 1, 0.5, 'sha', '2024-01-01')`);
    db.transaction(() => persistCoChangeEdges(db, [], "sha2"))();
    const count = (db.prepare("SELECT COUNT(*) as c FROM co_change_edges").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
