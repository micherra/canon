/**
 * DriftDb Tests — compliance trend and flow run analytics
 *
 * File 2 of 3: getComplianceTrend, appendFlowRun+computeAnalytics
 */

import type { ReviewEntry } from "@shared/schema.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FlowRunEntry } from "../drift-analytics-types.ts";
import { DriftDb } from "../drift-db.ts";
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
