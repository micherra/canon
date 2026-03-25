import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { computeAnalytics, appendFlowRun, getFlowRuns, type FlowRunEntry } from "../drift/analytics.ts";
import { DriftStore } from "../drift/store.ts";
import type { ReviewEntry } from "../schema.ts";

function makeRun(overrides?: Partial<FlowRunEntry>): FlowRunEntry {
  return {
    run_id: "run_test",
    flow: "quick-fix",
    tier: "small",
    task: "fix a bug",
    started: "2026-03-23T10:00:00Z",
    completed: "2026-03-23T10:05:00Z",
    total_duration_ms: 300000,
    state_durations: { research: 60000, implement: 180000, review: 60000 },
    state_iterations: { research: 1, implement: 1, review: 2 },
    skipped_states: [],
    total_spawns: 4,
    ...overrides,
  };
}

describe("computeAnalytics", () => {
  it("returns empty analytics for no runs", () => {
    const result = computeAnalytics([]);
    expect(result.total_runs).toBe(0);
    expect(result.by_flow).toEqual({});
    expect(result.bottleneck_states).toEqual([]);
  });

  it("computes per-flow stats", () => {
    const runs = [
      makeRun({ total_duration_ms: 200000 }),
      makeRun({ total_duration_ms: 400000 }),
      makeRun({ flow: "feature", total_duration_ms: 600000 }),
    ];
    const result = computeAnalytics(runs);
    expect(result.total_runs).toBe(3);
    expect(result.by_flow["quick-fix"].count).toBe(2);
    expect(result.by_flow["quick-fix"].avg_duration_ms).toBe(300000);
    expect(result.by_flow["feature"].count).toBe(1);
  });

  it("identifies bottleneck states sorted by avg duration", () => {
    const runs = [
      makeRun({ state_durations: { implement: 500000, review: 10000 } }),
      makeRun({ state_durations: { implement: 300000, review: 20000 } }),
    ];
    const result = computeAnalytics(runs);
    expect(result.bottleneck_states[0].state).toBe("implement");
    expect(result.bottleneck_states[0].avg_duration_ms).toBe(400000);
  });

  it("computes skip rates", () => {
    const runs = [
      makeRun({ skipped_states: ["security"], state_durations: { research: 60000, implement: 180000, security: 0 } }),
      makeRun({ skipped_states: ["security"], state_durations: { research: 60000, implement: 180000, security: 0 } }),
      makeRun({ skipped_states: [], state_durations: { research: 60000, implement: 180000, security: 30000 } }),
    ];
    const result = computeAnalytics(runs);
    expect(result.skip_rates["security"]).toBeDefined();
    expect(result.skip_rates["security"].skipped).toBe(2);
    expect(result.skip_rates["security"].total).toBe(3);
    expect(result.skip_rates["security"].rate).toBeCloseTo(0.67, 1);
  });

  it("sums total spawns", () => {
    const runs = [
      makeRun({ total_spawns: 4 }),
      makeRun({ total_spawns: 6 }),
    ];
    const result = computeAnalytics(runs);
    expect(result.total_spawns).toBe(10);
  });
});

describe("appendFlowRun / getFlowRuns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-analytics-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists and reads flow runs", async () => {
    await appendFlowRun(tmpDir, makeRun({ run_id: "run_1" }));
    await appendFlowRun(tmpDir, makeRun({ run_id: "run_2", flow: "feature" }));

    const all = await getFlowRuns(tmpDir);
    expect(all).toHaveLength(2);

    const filtered = await getFlowRuns(tmpDir, "feature");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].run_id).toBe("run_2");
  });

  it("returns empty for missing file", async () => {
    const runs = await getFlowRuns(tmpDir);
    expect(runs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compliance trend
// ---------------------------------------------------------------------------

function makeReview(overrides: Partial<ReviewEntry>): ReviewEntry {
  return {
    review_id: "rev_test",
    timestamp: "2026-03-10T10:00:00Z",
    verdict: "CLEAN",
    files: [],
    violations: [],
    honored: [],
    score: { rules: { passed: 1, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 1, total: 1 } },
    ...overrides,
  };
}

describe("DriftStore.getComplianceTrend", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-trend-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for no reviews", async () => {
    const store = new DriftStore(tmpDir);
    const trend = await store.getComplianceTrend("thin-handlers");
    expect(trend).toEqual([]);
  });

  it("computes weekly pass rates", async () => {
    const store = new DriftStore(tmpDir);

    // Week 10: 1 violation
    await store.appendReview(makeReview({
      review_id: "r1",
      timestamp: "2026-03-02T10:00:00Z",
      violations: [{ principle_id: "thin-handlers", severity: "rule" }],
    }));
    // Week 10: 1 honored
    await store.appendReview(makeReview({
      review_id: "r2",
      timestamp: "2026-03-03T10:00:00Z",
      honored: ["thin-handlers"],
    }));
    // Week 12: 1 honored
    await store.appendReview(makeReview({
      review_id: "r3",
      timestamp: "2026-03-16T10:00:00Z",
      honored: ["thin-handlers"],
    }));

    const trend = await store.getComplianceTrend("thin-handlers");
    expect(trend.length).toBeGreaterThanOrEqual(2);

    // First week has 1 violation + 1 pass = 50% pass rate
    const firstWeek = trend[0];
    expect(firstWeek.pass_rate).toBe(0.5);
    expect(firstWeek.violations).toBe(1);

    // Last week has 1 pass = 100% pass rate
    const lastWeek = trend[trend.length - 1];
    expect(lastWeek.pass_rate).toBe(1);
  });

  it("limits to N most recent weeks", async () => {
    const store = new DriftStore(tmpDir);

    // Create reviews across 3 different weeks
    await store.appendReview(makeReview({ review_id: "r1", timestamp: "2026-02-03T10:00:00Z", honored: ["p1"] }));
    await store.appendReview(makeReview({ review_id: "r2", timestamp: "2026-02-10T10:00:00Z", honored: ["p1"] }));
    await store.appendReview(makeReview({ review_id: "r3", timestamp: "2026-02-17T10:00:00Z", honored: ["p1"] }));

    const trend = await store.getComplianceTrend("p1", 2);
    expect(trend).toHaveLength(2);
  });
});
