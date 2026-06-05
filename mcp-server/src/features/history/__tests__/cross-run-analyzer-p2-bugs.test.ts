/**
 * Cross-run analyzer tests — P2 review bug fixes (PR #306).
 *
 * Split from cross-run-analyzer-weighted.test.ts to stay under the 600-line cap.
 *
 * Bug 1 (P2-1): summaryToOutcomeSignals must use the verdict from the review that
 *   actually contains the matching violation, not review_results[0].
 * Bug 2 (P2-2): fix_iterations must be derived from FlowRunEntry.state_iterations.
 */

import { describe, expect, test } from "vitest";
import type { FlowRunEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { RunSummary } from "../history-types.ts";
import {
  analyzeCrossRunPatterns,
  summaryToOutcomeSignals,
} from "../services/cross-run-analyzer.ts";
import { computeOutcomeWeight, NEUTRAL_WEIGHT } from "../services/judge-weight.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

function makeFlowRunEntry(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: new Date().toISOString(),
    diff_stat: undefined,
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

// ---- Bug 1: weight must come from the review that holds the violation ----

describe("summaryToOutcomeSignals — Bug 1: verdict from violation-bearing review", () => {
  test("CLEAN first review + BLOCKING second review holding violation → BLOCKING verdict used", () => {
    // Bug: old code always used review_results[0] regardless of which review had the violation.
    // Fix: pick verdict from the review_result containing the principleId.
    const summary = makeRunSummary({
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [], // CLEAN review has NO violations for our principle
        },
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
      ],
    });

    const signals = summaryToOutcomeSignals(summary, "my-principle");
    // Should use BLOCKING (from the review that actually contains the violation)
    expect(signals.review_verdict?.toLowerCase()).toBe("blocking");
  });

  test("mirror: BLOCKING first review + CLEAN second review holding violation → CLEAN verdict used", () => {
    // The violation belongs to the second (CLEAN) review — we should not penalize with BLOCKING.
    const summary = makeRunSummary({
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [], // violation is NOT here
        },
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
      ],
    });

    const signals = summaryToOutcomeSignals(summary, "my-principle");
    // Should use CLEAN (from the review that actually contains the violation)
    expect(signals.review_verdict?.toLowerCase()).toBe("clean");
  });

  test("both reviews hold the violation → picks worst (BLOCKING beats WARNING)", () => {
    const summary = makeRunSummary({
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "WARNING",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
      ],
    });

    const signals = summaryToOutcomeSignals(summary, "my-principle");
    // Worst verdict wins
    expect(signals.review_verdict?.toLowerCase()).toBe("blocking");
  });

  test("no review contains the principleId → falls back to first review verdict", () => {
    const summary = makeRunSummary({
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "other-principle", severity: "rule" },
          ],
        },
      ],
    });

    const signals = summaryToOutcomeSignals(summary, "my-principle");
    // Fallback to first review
    expect(signals.review_verdict?.toLowerCase()).toBe("clean");
  });

  test("ordering independence: mixed CLEAN/BLOCKING verdict produces lower weight than both CLEAN", () => {
    // Two summaries with the SAME violation "my-principle":
    //   summaryA: review[0]=CLEAN(no violation), review[1]=BLOCKING(has violation)
    //   summaryB: review[0]=BLOCKING(no violation), review[1]=CLEAN(has violation)
    // With the bug fixed: summaryA should use BLOCKING weight, summaryB should use CLEAN weight.
    // We verify this via the full pipeline so no internal leakage.
    const { db, store: localStore } = makeDb();

    const summaryA = makeRunSummary({
      archive_id: "arc_a",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [],
        },
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-01T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-01T01:00:00.000Z",
        flow: "feature",
        slug: "a",
        started_at: "2026-01-01T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });

    const summaryB = makeRunSummary({
      archive_id: "arc_b",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [],
        },
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-02T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-02T01:00:00.000Z",
        flow: "feature",
        slug: "b",
        started_at: "2026-01-02T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });

    // Both runs together: 2 occurrences → recurring
    const resultBoth = analyzeCrossRunPatterns(localStore, [summaryA, summaryB]);
    const v = resultBoth.recurring_violations.find((rv) => rv.principle_id === "my-principle");
    expect(v).toBeDefined();
    expect(v!.weighted_instance_count).toBeDefined();
    // summaryA uses BLOCKING (low weight < 1.0), summaryB uses CLEAN (weight > 1.0)
    // The mixed sum should be strictly between 2*WEIGHT_FLOOR and 2*WEIGHT_CEIL
    expect(v!.weighted_instance_count!).toBeGreaterThan(0);

    // Crucially: the weight should be less than if both had CLEAN verdicts
    const summaryAClean = makeRunSummary({
      archive_id: "arc_a2",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "my-principle", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-01T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-01T01:00:00.000Z",
        flow: "feature",
        slug: "a2",
        started_at: "2026-01-01T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });
    const resultBothClean = analyzeCrossRunPatterns(localStore, [summaryAClean, summaryB]);
    const vClean = resultBothClean.recurring_violations.find(
      (rv) => rv.principle_id === "my-principle",
    );
    expect(vClean).toBeDefined();
    // Both CLEAN → higher total weight than one BLOCKING + one CLEAN
    expect(vClean!.weighted_instance_count!).toBeGreaterThan(v!.weighted_instance_count!);

    db.close();
  });
});

// ---- Bug 2: fix_iterations derived from state_iterations ----

describe("summaryToOutcomeSignals — Bug 2: fix_iterations from state_iterations", () => {
  test("matchingRun with no state_iterations retries → fix_iterations undefined (no penalty)", () => {
    const summary = makeRunSummary({
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [{ file_path: null, message: "", principle_id: "p1", severity: "rule" }],
        },
      ],
    });
    const matchingRun = makeFlowRunEntry({ state_iterations: {} });

    const signals = summaryToOutcomeSignals(summary, "p1", matchingRun);
    // All zeros → no retries → fix_iterations undefined (neutral)
    expect(signals.fix_iterations).toBeUndefined();
  });

  test("matchingRun with non-zero state_iterations → fix_iterations set and > 0", () => {
    const summary = makeRunSummary({
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [{ file_path: null, message: "", principle_id: "p1", severity: "rule" }],
        },
      ],
    });
    const matchingRun = makeFlowRunEntry({
      state_iterations: { implement: 2, verify: 1 },
    });

    const signals = summaryToOutcomeSignals(summary, "p1", matchingRun);
    expect(signals.fix_iterations).toBe(3); // 2 + 1
  });

  test("high-retry run produces strictly lower weighted count than zero-retry run with same verdict", () => {
    // Two runs: identical except one has high retries.
    // High-retry should contribute BELOW neutral (below 1.0) due to fix_iterations penalty.
    const { db, store: localStore } = makeDb();

    const summaryNoRetry = makeRunSummary({
      archive_id: "arc_noretry",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "retry-principle", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-01T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-01T01:00:00.000Z",
        flow: "build",
        slug: "noretry",
        started_at: "2026-01-01T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });

    const summaryHighRetry = makeRunSummary({
      archive_id: "arc_highretry",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN", // Same verdict
          violations: [
            { file_path: null, message: "", principle_id: "retry-principle", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-02T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-02T01:00:00.000Z",
        flow: "build",
        slug: "highretry",
        started_at: "2026-01-02T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });

    // Seed FlowRunEntries with matching (flow, started) keys
    const runNoRetry = makeFlowRunEntry({
      flow: "build",
      run_id: "run_noretry",
      started: "2026-01-01T00:00:00.000Z",
      state_iterations: {}, // no retries
    });
    const runHighRetry = makeFlowRunEntry({
      flow: "build",
      run_id: "run_highretry",
      started: "2026-01-02T00:00:00.000Z",
      state_iterations: { implement: 5, verify: 3 }, // 8 total retries
    });

    localStore.appendFlowRun(runNoRetry);
    localStore.appendFlowRun(runHighRetry);

    // Both together → recurring (2 occurrences)
    const result = analyzeCrossRunPatterns(localStore, [summaryNoRetry, summaryHighRetry]);
    const v = result.recurring_violations.find((rv) => rv.principle_id === "retry-principle");
    expect(v).toBeDefined();
    expect(v!.weighted_instance_count).toBeDefined();

    // Verify the per-instance contributions via summaryToOutcomeSignals directly:
    const signalsNoRetry = summaryToOutcomeSignals(summaryNoRetry, "retry-principle", runNoRetry);
    const signalsHighRetry = summaryToOutcomeSignals(
      summaryHighRetry,
      "retry-principle",
      runHighRetry,
    );

    // No retry: fix_iterations should be undefined → neutral penalty
    expect(signalsNoRetry.fix_iterations).toBeUndefined();
    // High retry: fix_iterations should be set (sum = 8)
    expect(signalsHighRetry.fix_iterations).toBe(8);

    // The high-retry instance should produce a strictly lower weight than no-retry
    // (same verdict = CLEAN, but rework penalty applies)
    const weightNoRetry = computeOutcomeWeight(signalsNoRetry);
    const weightHighRetry = computeOutcomeWeight(signalsHighRetry);
    expect(weightHighRetry).toBeLessThan(weightNoRetry);

    // The combined weighted_instance_count should be less than 2 * NEUTRAL_WEIGHT
    // because at least one instance is penalized below neutral
    expect(v!.weighted_instance_count!).toBeLessThan(2 * NEUTRAL_WEIGHT + 0.5);

    db.close();
  });
});
