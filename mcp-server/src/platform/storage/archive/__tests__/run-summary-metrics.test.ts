/**
 * run-summary-metrics.test.ts
 *
 * Tests for the archive-time join of recorded execution_states.metrics onto
 * RunSummary.step_outcomes[] (AC#5 — carrying record_agent_metrics counters into
 * the learner's cross-run analysis). Verifies the step_id join, the metric-less
 * pass-through, and fail-open behavior on a broken store.
 *
 * Uses real SQLite via getExecutionStore / clearStoreCache.
 * Workspace paths go through VITEST env skip of .canon/workspaces/ guard.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearStoreCache,
  getExecutionStore,
} from "../../../../domains/workspaces/execution-store-cache.ts";
import { buildRunSummary } from "../run-summary-builder.ts";

// ---- helpers ----

function makeTempWorkspace(): string {
  // VITEST env bypasses the .canon/workspaces/ path guard in getExecutionStore
  return mkdtempSync(join(tmpdir(), "run-summary-metrics-test-"));
}

function baseMetadata() {
  return {
    branch: "test/branch",
    flow: "test-flow",
    tier: "small",
    task: "test task",
    archivedAt: new Date().toISOString(),
  };
}

function writeJournal(workspace: string, steps: Record<string, unknown>[]): void {
  writeFileSync(join(workspace, "journal.json"), JSON.stringify({ steps }, null, 2), "utf-8");
}

afterEach(() => {
  clearStoreCache();
});

// ---- join by step_id ----

describe("buildRunSummary — recorded metrics join", () => {
  test("carries recorded counters onto the matching step_outcomes[].metrics", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    writeJournal(workspace, [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "done",
        started_at: "2026-07-07T00:00:00.000Z",
        completed_at: "2026-07-07T00:10:00.000Z",
        artifacts_expected: [],
      },
    ]);

    store.upsertState("implement", { entries: 0, status: "done" });
    store.updateStateMetrics("implement", {
      tool_calls: 5,
      turns: 3,
      stage_metrics: { review: { violations: 2 } },
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.step_outcomes).toHaveLength(1);
    expect(summary.step_outcomes[0].metrics).toEqual({
      tool_calls: 5,
      turns: 3,
      stage_metrics: { review: { violations: 2 } },
    });

    rmSync(workspace, { recursive: true, force: true });
  });

  test("a step with no recorded metrics has metrics undefined", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    writeJournal(workspace, [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "done",
        started_at: "2026-07-07T00:00:00.000Z",
        completed_at: "2026-07-07T00:10:00.000Z",
        artifacts_expected: [],
      },
      {
        step_id: "review",
        agent_type: "reviewer",
        status: "done",
        started_at: "2026-07-07T00:10:00.000Z",
        completed_at: "2026-07-07T00:20:00.000Z",
        artifacts_expected: [],
      },
    ]);

    store.upsertState("implement", { entries: 0, status: "done" });
    store.updateStateMetrics("implement", { tool_calls: 5 });
    // "review" has no state row / no recorded metrics at all.

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    const implement = summary.step_outcomes.find((s) => s.step_id === "implement");
    const review = summary.step_outcomes.find((s) => s.step_id === "review");
    expect(implement?.metrics).toEqual({ tool_calls: 5 });
    expect(review?.metrics).toBeUndefined();

    rmSync(workspace, { recursive: true, force: true });
  });

  test("orchestrator-only structured fields (e.g. gate_results) are dropped, not carried", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    writeJournal(workspace, [
      {
        step_id: "verify",
        agent_type: "tester",
        status: "done",
        started_at: "2026-07-07T00:00:00.000Z",
        completed_at: "2026-07-07T00:05:00.000Z",
        artifacts_expected: [],
      },
    ]);

    // upsertState's `metrics` field is the full StateMetrics shape (unlike
    // updateStateMetrics, whose parameter type is intentionally narrower) — used
    // here to seed a gate_results array directly, as the orchestrator does.
    store.upsertState("verify", {
      entries: 0,
      status: "done",
      metrics: { turns: 2, gate_results: [{ gate: "build", passed: true }] },
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.step_outcomes[0].metrics).toEqual({ turns: 2 });

    rmSync(workspace, { recursive: true, force: true });
  });
});

// ---- fail-open ----

describe("buildRunSummary — recorded metrics join fails open", () => {
  test("a store-open error leaves step_outcomes intact with no metrics attached", () => {
    // Force getExecutionStore's `new Database(dbPath)` to throw by pre-creating a
    // directory at the orchestration.db path — joinRecordedMetrics must catch the
    // error and leave the already-extracted step_outcomes untouched (buildRunSummary
    // never throws).
    const workspace = mkdtempSync(join(tmpdir(), "run-summary-metrics-broken-"));
    mkdirSync(join(workspace, "orchestration.db"));

    writeJournal(workspace, [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "done",
        started_at: "2026-07-07T00:00:00.000Z",
        completed_at: "2026-07-07T00:10:00.000Z",
        artifacts_expected: [],
      },
    ]);

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    // Must not throw — step_outcomes still produced from journal.json.
    expect(summary.step_outcomes).toHaveLength(1);
    expect(summary.step_outcomes[0].step_id).toBe("implement");
    expect(summary.step_outcomes[0].metrics).toBeUndefined();
    expect(summary.version).toBe(1);

    rmSync(workspace, { recursive: true, force: true });
  });
});
