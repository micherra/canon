/**
 * DriftDb Tests — file reviews, flow run counts, decisions, and factory
 *
 * File 3 of 3: getReviewsByFiles, countFlowRunsSince, getLastFlowRunCompletedAt,
 *              appendDecision+getDecisionsByRun, getRecentDecisions,
 *              appendFlowRun with commits/diff_stat, getDriftDb factory
 */

import type { ReviewEntry } from "@shared/schema.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DecisionEntry, FlowRunEntry } from "../drift-analytics-types.ts";
import { DriftDb, getDriftDb } from "../drift-db.ts";
import { initDriftDb } from "../drift-schema.ts";

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

function makeDb(): { db: Database.Database; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

function makeDecisionEntry(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    content: "We chose SQLite over JSONL for atomic writes.",
    decision_id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    title: "Use SQLite for drift storage",
    ...overrides,
  };
}

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

// countFlowRunsSince

describe("countFlowRunsSince", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns 0 for empty DB", () => {
    const count = store.countFlowRunsSince("2020-01-01T00:00:00.000Z");
    expect(count).toBe(0);
  });

  test("returns correct count after inserting flow runs", () => {
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-10T12:00:00.000Z", run_id: "r1" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-11T12:00:00.000Z", run_id: "r2" }));
    store.appendFlowRun(makeFlowRunEntry({ completed: "2026-01-12T12:00:00.000Z", run_id: "r3" }));

    const count = store.countFlowRunsSince("2026-01-10T00:00:00.000Z");
    expect(count).toBe(3);
  });

  test("excludes runs completed before the timestamp", () => {
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2026-01-05T12:00:00.000Z", run_id: "r_before" }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2026-01-10T12:00:00.000Z", run_id: "r_after" }),
    );

    // Only the run after 2026-01-07 should count
    const count = store.countFlowRunsSince("2026-01-07T00:00:00.000Z");
    expect(count).toBe(1);
  });

  test("returns 0 when all runs are before the timestamp", () => {
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2025-01-01T00:00:00.000Z", run_id: "r_old" }),
    );

    const count = store.countFlowRunsSince("2026-01-01T00:00:00.000Z");
    expect(count).toBe(0);
  });
});

// getLastFlowRunCompletedAt

describe("getLastFlowRunCompletedAt", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns null for empty DB", () => {
    const result = store.getLastFlowRunCompletedAt();
    expect(result).toBeNull();
  });

  test("returns most recent completed timestamp", () => {
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2026-01-05T10:00:00.000Z", run_id: "r_early" }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2026-01-20T10:00:00.000Z", run_id: "r_late" }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2026-01-10T10:00:00.000Z", run_id: "r_mid" }),
    );

    const result = store.getLastFlowRunCompletedAt();
    expect(result).toBe("2026-01-20T10:00:00.000Z");
  });

  test("returns the only timestamp when single run exists", () => {
    store.appendFlowRun(
      makeFlowRunEntry({ completed: "2026-03-15T08:30:00.000Z", run_id: "r_only" }),
    );

    const result = store.getLastFlowRunCompletedAt();
    expect(result).toBe("2026-03-15T08:30:00.000Z");
  });
});

// appendDecision + getDecisionsByRun

describe("appendDecision and getDecisionsByRun", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("round-trips a DecisionEntry via appendDecision + getDecisionsByRun", () => {
    const entry = makeDecisionEntry({
      decision_id: "dec_001",
      file_path: "decisions/drift-01.md",
      flow: "feature",
      run_id: "run_abc",
      task: "Implement drift storage",
    });
    store.appendDecision(entry);
    const results = store.getDecisionsByRun("run_abc");
    expect(results).toHaveLength(1);
    expect(results[0].decision_id).toBe("dec_001");
    expect(results[0].run_id).toBe("run_abc");
    expect(results[0].flow).toBe("feature");
    expect(results[0].task).toBe("Implement drift storage");
    expect(results[0].title).toBe(entry.title);
    expect(results[0].content).toBe(entry.content);
    expect(results[0].file_path).toBe("decisions/drift-01.md");
    expect(results[0].timestamp).toBe(entry.timestamp);
  });

  test("appendDecision with duplicate decision_id is idempotent (no error)", () => {
    const entry = makeDecisionEntry({ decision_id: "dec_dup" });
    store.appendDecision(entry);
    expect(() => store.appendDecision(entry)).not.toThrow();
    const results = store.getDecisionsByRun(entry.run_id ?? "none");
    // Only one row stored (INSERT OR IGNORE)
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("getDecisionsByRun returns empty array for unknown run_id", () => {
    const results = store.getDecisionsByRun("no_such_run");
    expect(results).toEqual([]);
  });

  test("getDecisionsByRun returns decisions in ASC timestamp order", () => {
    store.appendDecision(
      makeDecisionEntry({
        decision_id: "dec_a",
        run_id: "run_order",
        timestamp: "2026-01-01T10:00:00Z",
      }),
    );
    store.appendDecision(
      makeDecisionEntry({
        decision_id: "dec_b",
        run_id: "run_order",
        timestamp: "2026-01-01T12:00:00Z",
      }),
    );
    const results = store.getDecisionsByRun("run_order");
    expect(results).toHaveLength(2);
    expect(results[0].decision_id).toBe("dec_a");
    expect(results[1].decision_id).toBe("dec_b");
  });

  test("round-trips a DecisionEntry with all optional fields absent", () => {
    const entry = makeDecisionEntry({ decision_id: "dec_minimal" });
    // entry has no run_id, flow, task, file_path
    store.appendDecision(entry);
    // Can't query by run_id since there's none; use getRecentDecisions
    const results = store.getRecentDecisions(10);
    const found = results.find((d) => d.decision_id === "dec_minimal");
    expect(found).toBeDefined();
    expect(found!.run_id).toBeUndefined();
    expect(found!.flow).toBeUndefined();
    expect(found!.task).toBeUndefined();
    expect(found!.file_path).toBeUndefined();
  });
});

// getRecentDecisions

describe("getRecentDecisions", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("returns correct count in DESC timestamp order", () => {
    store.appendDecision(
      makeDecisionEntry({ decision_id: "d1", timestamp: "2026-01-01T08:00:00Z" }),
    );
    store.appendDecision(
      makeDecisionEntry({ decision_id: "d2", timestamp: "2026-01-02T08:00:00Z" }),
    );
    store.appendDecision(
      makeDecisionEntry({ decision_id: "d3", timestamp: "2026-01-03T08:00:00Z" }),
    );

    const results = store.getRecentDecisions(2);
    expect(results).toHaveLength(2);
    // DESC order: most recent first
    expect(results[0].decision_id).toBe("d3");
    expect(results[1].decision_id).toBe("d2");
  });

  test("returns empty array when no decisions exist", () => {
    const results = store.getRecentDecisions(10);
    expect(results).toEqual([]);
  });

  test("returns all decisions when limit exceeds count", () => {
    store.appendDecision(makeDecisionEntry({ decision_id: "e1" }));
    store.appendDecision(makeDecisionEntry({ decision_id: "e2" }));
    const results = store.getRecentDecisions(100);
    expect(results).toHaveLength(2);
  });
});

// appendFlowRun with commits/diff_stat

describe("appendFlowRun with commits and diff_stat", () => {
  let db: Database.Database;
  let store: DriftDb;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("round-trips commits and diff_stat correctly", () => {
    const commits = ["abc123", "def456", "ghi789"];
    const diffStat = "12 files changed, 340 insertions(+), 45 deletions(-)";
    const entry = makeFlowRunEntry({
      commits,
      diff_stat: diffStat,
      run_id: "run_with_git",
    });
    store.appendFlowRun(entry);

    // Read back via direct DB query to verify round-trip
    const row = db
      .prepare(`SELECT commits, diff_stat FROM flow_runs WHERE run_id = ?`)
      .get("run_with_git") as { commits: string; diff_stat: string };
    expect(JSON.parse(row.commits)).toEqual(commits);
    expect(row.diff_stat).toBe(diffStat);
  });

  test("appendFlowRun without commits/diff_stat stores NULL (backward compat)", () => {
    const entry = makeFlowRunEntry({ run_id: "run_no_git" });
    // entry has no commits or diff_stat
    expect(() => store.appendFlowRun(entry)).not.toThrow();

    const row = db
      .prepare(`SELECT commits, diff_stat FROM flow_runs WHERE run_id = ?`)
      .get("run_no_git") as { commits: string | null; diff_stat: string | null };
    expect(row.commits).toBeNull();
    expect(row.diff_stat).toBeNull();

    const analytics = store.computeAnalytics();
    expect(analytics.total_runs).toBe(1);
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
