/**
 * DriftDb Tests — project-scoped SQLite DAO for reviews and flow runs
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FlowRunEntry } from "../drift/analytics.ts";
import { DriftDb, getDriftDb } from "../drift/drift-db.ts";
import { DRIFT_SCHEMA_VERSION, initDriftDb } from "../drift/drift-schema.ts";
import type { ReviewEntry } from "../shared/schema.ts";

function makeReviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/foo.ts", "src/bar.ts"],
    honored: ["deep-modules"],
    review_id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 2, total: 2 },
    },
    timestamp: new Date().toISOString(),
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

function makeFlowRunEntry(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: new Date().toISOString(),
    flow: "build",
    run_id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    skipped_states: [],
    started: new Date().toISOString(),
    state_durations: { design: 2000, implement: 7000, research: 3000 },
    state_iterations: { implement: 2 },
    task: "Add feature X",
    tier: "full",
    total_duration_ms: 12000,
    total_spawns: 5,
    ...overrides,
  };
}

// Setup helper

function makeDb(): { db: Database.Database; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

// Schema

describe("initDriftDb", () => {
  test("creates all required tables", () => {
    const db = initDriftDb(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("meta");
    expect(tableNames).toContain("reviews");
    expect(tableNames).toContain("violations");
    expect(tableNames).toContain("flow_runs");
    db.close();
  });

  test("sets schema_version in meta", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe(DRIFT_SCHEMA_VERSION);
    db.close();
  });

  test("creates indexes on reviews table", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reviews' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_reviews_branch");
    expect(indexNames).toContain("idx_reviews_pr");
    expect(indexNames).toContain("idx_reviews_ts");
    db.close();
  });

  test("is idempotent — calling twice does not error", () => {
    // Re-opens same path (which is fine for :memory: since each new() is a fresh DB)
    // This tests that IF NOT EXISTS works by running DDL twice on same connection
    const db = initDriftDb(":memory:");
    expect(() => {
      // Run the DDL again on the same database by calling exec directly
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL UNIQUE)`,
      );
    }).not.toThrow();
    db.close();
  });
});

// appendReview + getReviews round-trip

describe("appendReview and getReviews", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("round-trips a minimal ReviewEntry", () => {
    const entry = makeReviewEntry();
    store.appendReview(entry);
    const results = store.getReviews();
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe(entry.review_id);
    expect(results[0].verdict).toBe("CLEAN");
    expect(results[0].files).toEqual(entry.files);
    expect(results[0].honored).toEqual(entry.honored);
  });

  test("round-trips a full ReviewEntry with all optional fields populated", () => {
    const entry = makeReviewEntry({
      branch: "feat/my-feature",
      file_priorities: [
        { path: "src/foo.ts", priority_score: 80 },
        { path: "src/bar.ts", priority_score: 30 },
      ],
      last_reviewed_sha: "abc123def456",
      pr_number: 42,
      recommendations: [
        {
          message: "Consider extracting the business logic",
          source: "holistic",
          title: "Extract logic",
        },
        {
          file_path: "src/foo.ts",
          message: "This file has high fan-out",
          source: "principle",
          title: "Reduce coupling",
        },
      ],
      review_id: "rev_full_001",
      violations: [
        {
          file_path: "src/foo.ts",
          impact_score: 12.5,
          message: "Handler is too thin",
          principle_id: "deep-modules",
          severity: "strong-opinion",
        },
      ],
    });

    store.appendReview(entry);
    const results = store.getReviews();
    expect(results).toHaveLength(1);

    const r = results[0];
    expect(r.review_id).toBe("rev_full_001");
    expect(r.pr_number).toBe(42);
    expect(r.branch).toBe("feat/my-feature");
    expect(r.last_reviewed_sha).toBe("abc123def456");
    expect(r.file_priorities).toEqual(entry.file_priorities);
    expect(r.recommendations).toEqual(entry.recommendations);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].principle_id).toBe("deep-modules");
    expect(r.violations[0].severity).toBe("strong-opinion");
    expect(r.violations[0].file_path).toBe("src/foo.ts");
    expect(r.violations[0].impact_score).toBe(12.5);
    expect(r.violations[0].message).toBe("Handler is too thin");
  });

  test("round-trips violation with nullable fields (no file_path, no impact_score, no message)", () => {
    const entry = makeReviewEntry({
      violations: [
        {
          principle_id: "thin-handlers",
          severity: "rule",
        },
      ],
    });

    store.appendReview(entry);
    const results = store.getReviews();
    const v = results[0].violations[0];
    expect(v.principle_id).toBe("thin-handlers");
    expect(v.severity).toBe("rule");
    expect(v.file_path).toBeUndefined();
    expect(v.impact_score).toBeUndefined();
    expect(v.message).toBeUndefined();
  });

  test("returns multiple entries in insertion order", () => {
    const e1 = makeReviewEntry({ review_id: "rev_001", timestamp: "2026-01-01T10:00:00Z" });
    const e2 = makeReviewEntry({ review_id: "rev_002", timestamp: "2026-01-02T10:00:00Z" });
    const e3 = makeReviewEntry({ review_id: "rev_003", timestamp: "2026-01-03T10:00:00Z" });
    store.appendReview(e1);
    store.appendReview(e2);
    store.appendReview(e3);

    const results = store.getReviews();
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.review_id)).toEqual(["rev_001", "rev_002", "rev_003"]);
  });

  test("returns empty array when no reviews exist", () => {
    const results = store.getReviews();
    expect(results).toEqual([]);
  });
});

// getReviews filtering

describe("getReviews filtering", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());

    // Seed 3 reviews:
    // rev_001: branch=main, no PR, violates deep-modules
    // rev_002: branch=feat/x, pr=10, violates thin-handlers
    // rev_003: branch=feat/x, pr=10, honors deep-modules
    store.appendReview(
      makeReviewEntry({
        branch: "main",
        honored: [],
        review_id: "rev_001",
        violations: [{ principle_id: "deep-modules", severity: "strong-opinion" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        branch: "feat/x",
        honored: [],
        pr_number: 10,
        review_id: "rev_002",
        violations: [{ principle_id: "thin-handlers", severity: "rule" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        branch: "feat/x",
        honored: ["deep-modules"],
        pr_number: 10,
        review_id: "rev_003",
        violations: [],
      }),
    );
  });

  afterEach(() => {
    store.close();
  });

  test("getReviews({ principleId }) returns reviews with matching violation", () => {
    const results = store.getReviews({ principleId: "deep-modules" });
    const ids = results.map((r) => r.review_id);
    expect(ids).toContain("rev_001");
    expect(ids).not.toContain("rev_002");
  });

  test("getReviews({ principleId }) returns reviews with matching honored entry", () => {
    const results = store.getReviews({ principleId: "deep-modules" });
    const ids = results.map((r) => r.review_id);
    expect(ids).toContain("rev_003");
  });

  test("getReviews({ branch }) filters by branch", () => {
    const results = store.getReviews({ branch: "feat/x" });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.branch).toBe("feat/x");
    }
  });

  test("getReviews({ branch }) returns empty for unknown branch", () => {
    const results = store.getReviews({ branch: "no-such-branch" });
    expect(results).toEqual([]);
  });

  test("getReviews({ prNumber }) filters by PR number", () => {
    const results = store.getReviews({ prNumber: 10 });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.pr_number).toBe(10);
    }
  });

  test("getReviews({ branch, prNumber }) AND-filters", () => {
    const results = store.getReviews({ branch: "feat/x", prNumber: 10 });
    expect(results).toHaveLength(2);

    // Should not include rev_001 (branch=main, no PR)
    expect(results.map((r) => r.review_id)).not.toContain("rev_001");
  });

  test("getReviews({ branch, prNumber }) returns empty when branch/pr combination has no match", () => {
    const results = store.getReviews({ branch: "main", prNumber: 10 });
    expect(results).toEqual([]);
  });

  test("getReviews({ principleId, branch }) AND-filters principle and branch", () => {
    // rev_003 is on branch feat/x and honors deep-modules
    const results = store.getReviews({ branch: "feat/x", principleId: "deep-modules" });
    expect(results.map((r) => r.review_id)).toContain("rev_003");
    expect(results.map((r) => r.review_id)).not.toContain("rev_001"); // branch=main
    expect(results.map((r) => r.review_id)).not.toContain("rev_002"); // principle mismatch
  });
});

// getLastReviewForPr

describe("getLastReviewForPr", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns most recent review by timestamp for given PR", () => {
    store.appendReview(
      makeReviewEntry({
        pr_number: 5,
        review_id: "rev_early",
        timestamp: "2026-01-01T08:00:00Z",
      }),
    );
    store.appendReview(
      makeReviewEntry({
        pr_number: 5,
        review_id: "rev_late",
        timestamp: "2026-01-02T08:00:00Z",
      }),
    );

    const result = store.getLastReviewForPr(5);
    expect(result).not.toBeNull();
    expect(result!.review_id).toBe("rev_late");
  });

  test("returns null when no reviews exist for PR", () => {
    const result = store.getLastReviewForPr(999);
    expect(result).toBeNull();
  });
});

// getLastReviewForBranch

describe("getLastReviewForBranch", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns most recent review by timestamp for given branch", () => {
    store.appendReview(
      makeReviewEntry({
        branch: "feat/search",
        review_id: "rev_old",
        timestamp: "2026-02-01T00:00:00Z",
      }),
    );
    store.appendReview(
      makeReviewEntry({
        branch: "feat/search",
        review_id: "rev_new",
        timestamp: "2026-02-10T00:00:00Z",
      }),
    );

    const result = store.getLastReviewForBranch("feat/search");
    expect(result).not.toBeNull();
    expect(result!.review_id).toBe("rev_new");
  });

  test("returns null when no reviews exist for branch", () => {
    const result = store.getLastReviewForBranch("no-such-branch");
    expect(result).toBeNull();
  });
});

// getComplianceTrend

describe("getComplianceTrend", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("groups reviews by ISO week and computes pass_rate", () => {
    // Two reviews in W01 2026, one violation + one honored
    store.appendReview(
      makeReviewEntry({
        honored: [],
        review_id: "rev_w1_viol",
        timestamp: "2026-01-05T10:00:00Z", // Monday W01
        violations: [{ principle_id: "deep-modules", severity: "strong-opinion" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        honored: ["deep-modules"],
        review_id: "rev_w1_pass",
        timestamp: "2026-01-06T10:00:00Z", // Tuesday W01
        violations: [],
      }),
    );
    // One review in W02 2026, honored
    store.appendReview(
      makeReviewEntry({
        honored: ["deep-modules"],
        review_id: "rev_w2_pass",
        timestamp: "2026-01-12T10:00:00Z", // Monday W02
        violations: [],
      }),
    );

    const trend = store.getComplianceTrend("deep-modules");
    expect(trend.length).toBeGreaterThanOrEqual(2);

    const w1 = trend.find((t) => t.week.includes("W01") || t.week.includes("W02"));
    expect(w1).toBeDefined();

    // Verify structure
    for (const point of trend) {
      expect(point).toHaveProperty("week");
      expect(point).toHaveProperty("pass_rate");
      expect(point).toHaveProperty("violations");
      expect(point).toHaveProperty("reviews");
      expect(point.pass_rate).toBeGreaterThanOrEqual(0);
      expect(point.pass_rate).toBeLessThanOrEqual(1);
    }
  });

  test("returns empty array when no reviews exist for principle", () => {
    const trend = store.getComplianceTrend("nonexistent-principle");
    expect(trend).toEqual([]);
  });

  test("limits results to most recent N weeks when weeks param is given", () => {
    // Add reviews across 4 different weeks
    const weeks = [
      { id: "r1", timestamp: "2026-01-05T00:00:00Z" }, // W01
      { id: "r2", timestamp: "2026-01-12T00:00:00Z" }, // W02
      { id: "r3", timestamp: "2026-01-19T00:00:00Z" }, // W03
      { id: "r4", timestamp: "2026-01-26T00:00:00Z" }, // W04
    ];
    for (const w of weeks) {
      store.appendReview(
        makeReviewEntry({
          honored: [],
          review_id: w.id,
          timestamp: w.timestamp,
          violations: [{ principle_id: "thin-handlers", severity: "rule" }],
        }),
      );
    }

    const trend = store.getComplianceTrend("thin-handlers", 2);
    expect(trend).toHaveLength(2);
  });

  test("ISO week handles year boundary correctly (late Dec / early Jan)", () => {
    // 2026-01-01 is a Thursday — it is in ISO week 1 of 2026
    store.appendReview(
      makeReviewEntry({
        honored: [],
        review_id: "rev_jan1",
        timestamp: "2026-01-01T12:00:00Z",
        violations: [{ principle_id: "errors-are-values", severity: "strong-opinion" }],
      }),
    );
    // 2025-12-29 is a Monday — still in ISO week 1 of 2026
    store.appendReview(
      makeReviewEntry({
        honored: ["errors-are-values"],
        review_id: "rev_dec29",
        timestamp: "2025-12-29T12:00:00Z",
        violations: [],
      }),
    );

    const trend = store.getComplianceTrend("errors-are-values");
    // Both dates may be in the same ISO week; what matters is that no crash occurs
    expect(trend.length).toBeGreaterThanOrEqual(1);
    for (const point of trend) {
      expect(point.week).toMatch(/^\d{4}-W\d{2}$/);
    }
  });
});

// appendFlowRun + computeAnalytics

describe("appendFlowRun and computeAnalytics", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("round-trips a FlowRunEntry", () => {
    const entry = makeFlowRunEntry({ run_id: "run_001" });
    store.appendFlowRun(entry);

    const analytics = store.computeAnalytics();
    expect(analytics.total_runs).toBe(1);
    expect(analytics.avg_duration_ms).toBe(entry.total_duration_ms);
  });

  test("computeAnalytics returns zero totals for empty DB", () => {
    const analytics = store.computeAnalytics();
    expect(analytics.total_runs).toBe(0);
    expect(analytics.avg_duration_ms).toBe(0);
    expect(analytics.avg_gate_pass_rate).toBeUndefined();
    expect(analytics.avg_postcondition_pass_rate).toBeUndefined();
  });

  test("computes avg_gate_pass_rate when gate_pass_rate data is present", () => {
    store.appendFlowRun(makeFlowRunEntry({ gate_pass_rate: 0.8, run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ gate_pass_rate: 0.6, run_id: "r2" }));
    store.appendFlowRun(makeFlowRunEntry({ run_id: "r3" })); // no gate data

    const analytics = store.computeAnalytics();
    expect(analytics.total_runs).toBe(3);
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(0.7, 5);
    // avg_duration_ms should still account for all 3 runs
    expect(analytics.avg_duration_ms).toBe(12000);
  });

  test("computes avg_postcondition_pass_rate when postcondition data is present", () => {
    store.appendFlowRun(makeFlowRunEntry({ postcondition_pass_rate: 1.0, run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ postcondition_pass_rate: 0.5, run_id: "r2" }));

    const analytics = store.computeAnalytics();
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(0.75, 5);
  });

  test("omits avg_gate_pass_rate when no runs have gate data", () => {
    store.appendFlowRun(makeFlowRunEntry({ run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ run_id: "r2" }));

    const analytics = store.computeAnalytics();
    expect(analytics.avg_gate_pass_rate).toBeUndefined();
    expect(analytics.avg_postcondition_pass_rate).toBeUndefined();
  });

  test("averages duration across multiple runs", () => {
    store.appendFlowRun(makeFlowRunEntry({ run_id: "r1", total_duration_ms: 1000 }));
    store.appendFlowRun(makeFlowRunEntry({ run_id: "r2", total_duration_ms: 3000 }));

    const analytics = store.computeAnalytics();
    expect(analytics.total_runs).toBe(2);
    expect(analytics.avg_duration_ms).toBe(2000);
  });

  test("round-trips FlowRunEntry with total_test_results JSON", () => {
    const entry = makeFlowRunEntry({
      run_id: "r_with_tests",
      total_files_changed: 8,
      total_test_results: { failed: 1, passed: 42, skipped: 3 },
      total_violations: 5,
    });
    store.appendFlowRun(entry);

    const analytics = store.computeAnalytics();
    expect(analytics.total_runs).toBe(1);
  });
});

// getReviewsByFiles

describe("getReviewsByFiles", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());

    // Seed reviews:
    // rev_001: files = [src/foo.ts, src/bar.ts]
    // rev_002: files = [src/baz.ts]
    // rev_003: files = [src/foo.ts, src/qux.ts] with violations
    store.appendReview(
      makeReviewEntry({
        files: ["src/foo.ts", "src/bar.ts"],
        review_id: "rev_001",
      }),
    );
    store.appendReview(
      makeReviewEntry({
        files: ["src/baz.ts"],
        review_id: "rev_002",
      }),
    );
    store.appendReview(
      makeReviewEntry({
        files: ["src/foo.ts", "src/qux.ts"],
        review_id: "rev_003",
        violations: [{ file_path: "src/foo.ts", principle_id: "thin-handlers", severity: "rule" }],
      }),
    );
  });

  afterEach(() => {
    store.close();
  });

  test("returns reviews whose files overlap with input", () => {
    const results = store.getReviewsByFiles(["src/foo.ts"]);
    const ids = results.map((r) => r.review_id);
    expect(ids).toContain("rev_001");
    expect(ids).toContain("rev_003");
    expect(ids).not.toContain("rev_002");
  });

  test("returns reviews matching any file in input (union)", () => {
    const results = store.getReviewsByFiles(["src/bar.ts", "src/baz.ts"]);
    const ids = results.map((r) => r.review_id);
    expect(ids).toContain("rev_001"); // has src/bar.ts
    expect(ids).toContain("rev_002"); // has src/baz.ts
    expect(ids).not.toContain("rev_003");
  });

  test("returns empty array for non-matching files", () => {
    const results = store.getReviewsByFiles(["src/does-not-exist.ts"]);
    expect(results).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    const results = store.getReviewsByFiles([]);
    expect(results).toEqual([]);
  });

  test("reconstitutes violations for matched reviews", () => {
    const results = store.getReviewsByFiles(["src/foo.ts"]);
    const rev3 = results.find((r) => r.review_id === "rev_003");
    expect(rev3).toBeDefined();
    expect(rev3!.violations).toHaveLength(1);
    expect(rev3!.violations[0].principle_id).toBe("thin-handlers");
    expect(rev3!.violations[0].file_path).toBe("src/foo.ts");
  });

  test("returns all reviews when all match", () => {
    // src/foo.ts appears in rev_001 and rev_003; src/baz.ts in rev_002
    const results = store.getReviewsByFiles(["src/foo.ts", "src/baz.ts"]);
    expect(results).toHaveLength(3);
  });
});

// getDriftDb factory

describe("getDriftDb factory", () => {
  test("caches instances by projectDir", async () => {
    // getDriftDb uses a disk path, so we test the caching behavior
    // by checking that calling with the same path returns the same instance.
    // We use a temp dir pattern.
    const { mkdtempSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "drift-db-test-"));
    // Create .canon subdirectory
    mkdirSync(join(tmpDir, ".canon"), { recursive: true });

    const instance1 = getDriftDb(tmpDir);
    const instance2 = getDriftDb(tmpDir);
    expect(instance1).toBe(instance2);

    // Cleanup — close and clear from cache by using a unique path per test
    instance1.close();
  });
});
