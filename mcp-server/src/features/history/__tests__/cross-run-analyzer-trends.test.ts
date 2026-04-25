/**
 * Cross-run analyzer tests — performance trends and planner pattern analysis.
 *
 * Split from cross-run-analyzer.test.ts to keep each file under 600 lines.
 * All assertions go through analyzeCrossRunPatterns() and assert on the
 * relevant sub-field of the returned CrossRunAnalysisResult.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FlowRunEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { RunSummary } from "../history-types.ts";
import { analyzeCrossRunPatterns } from "../services/cross-run-analyzer.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
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

// ---- agent_performance_trends ----

describe("analyzeCrossRunPatterns — agent_performance_trends", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("deduplicates runs when summary and FlowRunEntry share the same (flow, started)", () => {
    // A summary and a FlowRunEntry both represent the same run.
    // Without deduplication, the run would appear twice and skew avg_duration_ms.
    const sharedStarted = "2026-01-10T00:00:00.000Z";
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          archived_at: sharedStarted,
          branch: "main",
          completed_at: sharedStarted,
          flow: "feature",
          slug: "dup-test",
          started_at: sharedStarted,
          task: "T",
          tier: "standard",
          total_duration_ms: 90_000,
        },
      }),
    ];
    store.appendFlowRun(
      makeFlowRunEntry({
        flow: "feature",
        started: sharedStarted,
        total_duration_ms: 9_000_000, // wildly different — proves dedup is working
      }),
    );

    const result = analyzeCrossRunPatterns(store, summaries);
    const trend = result.agent_performance_trends.find((t) => t.flow === "feature");
    expect(trend).toBeDefined();
    expect(trend?.run_count).toBe(1); // only one data point, not two
    expect(trend?.avg_duration_ms).toBe(90_000); // summary value preferred
  });

  test("returns 'stable' when fewer than 10 runs for a flow", () => {
    store.appendFlowRun(makeFlowRunEntry({ flow: "feature", total_duration_ms: 60_000 }));
    store.appendFlowRun(makeFlowRunEntry({ flow: "feature", total_duration_ms: 65_000 }));

    const result = analyzeCrossRunPatterns(store, []);
    const trend = result.agent_performance_trends.find((t) => t.flow === "feature");
    expect(trend).toBeDefined();
    expect(trend?.flow).toBe("feature");
    expect(trend?.trend).toBe("stable");
  });

  test("returns 'improving' when recent runs are faster", () => {
    // 5 old runs: 100s each, 5 recent: 50s each → 50% faster → improving
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      store.appendFlowRun(
        makeFlowRunEntry({
          completed: new Date(now - (10 - i) * 86_400_000 + 100_000).toISOString(),
          flow: "feature",
          started: new Date(now - (10 - i) * 86_400_000).toISOString(),
          total_duration_ms: 100_000,
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      store.appendFlowRun(
        makeFlowRunEntry({
          completed: new Date(now - i * 86_400_000 + 50_000).toISOString(),
          flow: "feature",
          started: new Date(now - i * 86_400_000).toISOString(),
          total_duration_ms: 50_000,
        }),
      );
    }

    const result = analyzeCrossRunPatterns(store, []);
    const trend = result.agent_performance_trends.find((t) => t.flow === "feature");
    expect(trend).toBeDefined();
    expect(trend?.trend).toBe("improving");
  });

  test("returns 'degrading' when recent runs are slower", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      store.appendFlowRun(
        makeFlowRunEntry({
          completed: new Date(now - (10 - i) * 86_400_000 + 50_000).toISOString(),
          flow: "feature",
          started: new Date(now - (10 - i) * 86_400_000).toISOString(),
          total_duration_ms: 50_000,
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      store.appendFlowRun(
        makeFlowRunEntry({
          completed: new Date(now - i * 86_400_000 + 120_000).toISOString(),
          flow: "feature",
          started: new Date(now - i * 86_400_000).toISOString(),
          total_duration_ms: 120_000,
        }),
      );
    }

    const result = analyzeCrossRunPatterns(store, []);
    const trend = result.agent_performance_trends.find((t) => t.flow === "feature");
    expect(trend).toBeDefined();
    expect(trend?.trend).toBe("degrading");
  });

  test("groups runs by flow name correctly", () => {
    store.appendFlowRun(makeFlowRunEntry({ flow: "feature", total_duration_ms: 60_000 }));
    store.appendFlowRun(makeFlowRunEntry({ flow: "fast-path", total_duration_ms: 30_000 }));
    store.appendFlowRun(makeFlowRunEntry({ flow: "feature", total_duration_ms: 70_000 }));

    const result = analyzeCrossRunPatterns(store, []);
    const flows = result.agent_performance_trends.map((r) => r.flow).sort();
    expect(flows).toEqual(["fast-path", "feature"]);

    const featureTrend = result.agent_performance_trends.find((r) => r.flow === "feature");
    expect(featureTrend?.run_count).toBe(2);
    expect(featureTrend?.avg_duration_ms).toBe(65_000);

    const fastPathTrend = result.agent_performance_trends.find((r) => r.flow === "fast-path");
    expect(fastPathTrend?.run_count).toBe(1);
    expect(fastPathTrend?.avg_duration_ms).toBe(30_000);
  });

  test("uses summary step durations when available", () => {
    // A summary with step_outcomes provides duration data
    const now = new Date().toISOString();
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          archived_at: now,
          branch: "main",
          completed_at: now,
          flow: "feature",
          slug: "test",
          started_at: now,
          task: "T",
          tier: "standard",
          total_duration_ms: 45_000,
        },
        step_outcomes: [
          {
            agent_type: "engineer",
            artifacts_expected: [],
            completed_at: now,
            duration_ms: 40_000,
            started_at: now,
            status: "done",
            step_id: "implement",
          },
        ],
      }),
    ];
    // No separate FlowRunEntry for this flow

    const result = analyzeCrossRunPatterns(store, summaries);
    const trend = result.agent_performance_trends.find((t) => t.flow === "feature");
    expect(trend).toBeDefined();
    expect(trend?.flow).toBe("feature");
    expect(trend?.avg_duration_ms).toBe(45_000);
  });
});

// ---- planner_patterns ----

describe("analyzeCrossRunPatterns — planner_patterns", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns zero counts when no summaries have planner context", () => {
    const summaries: RunSummary[] = [makeRunSummary({ planner_context: null })];
    const result = analyzeCrossRunPatterns(store, summaries);
    expect(result.planner_patterns.total_runs_with_planner).toBe(0);
    expect(result.planner_patterns.common_assumptions).toEqual([]);
    expect(result.planner_patterns.effort_accuracy).toEqual([]);
    expect(result.planner_patterns.value_distribution).toEqual([]);
  });

  test("counts common assumptions across runs", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        planner_context: {
          assumptions: ["DB is healthy", "CI is green"],
          effort_estimate: "medium",
          outcome: "done",
          recommended_approach: "iterative",
          runbook_steps: [],
          value_estimate: "high",
        },
      }),
      makeRunSummary({
        planner_context: {
          assumptions: ["DB is healthy", "tests exist"],
          effort_estimate: "low",
          outcome: "done",
          recommended_approach: "direct",
          runbook_steps: [],
          value_estimate: "medium",
        },
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);
    expect(result.planner_patterns.total_runs_with_planner).toBe(2);

    const dbAssumption = result.planner_patterns.common_assumptions.find(
      (a) => a.assumption === "DB is healthy",
    );
    expect(dbAssumption?.occurrence_count).toBe(2);
  });

  test("computes effort accuracy (estimate vs actual duration)", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        planner_context: {
          assumptions: [],
          effort_estimate: "medium",
          outcome: "done",
          recommended_approach: "iterative",
          runbook_steps: [],
          value_estimate: "high",
        },
        run_metadata: {
          archived_at: "2026-01-01T00:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-01T00:00:00.000Z",
          flow: "feature",
          slug: "s1",
          started_at: "2026-01-01T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 120_000,
        },
      }),
      makeRunSummary({
        planner_context: {
          assumptions: [],
          effort_estimate: "medium",
          outcome: "done",
          recommended_approach: "direct",
          runbook_steps: [],
          value_estimate: "low",
        },
        run_metadata: {
          archived_at: "2026-01-02T00:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-02T00:00:00.000Z",
          flow: "feature",
          slug: "s2",
          started_at: "2026-01-02T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 80_000,
        },
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);
    const mediumAccuracy = result.planner_patterns.effort_accuracy.find(
      (e) => e.estimate === "medium",
    );
    expect(mediumAccuracy).toBeDefined();
    expect(mediumAccuracy?.sample_count).toBe(2);
    expect(mediumAccuracy?.actual_avg_duration_ms).toBe(100_000); // (120k + 80k) / 2
  });

  test("computes value distribution", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        planner_context: {
          assumptions: [],
          effort_estimate: "low",
          outcome: "done",
          recommended_approach: "direct",
          runbook_steps: [],
          value_estimate: "high",
        },
      }),
      makeRunSummary({
        planner_context: {
          assumptions: [],
          effort_estimate: "low",
          outcome: "done",
          recommended_approach: "direct",
          runbook_steps: [],
          value_estimate: "high",
        },
      }),
      makeRunSummary({
        planner_context: {
          assumptions: [],
          effort_estimate: "medium",
          outcome: "done",
          recommended_approach: "iterative",
          runbook_steps: [],
          value_estimate: "medium",
        },
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);
    const highValue = result.planner_patterns.value_distribution.find((v) => v.value === "high");
    const mediumValue = result.planner_patterns.value_distribution.find(
      (v) => v.value === "medium",
    );
    expect(highValue?.count).toBe(2);
    expect(mediumValue?.count).toBe(1);
  });

  test("handles summaries with null planner_context gracefully", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({ planner_context: null }),
      makeRunSummary({
        planner_context: {
          assumptions: ["one"],
          effort_estimate: "low",
          outcome: "done",
          recommended_approach: "direct",
          runbook_steps: [],
          value_estimate: "high",
        },
      }),
      makeRunSummary({ planner_context: null }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);
    expect(result.planner_patterns.total_runs_with_planner).toBe(1);
    expect(result.planner_patterns.common_assumptions).toHaveLength(1);
  });
});
