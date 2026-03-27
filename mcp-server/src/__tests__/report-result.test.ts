/**
 * Tests for report-result.ts
 *
 * Covers: event emissions via FlowEventBus, status normalization,
 * transition evaluation, HITL detection, and listener error swallowing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportResult } from "../tools/report-result.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { writeBoard, initBoard } from "../orchestration/board.ts";
import type { FlowEventMap } from "../orchestration/events.ts";
import type { ResolvedFlow as FlowType } from "../orchestration/flow-schema.ts";

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

async function setupWorkspace(workspace: string, flow: FlowType): Promise<void> {
  const board = initBoard(flow, "test task", "abc123");
  await writeBoard(workspace, board);
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  // Remove all listeners from the singleton after each test
  flowEventBus.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

describe("reportResult — basic functionality", () => {
  it("normalizes status keyword and evaluates transition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
    expect(result.hitl_required).toBe(false);
  });

  it("updates board current_state on successful transition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    expect(result.board.current_state).toBe("review");
  });

  it("sets hitl_required when status_keyword is unrecognized", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "SOMETHING_WEIRD",
      flow,
    });

    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("SOMETHING_WEIRD");
  });

  it("records artifacts on the board state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      artifacts: ["summary.md", "diff.patch"],
    });

    expect(result.board.states["build"].artifacts).toEqual([
      "summary.md",
      "diff.patch",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Event emissions
// ---------------------------------------------------------------------------

describe("reportResult — event emissions", () => {
  it("emits state_completed event with correct stateId and result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

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
    await setupWorkspace(workspace, flow);

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
    await setupWorkspace(workspace, flow);

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
    await setupWorkspace(workspace, flow);

    // "BLOCKED" normalizes to "blocked" — no transition defined for "blocked" in makeMinimalFlow
    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "BLOCKED",
      flow,
    });

    // No matching transition → next_state is null and HITL is required
    expect(result.next_state).toBeNull();
    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("blocked");
  });

  it("does NOT emit hitl_triggered when HITL is not required", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

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
    await setupWorkspace(workspace, flow);

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

  it("board state is persisted before events are emitted", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    // Verify that at emit time the board has already been written to disk.
    // We read the board file from within the listener to confirm the written state.
    let boardStatusAtEmit: string | undefined;
    flowEventBus.on("state_completed", async () => {
      const { readBoard } = await import("../orchestration/board.ts");
      const boardOnDisk = await readBoard(workspace);
      boardStatusAtEmit = boardOnDisk.states["build"]?.status;
    });

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    // Board on disk at emit time should already reflect the completed state.
    expect(boardStatusAtEmit).toBe("done");
    // Return value also reflects completed state.
    expect(result.board.states["build"].status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Listener error isolation (test-the-sad-path)
// ---------------------------------------------------------------------------

describe("reportResult — listener error isolation", () => {
  it("cleans up listeners after successful emit (no listener leak)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    const listenersBefore = flowEventBus.listenerCount("state_completed");

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const listenersAfter = flowEventBus.listenerCount("state_completed");
    // The internal listener should be cleaned up in finally block
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
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "MYSTERY_WORD",
      flow,
    });

    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("build");
    expect(result.hitl_reason).toContain("MYSTERY_WORD");
  });

  it("hitl_required is false for terminal state with no matching transition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    // "ship" is a terminal state — no transition needed
    const result = await reportResult({
      workspace,
      state_id: "ship",
      status_keyword: "DONE",
      flow,
    });

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
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE", // overridden by aggregation
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "done" },
      ],
    });

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });

  it("all-cannot_fix parallel_results produces 'cannot_fix' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE", // overridden by aggregation
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "cannot_fix" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
    });

    expect(result.transition_condition).toBe("cannot_fix");
    expect(result.next_state).toBe("hitl");
  });

  it("mixed done/cannot_fix parallel_results produces 'done' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

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

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });

  it("any-blocked parallel_results produces 'blocked' condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE", // overridden by aggregation
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "blocked" },
      ],
    });

    expect(result.transition_condition).toBe("blocked");
    expect(result.hitl_required).toBe(true);
  });

  it("parallel_results is stored on BoardStateEntry", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

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

    expect(result.board.states["build"].parallel_results).toEqual(parallelResults);
  });

  it("absent parallel_results does not override condition (existing behavior unchanged)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      // no parallel_results
    });

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
    expect(result.board.states["build"].parallel_results).toBeUndefined();
  });

  it("empty parallel_results array does not override condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [], // empty — should not trigger aggregation
    });

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });

  it("aggregated condition overrides status_keyword for transition lookup", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithParallelTransitions();
    await setupWorkspace(workspace, flow);

    // status_keyword says DONE but all items are cannot_fix → should route to hitl
    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "cannot_fix" },
      ],
    });

    expect(result.transition_condition).toBe("cannot_fix");
    expect(result.next_state).toBe("hitl");
  });
});

// ---------------------------------------------------------------------------
// Progress line append
// ---------------------------------------------------------------------------

describe("reportResult — progress_line", () => {
  it("appends progress_line to progress.md when provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    // Seed progress.md like init_workspace does
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(workspace, "progress.md"), "## Progress: test\n\n");

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      progress_line: "- [build] done: Built successfully",
    });

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(workspace, "progress.md"), "utf-8");
    expect(content).toContain("- [build] done: Built successfully");
    expect(content).toContain("## Progress: test");
  });

  it("does not touch progress.md when progress_line is omitted", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    const { writeFileSync, readFileSync } = await import("node:fs");
    writeFileSync(join(workspace, "progress.md"), "## Progress: test\n\n");

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const content = readFileSync(join(workspace, "progress.md"), "utf-8");
    expect(content).toBe("## Progress: test\n\n");
  });

  it("handles missing progress.md gracefully (creates file)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    await setupWorkspace(workspace, flow);

    // No progress.md seeded — appendFile will create it
    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      progress_line: "- [build] done: Built successfully",
    });

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(workspace, "progress.md"), "utf-8");
    expect(content).toContain("- [build] done: Built successfully");
  });
});
