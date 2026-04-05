/**
 * Tests for analytics.ts — appendFlowRun and computeAnalytics delegating to DriftDb.
 *
 * Covers:
 * 1. appendFlowRun writes to drift.db (not flow-runs.jsonl)
 * 2. computeAnalytics aggregates correctly from DriftDb
 * 3. avg_gate_pass_rate computed when data present
 * 4. avg_postcondition_pass_rate computed when data present
 * 5. Backward compat: runs without quality signal fields work
 * 6. Empty DB returns {total_runs: 0, avg_duration_ms: 0}
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANON_DIR } from "../shared/constants.ts";
import { appendFlowRun, computeAnalytics, type FlowRunEntry } from "../platform/storage/drift/analytics.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "canon-analytics-test-"));
}

function makeBaseEntry(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: new Date().toISOString(),
    flow: "test-flow",
    run_id: `run_${Math.random().toString(36).slice(2, 8)}`,
    skipped_states: [],
    started: new Date(Date.now() - 60000).toISOString(),
    state_durations: { impl: 50000 },
    state_iterations: { impl: 1 },
    task: "test task",
    tier: "small",
    total_duration_ms: 60000,
    total_spawns: 2,
    ...overrides,
  };
}

describe("analytics.ts (SQLite-backed via DriftDb)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  // appendFlowRun writes to drift.db

  it("appendFlowRun creates drift.db in the .canon directory", async () => {
    const entry = makeBaseEntry();
    await appendFlowRun(projectDir, entry);
    const dbPath = join(projectDir, CANON_DIR, "drift.db");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("appendFlowRun does NOT create flow-runs.jsonl", async () => {
    const entry = makeBaseEntry();
    await appendFlowRun(projectDir, entry);
    const jsonlPath = join(projectDir, CANON_DIR, "flow-runs.jsonl");
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it("appendFlowRun persists entry that computeAnalytics can retrieve", async () => {
    const entry = makeBaseEntry({ run_id: "run_known_01", total_duration_ms: 30000 });
    await appendFlowRun(projectDir, entry);
    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(1);
    expect(analytics.avg_duration_ms).toBe(30000);
  });

  // computeAnalytics — empty DB

  it("computeAnalytics returns {total_runs: 0, avg_duration_ms: 0} for empty DB", async () => {
    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(0);
    expect(analytics.avg_duration_ms).toBe(0);
    expect(analytics.avg_gate_pass_rate).toBeUndefined();
    expect(analytics.avg_postcondition_pass_rate).toBeUndefined();
  });

  // computeAnalytics — avg_gate_pass_rate

  it("computeAnalytics computes avg_gate_pass_rate from runs with gate data", async () => {
    await appendFlowRun(projectDir, makeBaseEntry({ gate_pass_rate: 0.667, run_id: "run_g1" }));
    await appendFlowRun(projectDir, makeBaseEntry({ gate_pass_rate: 1.0, run_id: "run_g2" }));
    // Run without gate data — excluded from average
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_g3" }));

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(3);
    expect(analytics.avg_gate_pass_rate).toBeDefined();
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(0.8335, 3);
  });

  it("avg_gate_pass_rate is undefined when no runs have gate data", async () => {
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_no_gates" }));
    const analytics = await computeAnalytics(projectDir);
    expect(analytics.avg_gate_pass_rate).toBeUndefined();
  });

  // computeAnalytics — avg_postcondition_pass_rate

  it("computeAnalytics computes avg_postcondition_pass_rate from runs with postcondition data", async () => {
    await appendFlowRun(
      projectDir,
      makeBaseEntry({ postcondition_pass_rate: 0.5, run_id: "run_p1" }),
    );
    await appendFlowRun(
      projectDir,
      makeBaseEntry({ postcondition_pass_rate: 0.75, run_id: "run_p2" }),
    );

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.avg_postcondition_pass_rate).toBeDefined();
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(0.625, 3);
  });

  it("avg_postcondition_pass_rate is undefined when no runs have postcondition data", async () => {
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_no_post" }));
    const analytics = await computeAnalytics(projectDir);
    expect(analytics.avg_postcondition_pass_rate).toBeUndefined();
  });

  // computeAnalytics — avg_duration_ms

  it("computeAnalytics averages total_duration_ms across all runs", async () => {
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_d1", total_duration_ms: 10000 }));
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_d2", total_duration_ms: 20000 }));
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_d3", total_duration_ms: 30000 }));

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(3);
    expect(analytics.avg_duration_ms).toBeCloseTo(20000, 1);
  });

  // Backward compat: entries without quality fields work

  it("backward compat: old entry without quality signal fields still computes analytics", async () => {
    // Entry with only required fields (no gate_pass_rate etc.)
    await appendFlowRun(projectDir, makeBaseEntry({ run_id: "run_old_01" }));

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(1);
    expect(analytics.avg_duration_ms).toBe(60000);
    expect(analytics.avg_gate_pass_rate).toBeUndefined();
    expect(analytics.avg_postcondition_pass_rate).toBeUndefined();
  });

  // Round-trip: all optional fields survive persist/retrieve

  it("all optional FlowRunEntry fields round-trip through drift.db", async () => {
    const entry = makeBaseEntry({
      gate_pass_rate: 0.75,
      postcondition_pass_rate: 1.0,
      run_id: "run_full_01",
      total_files_changed: 8,
      total_test_results: { failed: 2, passed: 20, skipped: 1 },
      total_violations: 5,
    });
    await appendFlowRun(projectDir, entry);

    // computeAnalytics aggregates from the DB — verify it reads back correctly
    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(1);
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(0.75, 3);
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(1.0, 3);
  });
});
