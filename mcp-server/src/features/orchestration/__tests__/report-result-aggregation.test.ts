/**
 * report-result-aggregation.test.ts — Tests for parallel_results aggregation,
 * progress_line append, and quality signals in reportResult.
 *
 * All workspace setup uses ExecutionStore instead of readBoard/writeBoard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow as FlowType } from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { reportResult } from "../tools/report-result.ts";

function makeMinimalFlow(overrides?: Partial<FlowType>): FlowType {
  return {
    description: "A test flow",
    entry: "build",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      build: {
        transitions: {
          done: "review",
          failed: "hitl",
        },
        type: "single",
      },
      hitl: { type: "terminal" },
      review: {
        transitions: {
          done: "ship",
        },
        type: "single",
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "report-result-agg-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupWorkspace(workspace: string, flow: FlowType): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

afterEach(() => {
  clearStoreCache();

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
});

// parallel_results aggregation

describe("reportResult — parallel_results aggregation", () => {
  function makeFlowWithParallelTransitions(): FlowType {
    return makeMinimalFlow({
      states: {
        build: {
          transitions: {
            blocked: "hitl",
            cannot_fix: "hitl",
            done: "review",
            failed: "hitl",
          },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
  }

  it("all-done parallel_results produces 'done' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "done" },
      ],
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });

  it("all-cannot_fix parallel_results produces 'cannot_fix' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "cannot_fix" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("cannot_fix");
    expect(result.next_state).toBe("hitl");
  });

  it("mixed done/cannot_fix parallel_results produces 'done' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });

  it("any-blocked parallel_results produces 'blocked' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "blocked" },
      ],
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("blocked");
    expect(result.hitl_required).toBe(true);
  });

  it("parallel_results is stored on BoardStateEntry", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const parallelResults = [
      { artifacts: ["summary.md"], item: "file-a.ts", status: "done" },
      { item: "file-b.ts", status: "done" },
    ];

    const result = await reportResult({
      flow,
      parallel_results: parallelResults,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.parallel_results).toEqual(parallelResults);
  });

  it("absent parallel_results does not override condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
    expect(result.board.states.build.parallel_results).toBeUndefined();
  });

  it("empty parallel_results array does not override condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      parallel_results: [],
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });
});

// Progress line append

describe("reportResult — progress_line", () => {
  it("appends progress_line to store when provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    await reportResult({
      flow,
      progress_line: "- [build] done: Built successfully",
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const progress = store.getProgress();
    expect(progress).toContain("- [build] done: Built successfully");
  });

  it("does not write any progress entries when progress_line is omitted", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const progress = store.getProgress();
    expect(progress).toBe("");
  });
});

// Quality signals persistence

describe("reportResult — quality signals", () => {
  it("persists gate_results to state metrics and top-level", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const gateResults = [
      { command: "npm test", exitCode: 0, gate: "npm test", output: "All pass", passed: true },
    ];

    const result = await reportResult({
      flow,
      gate_results: gateResults,
      metrics: { duration_ms: 1000, model: "sonnet", spawns: 1 },
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.gate_results).toEqual(gateResults);
    expect(result.board.states.build.metrics?.gate_results).toEqual(gateResults);

    // Verify persisted in SQLite
    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    expect(state?.gate_results).toEqual(gateResults);
  });

  it("persists postcondition_results to state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const postconditionResults = [
      { name: "file_exists", output: "File found", passed: true, type: "file_exists" as const },
    ];

    const result = await reportResult({
      flow,
      metrics: { duration_ms: 1000, model: "sonnet", spawns: 1 },
      postcondition_results: postconditionResults,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.postcondition_results).toEqual(postconditionResults);
  });

  it("persists violation_count and violation_severities to metrics", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      metrics: { duration_ms: 1000, model: "sonnet", spawns: 1 },
      state_id: "build",
      status_keyword: "DONE",
      violation_count: 3,
      violation_severities: { blocking: 1, warning: 2 },
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.metrics?.violation_count).toBe(3);
    expect(result.board.states.build.metrics?.violation_severities).toEqual({
      blocking: 1,
      warning: 2,
    });
  });

  it("persists test_results to metrics", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      metrics: { duration_ms: 1000, model: "sonnet", spawns: 1 },
      state_id: "build",
      status_keyword: "DONE",
      test_results: { failed: 0, passed: 50, skipped: 1 }, // zero failures — no baseline evidence needed
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.metrics?.test_results).toEqual({
      failed: 0,
      passed: 50,
      skipped: 1,
    });
  });

  it("does not record metrics when no signal fields provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
      // No metrics or signal fields
    });
    assertOk(result);

    expect(result.board.states.build.metrics).toBeUndefined();
  });
});
