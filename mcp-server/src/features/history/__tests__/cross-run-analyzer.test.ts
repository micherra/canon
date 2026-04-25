/**
 * Cross-run analyzer tests — pure computation over run summaries and drift.db data.
 *
 * Uses in-memory SQLite (:memory:) via DriftDb for isolation.
 * Tests cover each exported function independently, then the top-level integrator.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ReviewEntry } from "../../../shared/schema.ts";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { FlowRunEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import type { RunSummary } from "../history-types.ts";
import {
  analyzeCrossRunPatterns,
  analyzePlannerPatterns,
  computeFixCyclePatterns,
  computePerformanceTrends,
  findRecurringViolations,
} from "../services/cross-run-analyzer.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

function makeReviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    review_id: `rev_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    files: ["src/foo.ts"],
    honored: [],
    score: {
      rules: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      conventions: { passed: 1, total: 1 },
    },
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

function makeFlowRunEntry(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    run_id: `run_${Math.random().toString(36).slice(2, 10)}`,
    flow: "feature",
    tier: "standard",
    task: "Test task",
    started: new Date().toISOString(),
    completed: new Date().toISOString(),
    total_duration_ms: 60_000,
    state_durations: {},
    state_iterations: {},
    skipped_states: [],
    total_spawns: 3,
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const now = new Date().toISOString();
  return {
    version: 1,
    archive_id: `arc_${Math.random().toString(36).slice(2, 10)}`,
    run_metadata: {
      branch: "main",
      slug: "test-slug",
      flow: "feature",
      tier: "standard",
      task: "Test task",
      started_at: now,
      completed_at: now,
      archived_at: now,
      total_duration_ms: 60_000,
    },
    planner_context: null,
    step_outcomes: [],
    review_results: [],
    decision_summaries: [],
    artifact_inventory: {
      directories: [],
      files: [],
      total_files: 0,
    },
    ...overrides,
  };
}

// ---- findRecurringViolations ----

describe("findRecurringViolations", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns empty array when no reviews/summaries exist", () => {
    const result = findRecurringViolations([], store.getReviews());
    expect(result).toEqual([]);
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

    const result = findRecurringViolations([], store.getReviews());

    expect(result).toHaveLength(2);
    expect(result[0].principle_id).toBe("principle-a");
    expect(result[0].occurrence_count).toBe(3);
    expect(result[1].principle_id).toBe("principle-b");
    expect(result[1].occurrence_count).toBe(2);
  });

  test("does not include violations appearing in only 1 review", () => {
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "only-once", severity: "rule" }],
      }),
    );

    const result = findRecurringViolations([], store.getReviews());
    expect(result).toHaveLength(0);
  });

  test("correctly aggregates affected_files across reviews", () => {
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "principle-a", severity: "rule", file_path: "src/foo.ts" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_002",
        timestamp: "2026-01-02T00:00:00.000Z",
        violations: [{ principle_id: "principle-a", severity: "rule", file_path: "src/bar.ts" }],
      }),
    );

    const result = findRecurringViolations([], store.getReviews());
    expect(result).toHaveLength(1);
    expect(result[0].affected_files).toContain("src/foo.ts");
    expect(result[0].affected_files).toContain("src/bar.ts");
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

    // summary provides second occurrence
    const summaryViolations = [
      {
        principleId: "principle-x",
        severity: "strong-opinion",
        filePath: "src/baz.ts",
        reviewTimestamp: "2026-01-02T00:00:00.000Z",
      },
    ];

    const result = findRecurringViolations(summaryViolations, store.getReviews());
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("principle-x");
    expect(result[0].occurrence_count).toBe(2);
  });
});

// ---- computeFixCyclePatterns ----

describe("computeFixCyclePatterns", () => {
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

    const result = computeFixCyclePatterns([], store.getReviews());
    expect(result).toEqual([]);
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

    const result = computeFixCyclePatterns([], store.getReviews());
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("recur");
    // 1 fix, 1 reappearance → recurrence_rate = 1/1 = 1
    expect(result[0].recurrence_rate).toBe(1);
    expect(result[0].fix_count).toBe(1);
  });
});

// ---- computePerformanceTrends ----

describe("computePerformanceTrends", () => {
  test("deduplicates runs when summary and FlowRunEntry share the same (flow, started)", () => {
    // A summary and a FlowRunEntry both represent the same run.
    // Without deduplication, the run would appear twice and skew avg_duration_ms.
    const sharedStarted = "2026-01-10T00:00:00.000Z";
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          branch: "main",
          slug: "dup-test",
          flow: "feature",
          tier: "standard",
          task: "T",
          started_at: sharedStarted,
          completed_at: sharedStarted,
          archived_at: sharedStarted,
          total_duration_ms: 90_000,
        },
      }),
    ];
    const runs: FlowRunEntry[] = [
      makeFlowRunEntry({
        flow: "feature",
        started: sharedStarted,
        total_duration_ms: 9_000_000, // wildly different — proves dedup is working
      }),
    ];

    const result = computePerformanceTrends(summaries, runs);
    expect(result).toHaveLength(1);
    expect(result[0].run_count).toBe(1); // only one data point, not two
    expect(result[0].avg_duration_ms).toBe(90_000); // summary value preferred
  });


  test("returns 'stable' when fewer than 10 runs for a flow", () => {
    const summaries: RunSummary[] = [];
    const runs: FlowRunEntry[] = [
      makeFlowRunEntry({ flow: "feature", total_duration_ms: 60_000 }),
      makeFlowRunEntry({ flow: "feature", total_duration_ms: 65_000 }),
    ];

    const result = computePerformanceTrends(summaries, runs);
    expect(result).toHaveLength(1);
    expect(result[0].flow).toBe("feature");
    expect(result[0].trend).toBe("stable");
  });

  test("returns 'improving' when recent runs are faster", () => {
    // 5 old runs: 100s each, 5 recent: 50s each → 50% faster → improving
    const now = Date.now();
    const runs: FlowRunEntry[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        makeFlowRunEntry({
          flow: "feature",
          total_duration_ms: 100_000,
          started: new Date(now - (10 - i) * 86_400_000).toISOString(),
          completed: new Date(now - (10 - i) * 86_400_000 + 100_000).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      runs.push(
        makeFlowRunEntry({
          flow: "feature",
          total_duration_ms: 50_000,
          started: new Date(now - i * 86_400_000).toISOString(),
          completed: new Date(now - i * 86_400_000 + 50_000).toISOString(),
        }),
      );
    }

    const result = computePerformanceTrends([], runs);
    expect(result).toHaveLength(1);
    expect(result[0].trend).toBe("improving");
  });

  test("returns 'degrading' when recent runs are slower", () => {
    const now = Date.now();
    const runs: FlowRunEntry[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        makeFlowRunEntry({
          flow: "feature",
          total_duration_ms: 50_000,
          started: new Date(now - (10 - i) * 86_400_000).toISOString(),
          completed: new Date(now - (10 - i) * 86_400_000 + 50_000).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      runs.push(
        makeFlowRunEntry({
          flow: "feature",
          total_duration_ms: 120_000,
          started: new Date(now - i * 86_400_000).toISOString(),
          completed: new Date(now - i * 86_400_000 + 120_000).toISOString(),
        }),
      );
    }

    const result = computePerformanceTrends([], runs);
    expect(result).toHaveLength(1);
    expect(result[0].trend).toBe("degrading");
  });

  test("groups runs by flow name correctly", () => {
    const summaries: RunSummary[] = [];
    const runs: FlowRunEntry[] = [
      makeFlowRunEntry({ flow: "feature", total_duration_ms: 60_000 }),
      makeFlowRunEntry({ flow: "fast-path", total_duration_ms: 30_000 }),
      makeFlowRunEntry({ flow: "feature", total_duration_ms: 70_000 }),
    ];

    const result = computePerformanceTrends(summaries, runs);
    const flows = result.map((r) => r.flow).sort();
    expect(flows).toEqual(["fast-path", "feature"]);

    const featureTrend = result.find((r) => r.flow === "feature");
    expect(featureTrend?.run_count).toBe(2);
    expect(featureTrend?.avg_duration_ms).toBe(65_000);

    const fastPathTrend = result.find((r) => r.flow === "fast-path");
    expect(fastPathTrend?.run_count).toBe(1);
    expect(fastPathTrend?.avg_duration_ms).toBe(30_000);
  });

  test("uses summary step durations when available", () => {
    // A summary with step_outcomes provides duration data
    const now = new Date().toISOString();
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          branch: "main",
          slug: "test",
          flow: "feature",
          tier: "standard",
          task: "T",
          started_at: now,
          completed_at: now,
          archived_at: now,
          total_duration_ms: 45_000,
        },
        step_outcomes: [
          {
            step_id: "implement",
            agent_type: "engineer",
            status: "done",
            started_at: now,
            completed_at: now,
            duration_ms: 40_000,
            artifacts_expected: [],
          },
        ],
      }),
    ];
    // No separate FlowRunEntry for this flow
    const runs: FlowRunEntry[] = [];

    const result = computePerformanceTrends(summaries, runs);
    expect(result).toHaveLength(1);
    expect(result[0].flow).toBe("feature");
    expect(result[0].avg_duration_ms).toBe(45_000);
  });
});

// ---- analyzePlannerPatterns ----

describe("analyzePlannerPatterns", () => {
  test("returns zero counts when no summaries have planner context", () => {
    const summaries: RunSummary[] = [makeRunSummary({ planner_context: null })];
    const result = analyzePlannerPatterns(summaries);
    expect(result.total_runs_with_planner).toBe(0);
    expect(result.common_assumptions).toEqual([]);
    expect(result.effort_accuracy).toEqual([]);
    expect(result.value_distribution).toEqual([]);
  });

  test("counts common assumptions across runs", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        planner_context: {
          outcome: "done",
          effort_estimate: "medium",
          value_estimate: "high",
          assumptions: ["DB is healthy", "CI is green"],
          recommended_approach: "iterative",
          runbook_steps: [],
        },
      }),
      makeRunSummary({
        planner_context: {
          outcome: "done",
          effort_estimate: "low",
          value_estimate: "medium",
          assumptions: ["DB is healthy", "tests exist"],
          recommended_approach: "direct",
          runbook_steps: [],
        },
      }),
    ];

    const result = analyzePlannerPatterns(summaries);
    expect(result.total_runs_with_planner).toBe(2);

    const dbAssumption = result.common_assumptions.find((a) => a.assumption === "DB is healthy");
    expect(dbAssumption?.occurrence_count).toBe(2);
  });

  test("computes effort accuracy (estimate vs actual duration)", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          branch: "main",
          slug: "s1",
          flow: "feature",
          tier: "standard",
          task: "T",
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:00:00.000Z",
          archived_at: "2026-01-01T00:00:00.000Z",
          total_duration_ms: 120_000,
        },
        planner_context: {
          outcome: "done",
          effort_estimate: "medium",
          value_estimate: "high",
          assumptions: [],
          recommended_approach: "iterative",
          runbook_steps: [],
        },
      }),
      makeRunSummary({
        run_metadata: {
          branch: "main",
          slug: "s2",
          flow: "feature",
          tier: "standard",
          task: "T",
          started_at: "2026-01-02T00:00:00.000Z",
          completed_at: "2026-01-02T00:00:00.000Z",
          archived_at: "2026-01-02T00:00:00.000Z",
          total_duration_ms: 80_000,
        },
        planner_context: {
          outcome: "done",
          effort_estimate: "medium",
          value_estimate: "low",
          assumptions: [],
          recommended_approach: "direct",
          runbook_steps: [],
        },
      }),
    ];

    const result = analyzePlannerPatterns(summaries);
    const mediumAccuracy = result.effort_accuracy.find((e) => e.estimate === "medium");
    expect(mediumAccuracy).toBeDefined();
    expect(mediumAccuracy?.sample_count).toBe(2);
    expect(mediumAccuracy?.actual_avg_duration_ms).toBe(100_000); // (120k + 80k) / 2
  });

  test("computes value distribution", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        planner_context: {
          outcome: "done",
          effort_estimate: "low",
          value_estimate: "high",
          assumptions: [],
          recommended_approach: "direct",
          runbook_steps: [],
        },
      }),
      makeRunSummary({
        planner_context: {
          outcome: "done",
          effort_estimate: "low",
          value_estimate: "high",
          assumptions: [],
          recommended_approach: "direct",
          runbook_steps: [],
        },
      }),
      makeRunSummary({
        planner_context: {
          outcome: "done",
          effort_estimate: "medium",
          value_estimate: "medium",
          assumptions: [],
          recommended_approach: "iterative",
          runbook_steps: [],
        },
      }),
    ];

    const result = analyzePlannerPatterns(summaries);
    const highValue = result.value_distribution.find((v) => v.value === "high");
    const mediumValue = result.value_distribution.find((v) => v.value === "medium");
    expect(highValue?.count).toBe(2);
    expect(mediumValue?.count).toBe(1);
  });

  test("handles summaries with null planner_context gracefully", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({ planner_context: null }),
      makeRunSummary({
        planner_context: {
          outcome: "done",
          effort_estimate: "low",
          value_estimate: "high",
          assumptions: ["one"],
          recommended_approach: "direct",
          runbook_steps: [],
        },
      }),
      makeRunSummary({ planner_context: null }),
    ];

    const result = analyzePlannerPatterns(summaries);
    expect(result.total_runs_with_planner).toBe(1);
    expect(result.common_assumptions).toHaveLength(1);
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
        run_id: "run_001",
        flow: "feature",
        started: "2026-01-01T00:00:00.000Z",
        completed: "2026-01-01T01:00:00.000Z",
        total_duration_ms: 3_600_000,
        total_spawns: 5,
      }),
    );

    // Add a summary with planner context
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          branch: "main",
          slug: "test-slug",
          flow: "feature",
          tier: "standard",
          task: "T",
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T01:00:00.000Z",
          archived_at: "2026-01-01T01:00:00.000Z",
          total_duration_ms: 3_600_000,
        },
        planner_context: {
          outcome: "done",
          effort_estimate: "medium",
          value_estimate: "high",
          assumptions: ["tests pass"],
          recommended_approach: "iterative",
          runbook_steps: [],
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
          run_id: `run_limit_${i}`,
          flow: "fast-path",
          started: new Date(base + i * 3_600_000).toISOString(),
          completed: new Date(base + i * 3_600_000 + 60_000).toISOString(),
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
        run_id: "run_old",
        flow: "feature",
        started: "2025-01-01T00:00:00.000Z",
        completed: "2025-01-01T01:00:00.000Z",
        total_duration_ms: 60_000,
        total_spawns: 2,
      }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({
        run_id: "run_new",
        flow: "feature",
        started: "2026-03-01T00:00:00.000Z",
        completed: "2026-03-01T01:00:00.000Z",
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
        run_id: "run_a",
        flow: "feature",
        started: "2026-01-01T00:00:00.000Z",
        completed: "2026-01-01T01:00:00.000Z",
        total_duration_ms: 3_600_000,
        total_spawns: 2,
      }),
    );
    store.appendFlowRun(
      makeFlowRunEntry({
        run_id: "run_b",
        flow: "fast-path",
        started: "2026-03-15T00:00:00.000Z",
        completed: "2026-03-15T00:30:00.000Z",
        total_duration_ms: 1_800_000,
        total_spawns: 1,
      }),
    );

    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          branch: "main",
          slug: "s1",
          flow: "feature",
          tier: "standard",
          task: "T",
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T01:00:00.000Z",
          archived_at: "2026-01-01T01:00:00.000Z",
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
