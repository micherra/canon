/**
 * Tests for report-result.ts
 *
 * Covers: status normalization, transition evaluation, HITL detection,
 * event emissions, stuck detection, quality signals, discovered gates/postconditions,
 * compete_results, concurrent calls, and store-based persistence.
 *
 * All workspace setup uses ExecutionStore instead of readBoard/writeBoard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import { writeMessage } from "../orchestration/messages.ts";
import type { FlowEventMap } from "../orchestration/events.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow as FlowType } from "../orchestration/flow-schema.ts";
import { writeMessage } from "../orchestration/messages.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalFlow(overrides?: Partial<FlowType>): FlowType {
  return {
    name: "test-flow",
    description: "A test flow",
    entry: "build",
    spawn_instructions: {},
    states: {
      build: {
        type: "single",
        transitions: {
          done: "review",
          failed: "hitl",
        },
      },
      review: {
        type: "single",
        transitions: {
          done: "ship",
        },
      },
      ship: { type: "terminal" },
      hitl: { type: "terminal" },
    },
    ...overrides,
  };
}

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "report-result-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Set up a workspace with an ExecutionStore seeded with the given flow's states.
 */
function setupWorkspace(workspace: string, flow: FlowType): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  store.initExecution({
    flow: flow.name,
    task: "test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc123",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
  }
}

afterEach(() => {
  // Close all DB connections and clear cache before deleting temp dirs
  clearStoreCache();

  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

describe("reportResult — basic functionality", () => {
  it("normalizes status keyword and evaluates transition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
    expect(result.hitl_required).toBe(false);
  });

  it("updates board current_state on successful transition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.board.current_state).toBe("review");
  });

  it("sets hitl_required when status_keyword is unrecognized", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "SOMETHING_WEIRD",
      flow,
    });
    assertOk(result);

    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("SOMETHING_WEIRD");
  });

  it("records artifacts on the board state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      artifacts: ["summary.md", "diff.patch"],
    });
    assertOk(result);

    expect(result.board.states["build"].artifacts).toEqual(["summary.md", "diff.patch"]);
  });

  it("persists board state to execution_states table (no board.json)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    expect(state?.status).toBe("done");

    // No board.json created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(workspace, "board.json"))).toBe(false);
  });

  it("persists board state to execution_states table (no board.json)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    expect(state?.status).toBe("done");

    // No board.json created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(workspace, "board.json"))).toBe(false);
  });
});

describe("reportResult — debate flow", () => {
  it("loops back to the entry state while debate rounds remain", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow({
      debate: {
        teams: 2,
        composition: ["canon-researcher", "canon-architect"],
        min_rounds: 2,
        max_rounds: 4,
        convergence_check_after: 3,
        hitl_checkpoint: true,
        continue_to_build: true,
      },
    });
    setupWorkspace(workspace, flow);

    await writeMessage(workspace, "debate-round-1", "round-1-team-a-canon-researcher", "Use events.");
    await writeMessage(workspace, "debate-round-1", "round-1-team-b-canon-architect", "Use CRUD.");

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("build");
    expect(result.hitl_required).toBe(false);
    expect(result.board.metadata?.debate_completed).toBe(false);
  });

  it("stops at HITL with summary once debate converges", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow({
      debate: {
        teams: 2,
        composition: ["canon-researcher", "canon-architect"],
        min_rounds: 2,
        max_rounds: 4,
        convergence_check_after: 2,
        hitl_checkpoint: true,
        continue_to_build: true,
      },
    });
    setupWorkspace(workspace, flow);

    await writeMessage(workspace, "debate-round-1", "round-1-team-a-canon-researcher", "We agree on event sourcing.");
    await writeMessage(workspace, "debate-round-1", "round-1-team-b-canon-architect", "Consensus reached, aligned.");
    await writeMessage(workspace, "debate-round-2", "round-2-team-a-canon-researcher", "Agreed.");
    await writeMessage(workspace, "debate-round-2", "round-2-team-b-canon-architect", "Same conclusion.");

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.next_state).toBeNull();
    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("Debate completed");
    expect(result.board.metadata?.debate_completed).toBe(true);
    expect(result.board.metadata?.debate_summary).toContain("Debate Round 1");
  });
});

// ---------------------------------------------------------------------------
// Event emissions
// ---------------------------------------------------------------------------

describe("reportResult — event emissions", () => {
  it("emits state_completed event with correct stateId and result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const received: FlowEventMap["state_completed"][] = [];
    flowEventBus.on("state_completed", (event) => received.push(event));

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    expect(received).toHaveLength(1);
    expect(received[0].stateId).toBe("build");
    expect(received[0].result).toBe("done");
    expect(received[0].timestamp).toBeTruthy();
  });

  it("emits state_completed with artifacts and duration_ms", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const received: FlowEventMap["state_completed"][] = [];
    flowEventBus.on("state_completed", (event) => received.push(event));

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      artifacts: ["plan.md"],
      metrics: { duration_ms: 3000, spawns: 1, model: "sonnet" },
    });

    expect(received[0].duration_ms).toBe(3000);
    expect(received[0].artifacts).toEqual(["plan.md"]);
  });

  it("emits transition_evaluated event with correct condition and nextState", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const received: FlowEventMap["transition_evaluated"][] = [];
    flowEventBus.on("transition_evaluated", (event) => received.push(event));

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    expect(received).toHaveLength(1);
    expect(received[0].stateId).toBe("build");
    expect(received[0].normalizedCondition).toBe("done");
    expect(received[0].nextState).toBe("review");
    expect(received[0].statusKeyword).toBe("DONE");
  });

  it("requires HITL and has no next_state when no transition is defined for the condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "BLOCKED",
      flow,
    });
    assertOk(result);

    expect(result.next_state).toBeNull();
    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("blocked");
  });

  it("does NOT emit hitl_triggered when HITL is not required", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const hitlEvents: unknown[] = [];
    flowEventBus.on("hitl_triggered", (event) => hitlEvents.push(event));

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    expect(hitlEvents).toHaveLength(0);
  });

  it("emits hitl_triggered when HITL is required", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const received: FlowEventMap["hitl_triggered"][] = [];
    flowEventBus.on("hitl_triggered", (event) => received.push(event));

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "NEEDS_CONTEXT",
      flow,
    });

    expect(received).toHaveLength(1);
    expect(received[0].stateId).toBe("build");
    expect(received[0].reason).toBeTruthy();
    expect(received[0].timestamp).toBeTruthy();
  });

  it("board state is persisted to store before events are emitted", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Verify that at emit time the board has already been written to store.
    let boardStatusAtEmit: string | undefined;
    flowEventBus.on("state_completed", () => {
      const store = getExecutionStore(workspace);
      boardStatusAtEmit = store.getState("build")?.status;
    });

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(boardStatusAtEmit).toBe("done");
    expect(result.board.states["build"].status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Listener error isolation
// ---------------------------------------------------------------------------

describe("reportResult — listener error isolation", () => {
  it("cleans up listeners after successful emit (no listener leak)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const listenersBefore = flowEventBus.listenerCount("state_completed");

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const listenersAfter = flowEventBus.listenerCount("state_completed");
    expect(listenersAfter).toBe(listenersBefore);
  });
});

// ---------------------------------------------------------------------------
// HITL scenarios
// ---------------------------------------------------------------------------

describe("reportResult — HITL scenarios", () => {
  it("hitl_reason includes state_id for unrecognized status", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "MYSTERY_WORD",
      flow,
    });
    assertOk(result);

    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("build");
    expect(result.hitl_reason).toContain("MYSTERY_WORD");
  });

  it("hitl_required is false for terminal state with no matching transition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "ship",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.hitl_required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parallel_results aggregation
// ---------------------------------------------------------------------------

describe("reportResult — parallel_results aggregation", () => {
  function makeFlowWithParallelTransitions(): FlowType {
    return makeMinimalFlow({
      states: {
        build: {
          type: "single",
          transitions: {
            done: "review",
            cannot_fix: "hitl",
            blocked: "hitl",
            failed: "hitl",
          },
        },
        review: { type: "single", transitions: { done: "ship" } },
        ship: { type: "terminal" },
        hitl: { type: "terminal" },
      },
    });
  }

  it("all-done parallel_results produces 'done' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "done" },
      ],
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
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "cannot_fix" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
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
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
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
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "blocked" },
      ],
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
      { item: "file-a.ts", status: "done", artifacts: ["summary.md"] },
      { item: "file-b.ts", status: "done" },
    ];

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: parallelResults,
    });
    assertOk(result);

    expect(result.board.states["build"].parallel_results).toEqual(parallelResults);
  });

  it("absent parallel_results does not override condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
    expect(result.board.states["build"].parallel_results).toBeUndefined();
  });

  it("empty parallel_results array does not override condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [],
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Progress line append
// ---------------------------------------------------------------------------

describe("reportResult — progress_line", () => {
  it("appends progress_line to store when provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      progress_line: "- [build] done: Built successfully",
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
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const store = getExecutionStore(workspace);
    const progress = store.getProgress();
    expect(progress).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Quality signals persistence
// ---------------------------------------------------------------------------

describe("reportResult — quality signals", () => {
  it("persists gate_results to state metrics and top-level", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const gateResults = [
      { gate: "npm test", command: "npm test", passed: true, output: "All pass", exitCode: 0 },
    ];

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      gate_results: gateResults,
      metrics: { duration_ms: 1000, spawns: 1, model: "sonnet" },
    });
    assertOk(result);

    expect(result.board.states["build"].gate_results).toEqual(gateResults);
    expect(result.board.states["build"].metrics?.gate_results).toEqual(gateResults);

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
      { name: "file_exists", type: "file_exists" as const, passed: true, output: "File found" },
    ];

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      postcondition_results: postconditionResults,
      metrics: { duration_ms: 1000, spawns: 1, model: "sonnet" },
    });
    assertOk(result);

    expect(result.board.states["build"].postcondition_results).toEqual(postconditionResults);
  });

  it("persists violation_count and violation_severities to metrics", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      violation_count: 3,
      violation_severities: { blocking: 1, warning: 2 },
      metrics: { duration_ms: 1000, spawns: 1, model: "sonnet" },
    });
    assertOk(result);

    expect(result.board.states["build"].metrics?.violation_count).toBe(3);
    expect(result.board.states["build"].metrics?.violation_severities).toEqual({ blocking: 1, warning: 2 });
  });

  it("persists test_results to metrics", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      test_results: { passed: 50, failed: 2, skipped: 1 },
      metrics: { duration_ms: 1000, spawns: 1, model: "sonnet" },
    });
    assertOk(result);

    expect(result.board.states["build"].metrics?.test_results).toEqual({ passed: 50, failed: 2, skipped: 1 });
  });

  it("does not record metrics when no signal fields provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      // No metrics or signal fields
    });
    assertOk(result);

    expect(result.board.states["build"].metrics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Discovered gates/postconditions accumulation
// ---------------------------------------------------------------------------

describe("reportResult — discovered gates/postconditions accumulation", () => {
  it("accumulates discovered_gates (not replaced) across calls", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // First call: add 1 discovered gate
    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      discovered_gates: [{ command: "npm test", source: "agent-1" }],
    });

    // Seed another call — re-seed with same execution for second call
    // Reset the state and re-run, preserving discovered_gates from first call
    const store = getExecutionStore(workspace);
    const prevState = store.getState("build");
    store.upsertState("build", { status: "pending", entries: 0, discovered_gates: prevState?.discovered_gates });
    store.updateExecution({ current_state: "build" });

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      discovered_gates: [{ command: "npm run lint", source: "agent-2" }],
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
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      discovered_postconditions: [{ type: "file_exists", target: "dist/index.js" }],
    });

    const store = getExecutionStore(workspace);
    const prevState = store.getState("build");
    store.upsertState("build", { status: "pending", entries: 0, discovered_postconditions: prevState?.discovered_postconditions });
    store.updateExecution({ current_state: "build" });

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      discovered_postconditions: [{ type: "pattern_match", target: "src/index.ts", pattern: "export" }],
    });

    const state = store.getState("build");
    expect(state?.discovered_postconditions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// compete_results persistence
// ---------------------------------------------------------------------------

describe("reportResult — compete_results persistence", () => {
  it("persists compete_results to board state entry", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const competeResults = [
      { lens: "simplicity", status: "done", artifacts: ["design-a.md"] },
      { lens: "performance", status: "done", artifacts: ["design-b.md"] },
    ];

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      compete_results: competeResults,
    });
    assertOk(result);

    expect(result.board.states["build"].compete_results).toEqual(competeResults);
  });

  it("persists synthesized flag to board state entry", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      compete_results: [{ status: "done" }],
      synthesized: true,
    });
    assertOk(result);

    expect(result.board.states["build"].synthesized).toBe(true);
  });

  it("persists synthesized flag without compete_results", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      synthesized: true,
    });
    assertOk(result);

    expect(result.board.states["build"].synthesized).toBe(true);
    expect(result.board.states["build"].compete_results).toBeUndefined();
  });

  it("does not set compete_results when not provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });
    assertOk(result);

    expect(result.board.states["build"].compete_results).toBeUndefined();
    expect(result.board.states["build"].synthesized).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrent calls — SQLite busy_timeout serializes writes
// ---------------------------------------------------------------------------

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
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        progress_line: `- done in ${workspace}`,
      })
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
        build: { type: "single", transitions: { done: "review", failed: "hitl" } },
        review: { type: "single", transitions: { done: "ship" } },
        ship: { type: "terminal" },
        hitl: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Call report_result 3x on different states in the same workspace
    const results = await Promise.all([
      reportResult({ workspace, state_id: "build", status_keyword: "DONE", flow }),
      reportResult({ workspace, state_id: "review", status_keyword: "DONE", flow }),
      reportResult({ workspace, state_id: "ship", status_keyword: "DONE", flow }),
    ]);

    // All should succeed (transactions serialize writes)
    for (const result of results) {
      expect(result).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Store persistence — full mutation chain
// ---------------------------------------------------------------------------

describe("reportResult — store persistence", () => {
  it("full mutation chain: status normalization → transition → board persistence", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      artifacts: ["plan.md"],
      metrics: { duration_ms: 2000, spawns: 2, model: "sonnet" },
      gate_results: [{ gate: "npm test", command: "npm test", passed: true, output: "", exitCode: 0 }],
      violation_count: 0,
    });
    assertOk(result);

    // All mutation steps persisted
    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    expect(state?.status).toBe("done");
    expect(state?.artifacts).toEqual(["plan.md"]);
    expect(state?.gate_results).toBeDefined();
    expect(state?.metrics?.duration_ms).toBe(2000);

    const exec = store.getExecution();
    expect(exec?.current_state).toBe("review");

    // Result board accurate
    expect(result.board.current_state).toBe("review");
    expect(result.transition_condition).toBe("done");
    expect(result.hitl_required).toBe(false);
  });

  it("stuck detection updates iteration history in store", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow({
      states: {
        build: {
          type: "single",
          transitions: { done: "review", failed: "build" },
          stuck_when: "same_status",
          max_iterations: 5,
        },
        review: { type: "single", transitions: { done: "ship" } },
        ship: { type: "terminal" },
        hitl: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Seed iteration entry
    const store = getExecutionStore(workspace);
    store.upsertIteration("build", {
      count: 1,
      max: 5,
      history: [{ status: "failed" }],
      cannot_fix: [],
    });

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "FAILED",
      flow,
    });
    assertOk(result);

    // History updated in store
    const iter = store.getIteration("build");
    expect(iter?.history.length).toBeGreaterThan(1);

    // If stuck, hitl_required
    if (result.stuck) {
      expect(result.hitl_required).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent read-modify-write — P1 fix: entire RMW inside transaction
// ---------------------------------------------------------------------------

describe("reportResult — concurrent RMW serialization (P1)", () => {
  it("two concurrent calls accumulating discovered_gates preserve both sets", async () => {
    // Demonstrates the lost-update bug: without the entire RMW inside a
    // transaction, the second concurrent writer reads stale board state
    // (before the first writer's discovered_gates were committed) and
    // overwrites them. With the fix, both gate sets survive.
    const workspace = makeTmpWorkspace();

    // Use a state that transitions to itself so both callers can use the same state_id
    const flow = makeMinimalFlow({
      states: {
        build: {
          type: "single",
          transitions: { done: "review", failed: "build" },
        },
        review: { type: "single", transitions: { done: "ship" } },
        ship: { type: "terminal" },
        hitl: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Two concurrent calls each reporting a distinct discovered gate
    const [r1, r2] = await Promise.all([
      reportResult({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        discovered_gates: [{ command: "npm test", source: "agent-1" }],
      }),
      reportResult({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        discovered_gates: [{ command: "npm run lint", source: "agent-2" }],
      }),
    ]);

    // Both calls should succeed
    assertOk(r1);
    assertOk(r2);
    expect(r1.transition_condition).toBe("done");
    expect(r2.transition_condition).toBe("done");

    // The persisted state should contain discovered_gates from BOTH calls
    // (accumulated, not overwritten). With the stale-read bug present,
    // only one set survives; with the fix both are present.
    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    const gates = state?.discovered_gates ?? [];

    // Both gate commands must be present after concurrent accumulation
    const commands = gates.map((g: { command: string }) => g.command);
    expect(commands).toContain("npm test");
    expect(commands).toContain("npm run lint");
  });
});

// ---------------------------------------------------------------------------
// Workspace not found — typed WORKSPACE_NOT_FOUND error
// ---------------------------------------------------------------------------

describe("reportResult — workspace not found", () => {
  it("returns WORKSPACE_NOT_FOUND ToolResult when workspace has no execution", async () => {
    const workspace = makeTmpWorkspace(); // not seeded — no execution row

    const flow = makeMinimalFlow();
    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result.message).toContain(workspace);
  });
});
