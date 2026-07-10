/**
 * cross-run-patterns.test.ts
 *
 * Unit tests for computePerformanceTrends' aggregation of recorded per-step
 * counters (record_agent_metrics) into AgentPerformanceTrend.avg_tool_calls /
 * avg_turns / avg_orientation_calls (AC#5). All assertions call
 * computePerformanceTrends directly — pure function, no I/O.
 */

import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { describe, expect, test } from "vitest";
import type { RunSummary, StepOutcome } from "../../history-types.ts";
import { computePerformanceTrends } from "../cross-run-patterns.ts";

// ---- Helpers ----

function makeStepOutcome(overrides: Partial<StepOutcome> = {}): StepOutcome {
  return {
    agent_type: "engineer",
    artifacts_expected: [],
    completed_at: null,
    duration_ms: null,
    started_at: null,
    status: "completed",
    step_id: "implement",
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const now = new Date().toISOString();
  return {
    archive_id: `arc_${Math.random().toString(36).slice(2, 10)}`,
    artifact_inventory: { directories: [], files: [], total_files: 0 },
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
      task: "T",
      tier: "standard",
      total_duration_ms: 60_000,
    },
    step_outcomes: [],
    version: 1,
    ...overrides,
  };
}

// ---- avg_tool_calls / avg_turns / avg_orientation_calls ----

describe("computePerformanceTrends — recorded metrics aggregation", () => {
  test("computes avg_* fields from step_outcomes[].metrics across summaries", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            step_id: "implement",
            metrics: { tool_calls: 10, turns: 4, orientation_calls: 2 },
          }),
        ],
      }),
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            step_id: "implement",
            metrics: { tool_calls: 20, turns: 6, orientation_calls: 4 },
          }),
        ],
      }),
    ];

    const result = computePerformanceTrends(summaries, []);
    const trend = result.find((t) => t.flow === "feature");

    expect(trend).toBeDefined();
    expect(trend?.avg_tool_calls).toBe(15); // (10 + 20) / 2
    expect(trend?.avg_turns).toBe(5); // (4 + 6) / 2
    expect(trend?.avg_orientation_calls).toBe(3); // (2 + 4) / 2
  });

  test("sums metrics across multiple step_outcomes within one summary before averaging", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({ step_id: "implement", metrics: { tool_calls: 5 } }),
          makeStepOutcome({ step_id: "review", metrics: { tool_calls: 7 } }),
        ],
      }),
    ];

    const result = computePerformanceTrends(summaries, []);
    const trend = result.find((t) => t.flow === "feature");

    expect(trend?.avg_tool_calls).toBe(12); // 5 + 7 summed within the one run
  });

  test("omits avg_* fields entirely when no summary carried recorded metrics", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({ step_outcomes: [makeStepOutcome({ step_id: "implement" })] }),
    ];

    const result = computePerformanceTrends(summaries, []);
    const trend = result.find((t) => t.flow === "feature");

    expect(trend).toBeDefined();
    expect(trend?.avg_tool_calls).toBeUndefined();
    expect(trend?.avg_turns).toBeUndefined();
    expect(trend?.avg_orientation_calls).toBeUndefined();
    expect("avg_tool_calls" in (trend ?? {})).toBe(false);
  });

  test("averages only over the points that carried a counter, not all points", () => {
    // One summary carries tool_calls, one doesn't. Average must be over the
    // single carrying point (10), never 10/2=5 (misleadingly treating the
    // silent point as tool_calls: 0).
    const summaries: RunSummary[] = [
      makeRunSummary({
        run_metadata: {
          archived_at: "2026-01-01T00:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-01T00:00:00.000Z",
          flow: "feature",
          slug: "s1",
          started_at: "2026-01-01T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 60_000,
        },
        step_outcomes: [makeStepOutcome({ step_id: "implement", metrics: { tool_calls: 10 } })],
      }),
      makeRunSummary({
        run_metadata: {
          archived_at: "2026-01-02T00:00:00.000Z",
          branch: "main",
          completed_at: "2026-01-02T00:00:00.000Z",
          flow: "feature",
          slug: "s2",
          started_at: "2026-01-02T00:00:00.000Z",
          task: "T",
          tier: "standard",
          total_duration_ms: 60_000,
        },
        step_outcomes: [makeStepOutcome({ step_id: "implement" })],
      }),
    ];

    const result = computePerformanceTrends(summaries, []);
    const trend = result.find((t) => t.flow === "feature");

    expect(trend?.run_count).toBe(2);
    expect(trend?.avg_tool_calls).toBe(10);
  });

  test("sums staged counters (stage_metrics[stage][key]) when no top-level counter is present", () => {
    // #473's staged path (record_agent_metrics with a `stage`) nests counters under
    // metrics.stage_metrics[stage][key] instead of metrics[key]. sumRecordedCounter
    // must read that nested shape too, or staged runs contribute 0/omitted.
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            step_id: "review",
            metrics: { stage_metrics: { review: { tool_calls: 5, turns: 3 } } },
          }),
        ],
      }),
    ];

    const result = computePerformanceTrends(summaries, []);
    const trend = result.find((t) => t.flow === "feature");

    expect(trend?.avg_tool_calls).toBe(5);
    expect(trend?.avg_turns).toBe(3);
  });

  test("sums both a top-level counter and a staged counter for the same key", () => {
    const summaries: RunSummary[] = [
      makeRunSummary({
        step_outcomes: [
          makeStepOutcome({
            step_id: "review",
            metrics: {
              tool_calls: 10,
              stage_metrics: { design: { tool_calls: 4 }, review: { tool_calls: 6 } },
            },
          }),
        ],
      }),
    ];

    const result = computePerformanceTrends(summaries, []);
    const trend = result.find((t) => t.flow === "feature");

    expect(trend?.avg_tool_calls).toBe(20); // 10 top-level + 4 + 6 staged
  });

  test("FlowRunEntry-fallback points never carry avg_* — omitted when only fallback data exists", () => {
    const runs: FlowRunEntry[] = [
      {
        completed: new Date().toISOString(),
        flow: "fallback-flow",
        run_id: "run_1",
        skipped_states: [],
        started: new Date().toISOString(),
        state_durations: {},
        state_iterations: {},
        task: "T",
        tier: "standard",
        total_duration_ms: 30_000,
        total_spawns: 2,
      },
    ];

    const result = computePerformanceTrends([], runs);
    const trend = result.find((t) => t.flow === "fallback-flow");

    expect(trend).toBeDefined();
    expect(trend?.avg_tool_calls).toBeUndefined();
    expect("avg_tool_calls" in (trend ?? {})).toBe(false);
  });
});
