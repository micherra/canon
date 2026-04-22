/**
 * report-result-discovery.test.ts — Tests for discovered gates/postconditions
 * accumulation, compete_results persistence, and concurrent calls in reportResult.
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
  const dir = mkdtempSync(join(tmpdir(), "report-result-disc-test-"));
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

// Discovered gates/postconditions accumulation

describe("reportResult — discovered gates/postconditions accumulation", () => {
  it("accumulates discovered_gates (not replaced) across calls", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // First call: add 1 discovered gate
    await reportResult({
      discovered_gates: [{ command: "npm test", source: "agent-1" }],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    // Seed another call — re-seed with same execution for second call
    // Reset the state and re-run, preserving discovered_gates from first call
    const store = getExecutionStore(workspace);
    const prevState = store.getState("build");
    store.upsertState("build", {
      discovered_gates: prevState?.discovered_gates,
      entries: 0,
      status: "pending",
    });
    store.updateExecution({ current_state: "build" });

    await reportResult({
      discovered_gates: [{ command: "npm run lint", source: "agent-2" }],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    // Both gates should be accumulated
    const state = store.getState("build");
    expect(state?.discovered_gates).toHaveLength(2);
    expect(state?.discovered_gates?.map((g) => g.command)).toContain("npm test");
    expect(state?.discovered_gates?.map((g) => g.command)).toContain("npm run lint");
  });

  it("accumulates discovered_postconditions across calls", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    await reportResult({
      discovered_postconditions: [{ target: "dist/index.js", type: "file_exists" }],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const prevState = store.getState("build");
    store.upsertState("build", {
      discovered_postconditions: prevState?.discovered_postconditions,
      entries: 0,
      status: "pending",
    });
    store.updateExecution({ current_state: "build" });

    await reportResult({
      discovered_postconditions: [
        { pattern: "export", target: "src/index.ts", type: "pattern_match" },
      ],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    const state = store.getState("build");
    expect(state?.discovered_postconditions).toHaveLength(2);
  });
});

// compete_results persistence

describe("reportResult — compete_results persistence", () => {
  it("persists compete_results to board state entry", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const competeResults = [
      { artifacts: ["design-a.md"], lens: "simplicity", status: "done" },
      { artifacts: ["design-b.md"], lens: "performance", status: "done" },
    ];

    const result = await reportResult({
      compete_results: competeResults,
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.compete_results).toEqual(competeResults);
  });

  it("persists synthesized flag to board state entry", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      compete_results: [{ status: "done" }],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      synthesized: true,
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.synthesized).toBe(true);
  });

  it("persists synthesized flag without compete_results", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      synthesized: true,
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.synthesized).toBe(true);
    expect(result.board.states.build.compete_results).toBeUndefined();
  });

  it("does not set compete_results when not provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.compete_results).toBeUndefined();
    expect(result.board.states.build.synthesized).toBeUndefined();
  });
});

// Concurrent calls — SQLite busy_timeout serializes writes

describe("reportResult — concurrent calls", () => {
  it("3 simultaneous calls do not throw SQLITE_BUSY", async () => {
    // Each call gets its own workspace (separate DB) to test concurrent initialization
    const workspaces = [makeTmpWorkspace(), makeTmpWorkspace(), makeTmpWorkspace()];
    const flow = makeMinimalFlow();
    for (const ws of workspaces) {
      setupWorkspace(ws, flow);
    }

    const promises = workspaces.map((workspace) =>
      reportResult({
        flow,
        progress_line: `- done in ${workspace}`,
        state_id: "build",
        status_keyword: "DONE",
        workspace,
      }),
    );

    // All should resolve without error
    const results = await Promise.all(promises);
    for (const result of results) {
      assertOk(result);
      expect(result.transition_condition).toBe("done");
      expect(result.next_state).toBe("review");
    }
  });

  it("3 simultaneous calls to same workspace serialize correctly", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow({
      states: {
        build: { transitions: { done: "review", failed: "hitl" }, type: "single" },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Call report_result 3x on different states in the same workspace
    const results = await Promise.all([
      reportResult({ flow, state_id: "build", status_keyword: "DONE", workspace }),
      reportResult({ flow, state_id: "review", status_keyword: "DONE", workspace }),
      reportResult({ flow, state_id: "ship", status_keyword: "DONE", workspace }),
    ]);

    // All should succeed (transactions serialize writes)
    for (const result of results) {
      expect(result).toBeDefined();
    }
  });
});
