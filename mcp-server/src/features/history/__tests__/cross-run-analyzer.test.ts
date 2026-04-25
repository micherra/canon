/**
 * Cross-run analyzer tests — pure computation over run summaries and drift.db data.
 *
 * Uses in-memory SQLite (:memory:) via DriftDb for isolation.
 * All assertions go through analyzeCrossRunPatterns() and assert on the relevant
 * sub-field of the returned CrossRunAnalysisResult.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FlowRunEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { ReviewEntry } from "../../../shared/schema.ts";
import type { RunSummary } from "../history-types.ts";
import { analyzeCrossRunPatterns } from "../services/cross-run-analyzer.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

function makeReviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/foo.ts"],
    honored: [],
    review_id: `rev_${Math.random().toString(36).slice(2, 10)}`,
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
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
    flow: "feature",
    run_id: `run_${Math.random().toString(36).slice(2, 10)}`,
    skipped_states: [],
    started: new Date().toISOString(),
    state_durations: {},
    state_iterations: {},
    task: "Test task",
    tier: "standard",
    total_duration_ms: 60_000,
    total_spawns: 3,
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const now = new Date().toISOString();
  return {
    archive_id: `arc_${Math.random().toString(36).slice(2, 10)}`,
    artifact_inventory: {
      directories: [],
      files: [],
      total_files: 0,
    },
    decision_summaries: [],
    planner_context: null,
    review_results: [],
    run_metadata: {
      archived_at: now,
      branch: "main",
      completed_at: now,
      flow: "feature",
      slug: "test-slug",
      started_at: now,
      task: "Test task",
      tier: "standard",
      total_duration_ms: 60_000,
    },
    step_outcomes: [],
    version: 1,
    ...overrides,
  };
}

// ---- recurring_violations ----

describe("analyzeCrossRunPatterns — recurring_violations", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns empty array when no reviews/summaries exist", () => {
    const result = analyzeCrossRunPatterns(store, []);
    expect(result.recurring_violations).toEqual([]);
  });

  test("returns violations appearing in 2+ reviews, sorted by count DESC", () => {
    // principle-a appears 3 times, principle-b appears 2 times
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "principle-a", severity: "rule" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_002",
        timestamp: "2026-01-02T00:00:00.000Z",
        violations: [
          { principle_id: "principle-a", severity: "rule" },
          { principle_id: "principle-b", severity: "strong-opinion" },
        ],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_003",
        timestamp: "2026-01-03T00:00:00.000Z",
        violations: [
          { principle_id: "principle-a", severity: "rule" },
          { principle_id: "principle-b", severity: "strong-opinion" },
        ],
      }),
    );

    const result = analyzeCrossRunPatterns(store, []);

    expect(result.recurring_violations).toHaveLength(2);
    expect(result.recurring_violations[0].principle_id).toBe("principle-a");
    expect(result.recurring_violations[0].occurrence_count).toBe(3);
    expect(result.recurring_violations[1].principle_id).toBe("principle-b");
    expect(result.recurring_violations[1].occurrence_count).toBe(2);
  });

  test("does not include violations appearing in only 1 review", () => {
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "only-once", severity: "rule" }],
      }),
    );

    const result = analyzeCrossRunPatterns(store, []);
    expect(result.recurring_violations).toHaveLength(0);
  });

  test("correctly aggregates affected_files across reviews", () => {
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ file_path: "src/foo.ts", principle_id: "principle-a", severity: "rule" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_002",
        timestamp: "2026-01-02T00:00:00.000Z",
        violations: [{ file_path: "src/bar.ts", principle_id: "principle-a", severity: "rule" }],
      }),
    );

    const result = analyzeCrossRunPatterns(store, []);
    expect(result.recurring_violations).toHaveLength(1);
    expect(result.recurring_violations[0].affected_files).toContain("src/foo.ts");
    expect(result.recurring_violations[0].affected_files).toContain("src/bar.ts");
  });

  test("combines violations from summaries and drift.db reviews", () => {
    // drift.db has one occurrence of principle-x
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "principle-x", severity: "strong-opinion" }],
      }),
    );

    // summary provides second occurrence via review_results
    const summaries: RunSummary[] = [
      makeRunSummary({
        review_results: [
          {
            files_reviewed: 1,
            honored: [],
            principles_checked: 1,
            verdict: "violations",
            violations: [
              {
                file_path: "src/baz.ts",
                message: "",
                principle_id: "principle-x",
                severity: "strong-opinion",
              },
            ],
          },
        ],
        run_metadata: {
          archived_at: "2026-01-02T00:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-02T00:00:00.000Z",
          flow: "feature",
          slug: "test-slug",
          started_at: "2026-01-02T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 60_000,
        },
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);
    expect(result.recurring_violations).toHaveLength(1);
    expect(result.recurring_violations[0].principle_id).toBe("principle-x");
    expect(result.recurring_violations[0].occurrence_count).toBe(2);
  });
});

// ---- fix_cycle_patterns ----

describe("analyzeCrossRunPatterns — fix_cycle_patterns", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns empty array when no recurring violations", () => {
    // Only one occurrence — not recurring
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "single", severity: "rule" }],
      }),
    );

    const result = analyzeCrossRunPatterns(store, []);
    expect(result.fix_cycle_patterns).toEqual([]);
  });

  test("calculates correct recurrence_rate for a violation that reappears", () => {
    // Appears → disappears → reappears pattern:
    // rev_001: violation present (t=0)
    // rev_002: violation absent (fixed at t=1)
    // rev_003: violation present again (reappeared at t=2)
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "recur", severity: "rule" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_002",
        timestamp: "2026-01-02T00:00:00.000Z",
        violations: [], // fixed
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_003",
        timestamp: "2026-01-03T00:00:00.000Z",
        violations: [{ principle_id: "recur", severity: "rule" }],
      }),
    );

    const result = analyzeCrossRunPatterns(store, []);
    expect(result.fix_cycle_patterns).toHaveLength(1);
    expect(result.fix_cycle_patterns[0].principle_id).toBe("recur");
    // 1 fix, 1 reappearance → recurrence_rate = 1/1 = 1
    expect(result.fix_cycle_patterns[0].recurrence_rate).toBe(1);
    expect(result.fix_cycle_patterns[0].fix_count).toBe(1);
  });
});

// ---- analyzeCrossRunPatterns (end-to-end) ----

describe("analyzeCrossRunPatterns", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("integrates all sub-analyses (end-to-end with in-memory DriftDb)", () => {
    // Add two reviews with a recurring violation
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "test-principle", severity: "rule" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_002",
        timestamp: "2026-02-01T00:00:00.000Z",
        violations: [{ principle_id: "test-principle", severity: "rule" }],
      }),
    );

    // Add flow runs
    store.appendFlowRun(
      makeFlowRunEntry({
        completed: "2026-01-01T01:00:00.000Z",
        flow: "feature",
        run_id: "run_001",
        started: "2026-01-01T00:00:00.000Z",
        total_duration_ms: 3_600_000,
        total_spawns: 5,
      }),
    );

    // Add a summary with planner context
    const summaries: RunSummary[] = [
      makeRunSummary({
        planner_context: {
          assumptions: ["tests pass"],
          effort_estimate: "medium",
          outcome: "done",
          recommended_approach: "iterative",
          runbook_steps: [],
          value_estimate: "high",
        },
        run_metadata: {
          archived_at: "2026-01-01T01:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-01T01:00:00.000Z",
          flow: "feature",
          slug: "test-slug",
          started_at: "2026-01-01T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 3_600_000,
        },
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);

    expect(result.recurring_violations).toHaveLength(1);
    expect(result.recurring_violations[0].principle_id).toBe("test-principle");
    expect(result.agent_performance_trends).toHaveLength(1);
    expect(result.planner_patterns.total_runs_with_planner).toBe(1);
    expect(result.total_archived_runs).toBe(1); // 1 summary
  });

  test("respects `limit` option — caps performance trend data points per flow", () => {
    // Insert 5 flow runs; request limit=3 → only the 3 most recent should appear in trends.
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 5; i++) {
      store.appendFlowRun(
        makeFlowRunEntry({
          completed: new Date(base + i * 3_600_000 + 60_000).toISOString(),
          flow: "fast-path",
          run_id: `run_limit_${i}`,
          started: new Date(base + i * 3_600_000).toISOString(),
          total_duration_ms: (i + 1) * 10_000, // 10k, 20k, 30k, 40k, 50k
          total_spawns: 1,
        }),
      );
    }

    const result = analyzeCrossRunPatterns(store, [], { limit: 3 });

    const trend = result.agent_performance_trends.find((t) => t.flow === "fast-path");
    expect(trend).toBeDefined();
    expect(trend?.run_count).toBe(3); // most recent 3 of 5
    // The 3 most recent runs have duration_ms 30k, 40k, 50k → avg = 40k
    expect(trend?.avg_duration_ms).toBe(40_000);
  });

  test("respects `since` filter", () => {
    store.appendFlowRun(
      makeFlowRunEntry({
        completed: "2025-01-01T01:00:00.000Z",
        flow: "feature",
        run_id: "run_old",
        started: "2025-01-01T00:00:00.000Z",
        total_duration_ms: 60_000,
        total_spawns: 2,
      }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({
        completed: "2026-03-01T01:00:00.000Z",
        flow: "feature",
        run_id: "run_new",
        started: "2026-03-01T00:00:00.000Z",
        total_duration_ms: 60_000,
        total_spawns: 2,
      }),
    );

    const result = analyzeCrossRunPatterns(store, [], {
      since: "2026-01-01T00:00:00.000Z",
    });

    // Only the new run should appear in trend data
    const trend = result.agent_performance_trends.find((t) => t.flow === "feature");
    expect(trend?.run_count).toBe(1);
  });

  test("returns correct analysis_window", () => {
    store.appendFlowRun(
      makeFlowRunEntry({
        completed: "2026-01-01T01:00:00.000Z",
        flow: "feature",
        run_id: "run_a",
        started: "2026-01-01T00:00:00.000Z",
        total_duration_ms: 3_600_000,
        total_spawns: 2,
      }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({
        completed: "2026-03-15T00:30:00.000Z",
        flow: "fast-path",
        run_id: "run_b",
        started: "2026-03-15T00:00:00.000Z",
        total_duration_ms: 1_800_000,
        total_spawns: 1,
      }),
    );

    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          archived_at: "2026-01-01T01:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-01T01:00:00.000Z",
          flow: "feature",
          slug: "s1",
          started_at: "2026-01-01T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 3_600_000,
        },
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);

    expect(result.analysis_window.from).toBeDefined();
    expect(result.analysis_window.to).toBeDefined();
    // from should be the earliest timestamp
    expect(result.analysis_window.from <= "2026-01-01T01:00:00.000Z").toBe(true);
    // to should be the latest timestamp
    expect(result.analysis_window.to >= "2026-03-15T00:30:00.000Z").toBe(true);
  });
});
