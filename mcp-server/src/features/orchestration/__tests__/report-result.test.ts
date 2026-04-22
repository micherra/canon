/**
 * Tests for report-result.ts — basic functionality, debate flow, event emissions,
 * listener error isolation, and HITL scenarios.
 *
 * All workspace setup uses ExecutionStore instead of readBoard/writeBoard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow as FlowType } from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import type { FlowEventMap } from "@domains/messages/events.ts";
import { writeMessage } from "@domains/messages/messages.ts";
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
  // Close all DB connections and clear cache before deleting temp dirs
  clearStoreCache();

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
});

// Basic functionality

describe("reportResult — basic functionality", () => {
  it("normalizes status keyword and evaluates transition", async () => {
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

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
    expect(result.hitl_required).toBe(false);
  });

  it("updates board current_state on successful transition", async () => {
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

    expect(result.board.current_state).toBe("review");
  });

  it("sets hitl_required when status_keyword is unrecognized", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "SOMETHING_WEIRD",
      workspace,
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
      artifacts: ["summary.md", "diff.patch"],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.build.artifacts).toEqual(["summary.md", "diff.patch"]);
  });

  it("persists board state to execution_states table (no board.json)", async () => {
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
        composition: ["researcher", "architect"],
        continue_to_build: true,
        convergence_check_after: 3,
        hitl_checkpoint: true,
        max_rounds: 4,
        min_rounds: 2,
        teams: 2,
      },
    });
    setupWorkspace(workspace, flow);

    await writeMessage(workspace, "debate-round-1", "round-1-team-a-researcher", "Use events.");
    await writeMessage(workspace, "debate-round-1", "round-1-team-b-architect", "Use CRUD.");

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
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
        composition: ["researcher", "architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: true,
        max_rounds: 4,
        min_rounds: 2,
        teams: 2,
      },
    });
    setupWorkspace(workspace, flow);

    await writeMessage(
      workspace,
      "debate-round-1",
      "round-1-team-a-researcher",
      "We agree on event sourcing.",
    );
    await writeMessage(
      workspace,
      "debate-round-1",
      "round-1-team-b-architect",
      "Consensus reached, aligned.",
    );
    await writeMessage(workspace, "debate-round-2", "round-2-team-a-researcher", "Agreed.");
    await writeMessage(workspace, "debate-round-2", "round-2-team-b-architect", "Same conclusion.");

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.next_state).toBeNull();
    expect(result.hitl_required).toBe(true);
    expect(result.hitl_reason).toContain("Debate completed");
    expect(result.board.metadata?.debate_completed).toBe(true);
    expect(result.board.metadata?.debate_summary).toContain("Debate Round 1");
  });
});

// Event emissions

describe("reportResult — event emissions", () => {
  it("emits state_completed event with correct stateId and result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const received: FlowEventMap["state_completed"][] = [];
    flowEventBus.on("state_completed", (event) => received.push(event));

    await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
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
      artifacts: ["plan.md"],
      flow,
      metrics: { duration_ms: 3000, model: "sonnet", spawns: 1 },
      state_id: "build",
      status_keyword: "DONE",
      workspace,
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
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
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
      flow,
      state_id: "build",
      status_keyword: "BLOCKED",
      workspace,
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
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
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
      flow,
      state_id: "build",
      status_keyword: "NEEDS_CONTEXT",
      workspace,
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
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(boardStatusAtEmit).toBe("done");
    expect(result.board.states.build.status).toBe("done");
  });
});

// Listener error isolation

describe("reportResult — listener error isolation", () => {
  it("cleans up listeners after successful emit (no listener leak)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const listenersBefore = flowEventBus.listenerCount("state_completed");

    await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    const listenersAfter = flowEventBus.listenerCount("state_completed");
    expect(listenersAfter).toBe(listenersBefore);
  });
});

// HITL scenarios

describe("reportResult — HITL scenarios", () => {
  it("hitl_reason includes state_id for unrecognized status", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "MYSTERY_WORD",
      workspace,
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
      flow,
      state_id: "ship",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.hitl_required).toBe(false);
  });
});
