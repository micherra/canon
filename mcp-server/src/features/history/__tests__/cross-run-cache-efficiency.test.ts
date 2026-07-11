/**
 * Cache-efficiency-by-agent tests — pure rollup over archived step_outcomes.metrics.
 *
 * Covers computeCacheEfficiencyByAgent directly (unit) and its wiring into
 * analyzeCrossRunPatterns (integration, regression-safe).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { RunSummary } from "../history-types.ts";
import { analyzeCrossRunPatterns } from "../services/cross-run-analyzer.ts";
import { computeCacheEfficiencyByAgent } from "../services/cross-run-patterns.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
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

function makeStepOutcome(
  overrides: Partial<RunSummary["step_outcomes"][number]> = {},
): RunSummary["step_outcomes"][number] {
  const now = new Date().toISOString();
  return {
    agent_type: "engineer",
    artifacts_expected: [],
    completed_at: now,
    duration_ms: 1000,
    started_at: now,
    status: "done",
    step_id: "implement",
    ...overrides,
  };
}

// ---- computeCacheEfficiencyByAgent (unit) ----

describe("computeCacheEfficiencyByAgent", () => {
  test("empty summaries → []", () => {
    expect(computeCacheEfficiencyByAgent([])).toEqual([]);
  });

  test("aggregates mean_cache_hit_ratio, token sums, and sample_count per agent_type", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            agent_type: "engineer",
            metrics: { cache_creation_tokens: 200, cache_hit_ratio: 0.8, cache_read_tokens: 1000 },
            step_id: "implement",
          }),
          makeStepOutcome({
            agent_type: "reviewer",
            metrics: { cache_creation_tokens: 50, cache_hit_ratio: 0.4, cache_read_tokens: 500 },
            step_id: "review",
          }),
        ],
      }),
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            agent_type: "engineer",
            metrics: { cache_creation_tokens: 100, cache_hit_ratio: 0.6, cache_read_tokens: 2000 },
            step_id: "fix",
          }),
        ],
      }),
    ];

    const result = computeCacheEfficiencyByAgent(summaries);

    const engineer = result.find((r) => r.agent_type === "engineer");
    expect(engineer).toEqual({
      agent_type: "engineer",
      mean_cache_hit_ratio: 0.7,
      sample_count: 2,
      total_cache_creation_tokens: 300,
      total_cache_read_tokens: 3000,
    });

    const reviewer = result.find((r) => r.agent_type === "reviewer");
    expect(reviewer).toEqual({
      agent_type: "reviewer",
      mean_cache_hit_ratio: 0.4,
      sample_count: 1,
      total_cache_creation_tokens: 50,
      total_cache_read_tokens: 500,
    });
  });

  test("token sums present but mean_cache_hit_ratio omitted when no step carries a ratio", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            agent_type: "engineer",
            metrics: { cache_creation_tokens: 100, cache_read_tokens: 500 },
          }),
        ],
      }),
    ];

    const result = computeCacheEfficiencyByAgent(summaries);
    const engineer = result.find((r) => r.agent_type === "engineer");
    expect(engineer).not.toHaveProperty("mean_cache_hit_ratio");
    expect(engineer?.total_cache_read_tokens).toBe(500);
    expect(engineer?.total_cache_creation_tokens).toBe(100);
    expect(engineer?.sample_count).toBe(1);
  });

  test("a non-number cache metric value is ignored (no NaN)", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            agent_type: "engineer",
            metrics: {
              cache_creation_tokens: 100,
              cache_hit_ratio: "not-a-number" as unknown as number,
              cache_read_tokens: 500,
            },
          }),
        ],
      }),
    ];

    const result = computeCacheEfficiencyByAgent(summaries);
    const engineer = result.find((r) => r.agent_type === "engineer");
    expect(engineer).not.toHaveProperty("mean_cache_hit_ratio");
    expect(engineer?.total_cache_read_tokens).toBe(500);
    expect(engineer?.total_cache_creation_tokens).toBe(100);
    expect(Number.isNaN(engineer?.total_cache_read_tokens)).toBe(false);
  });

  test("an agent_type that ran but never recorded cache metrics contributes no row", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({ agent_type: "scribe", metrics: undefined }),
          makeStepOutcome({ agent_type: "scribe", metrics: {} }),
        ],
      }),
    ];

    const result = computeCacheEfficiencyByAgent(summaries);
    expect(result.find((r) => r.agent_type === "scribe")).toBeUndefined();
  });

  test("empty-string agent_type buckets as 'unknown'", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            agent_type: "",
            metrics: { cache_hit_ratio: 0.5, cache_read_tokens: 10 },
          }),
        ],
      }),
    ];

    const result = computeCacheEfficiencyByAgent(summaries);
    expect(result.map((r) => r.agent_type)).toEqual(["unknown"]);
  });

  test("results sorted deterministically by agent_type", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({ agent_type: "reviewer", metrics: { cache_read_tokens: 1 } }),
          makeStepOutcome({ agent_type: "architect", metrics: { cache_read_tokens: 1 } }),
          makeStepOutcome({ agent_type: "engineer", metrics: { cache_read_tokens: 1 } }),
        ],
      }),
    ];

    const result = computeCacheEfficiencyByAgent(summaries);
    expect(result.map((r) => r.agent_type)).toEqual(["architect", "engineer", "reviewer"]);
  });
});

// ---- Wiring into analyzeCrossRunPatterns (integration) ----

describe("analyzeCrossRunPatterns — cache_efficiency wiring", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("empty summaries → cache_efficiency is []", () => {
    const result = analyzeCrossRunPatterns(store, []);
    expect(result.cache_efficiency).toEqual([]);
  });

  test("cache_efficiency reflects step_outcomes across summaries", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            agent_type: "engineer",
            metrics: { cache_creation_tokens: 10, cache_hit_ratio: 0.9, cache_read_tokens: 90 },
          }),
        ],
      }),
    ];

    const result = analyzeCrossRunPatterns(store, summaries);
    expect(result.cache_efficiency).toEqual([
      {
        agent_type: "engineer",
        mean_cache_hit_ratio: 0.9,
        sample_count: 1,
        total_cache_creation_tokens: 10,
        total_cache_read_tokens: 90,
      },
    ]);
  });

  test("regression: existing CrossRunAnalysisResult fields still present and unchanged", () => {
    const result = analyzeCrossRunPatterns(store, []);
    expect(result).toHaveProperty("recurring_violations");
    expect(result).toHaveProperty("fix_cycle_patterns");
    expect(result).toHaveProperty("agent_performance_trends");
    expect(result).toHaveProperty("planner_patterns");
    expect(result).toHaveProperty("craft_drift");
    expect(result).toHaveProperty("cliff_events");
    expect(result).toHaveProperty("total_archived_runs");
    expect(result).toHaveProperty("analysis_window");
    expect(result).toHaveProperty("cache_efficiency");
  });
});
