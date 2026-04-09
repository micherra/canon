/**
 * drive-flow-flow-events.test.ts — Tests for flow event channel integration in driveFlow.
 *
 * Tests each FlowEventEffect type end-to-end through driveFlow:
 * - none: normal transition proceeds unaffected
 * - insert: state_id from event used as next state instead of normal transition
 * - skip: target from event used as next state
 * - escalate: returns HitlBreakpoint with message and suggested_options
 *
 * Watermark persistence:
 * - After draining, board.metadata.flow_events_watermark is updated to newWatermark
 *
 * ADR-012 / fe-03
 *
 * TDD: tests written before implementation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock heavy dependencies — same pattern as other drive-flow tests
vi.mock("../services/learn-gate.ts", () => ({
  evaluateLearnGate: vi.fn().mockResolvedValue({ passed: false, reason: "test mode" }),
}));

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));
vi.mock("@domains/flows/gate-runner.ts", () => ({
  runGates: vi.fn(),
}));
vi.mock("@domains/workspaces/wave-lifecycle.ts", () => ({
  cleanupWorktrees: vi.fn(),
  createWaveWorktrees: vi.fn(),
  getProjectDir: vi.fn(),
  mergeWaveResults: vi.fn(),
}));
vi.mock("../tools/resolve-after-consultations.ts", () => ({
  resolveAfterConsultations: vi.fn(),
}));

// Mock drainFlowEvents so we can control what effect it returns
vi.mock("@domains/flows/flow-event-channel.ts", () => ({
  drainFlowEvents: vi.fn(),
}));

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { drainFlowEvents } from "@domains/flows/flow-event-channel.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { createWaveWorktrees } from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { LogEntry, ReportResultResult } from "../tools/report-result.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-flow-events-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string, opts: { currentState?: string } = {}): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: opts.currentState ?? "research",
    entry: "research",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: new Date().toISOString(),
    sanitized: "feat-test",
    slug: "test-slug",
    started: new Date().toISOString(),
    task: "build feature",
    tier: "medium",
  });
  return store;
}

/** A flow: research → implement → review → terminal, with review as allowed insertion */
function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    allowed_insertions: ["review"],
    description: "test",
    entry: "research",
    name: "test-flow",
    spawn_instructions: {
      implement: "Do implement",
      research: "Do research",
      review: "Do review",
    },
    states: {
      implement: {
        agent: "canon:canon-implementor",
        transitions: { done: "review" },
        type: "single",
      },
      research: {
        agent: "canon:canon-researcher",
        transitions: { done: "implement" },
        type: "single",
      },
      review: {
        agent: "canon:canon-reviewer",
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: {
        type: "terminal",
      },
    },
    tier: "medium",
    ...overrides,
  };
}

/** Build a fake EnterAndPrepareStateResult for a single-state that can enter */
function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {},
): ToolResult<EnterAndPrepareStateResult> {
  return {
    can_enter: true,
    cannot_fix_items: [],
    history: [],
    iteration_count: 1,
    max_iterations: 3,
    ok: true,
    prompts: [
      {
        agent: "canon:canon-implementor",
        prompt: "Do implement task",
        role: "main",
        template_paths: [],
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

/** Build a fake reportResult output for a successful transition */
function makeReportResult(
  nextState: string | null,
  overrides: Partial<ReportResultResult> = {},
): ToolResult<ReportResultResult> {
  const log_entry: LogEntry = {
    hitl_required: false,
    next_state: nextState,
    normalized_condition: "done",
    state_id: "research",
    status_keyword: "done",
    stuck: false,
    timestamp: new Date().toISOString(),
  };
  return {
    board: {
      base_commit: "abc123",
      blocked: null,
      concerns: [],
      current_state: nextState ?? "terminal",
      entry: "research",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {},
      task: "build feature",
    },
    hitl_required: false,
    log_entry,
    next_state: nextState,
    ok: true as const,
    stuck: false,
    transition_condition: "done",
    ...overrides,
  };
}

// Default mock for createWaveWorktrees used when write agents appear in single states.
beforeEach(() => {
  vi.mocked(createWaveWorktrees).mockResolvedValue([
    {
      branch: "canon-wave/test-slug-implement",
      task_id: "test-slug-implement",
      worktree_path: "/fake/project/.canon/worktrees/test-slug-implement",
    },
  ]);
});

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

describe("driveFlow — flow events: effect none", () => {
  it("proceeds normally when drain returns { type: 'none' }", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({ effect: { type: "none" }, newWatermark: 0 });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Do implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: {
          artifacts: [],
          state_id: "research",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should have entered the normal next state (implement)
    expect(result.requests[0].agent_type).toBe("canon:canon-implementor");
  });

  it("does not call drainFlowEvents on first call (no result)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-researcher", prompt: "Research", role: "main", template_paths: [] },
        ],
      }),
    );

    const flow = makeFlow();
    await driveFlow({ flow, workspace }, "/fake/project");

    // drainFlowEvents should NOT be called on the initial entry (no result submitted)
    expect(drainFlowEvents).not.toHaveBeenCalled();
  });
});

describe("driveFlow — flow events: effect insert", () => {
  it("uses the inserted state_id as next state instead of normal transition target", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    // Drain returns insert effect pointing to "review" (normally we'd go to "implement")
    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { state_id: "review", type: "insert" },
      newWatermark: 5,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-reviewer",
            prompt: "Do review",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: {
          artifacts: [],
          state_id: "research",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should have entered "review", not "implement"
    expect(result.requests[0].agent_type).toBe("canon:canon-reviewer");

    // enterAndPrepareState should have been called with state_id "review", not "implement"
    const enterCall = vi.mocked(enterAndPrepareState).mock.calls[0][0];
    expect(enterCall.state_id).toBe("review");
  });

  it("persists updated watermark when insert effect fires", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { state_id: "review", type: "insert" },
      newWatermark: 7,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-reviewer", prompt: "Do review", role: "main", template_paths: [] },
        ],
      }),
    );

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    const board = store.getBoard();
    expect(board?.metadata?.flow_events_watermark).toBe(7);
  });
});

describe("driveFlow — flow events: effect skip", () => {
  it("uses the skip target as next state instead of normal transition", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { reason: "PR approved, skip review", target: "terminal", type: "skip" },
      newWatermark: 3,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // terminal state → should produce "done"
    expect(result.action).toBe("done");
  });

  it("skip to a non-terminal state enters that state", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { reason: "skip implement, go direct to review", target: "review", type: "skip" },
      newWatermark: 2,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-reviewer", prompt: "Review", role: "main", template_paths: [] },
        ],
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0].agent_type).toBe("canon:canon-reviewer");

    const enterCall = vi.mocked(enterAndPrepareState).mock.calls[0][0];
    expect(enterCall.state_id).toBe("review");
  });

  it("persists updated watermark when skip effect fires", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { reason: "skip", target: "terminal", type: "skip" },
      newWatermark: 9,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    const board = store.getBoard();
    expect(board?.metadata?.flow_events_watermark).toBe(9);
  });
});

describe("driveFlow — flow events: effect escalate", () => {
  it("returns hitl action with message from escalate event", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: {
        message: "Critical blocker detected: tests are failing in CI",
        type: "escalate",
      },
      newWatermark: 4,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason).toContain("Critical blocker detected");
  });

  it("includes suggested_options in the HITL breakpoint when present", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: {
        message: "Conflict in wave",
        suggested_options: ["Replan", "Abort", "Continue"],
        type: "escalate",
      },
      newWatermark: 2,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.options).toEqual(["Replan", "Abort", "Continue"]);
  });

  it("persists updated watermark even when escalating", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: {
        message: "Escalating now",
        type: "escalate",
      },
      newWatermark: 11,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    const board = store.getBoard();
    expect(board?.metadata?.flow_events_watermark).toBe(11);
  });
});

describe("driveFlow — flow events: insert return-address semantics", () => {
  it("inserted state completes with 'done' → flow resumes at return address, not inserted state's own transition", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace, { currentState: "implement" });

    // Set up: "review" was inserted with return address "implement"
    // (as if drainFlowEvents fired an insert while in "research" → next was "implement")
    store.upsertState("review", {
      entries: 1,
      inserted_return_to: "implement",
      status: "in_progress",
    });

    // Now "review" completes with "done" — its own transition is review→terminal
    // But the return address says go to "implement"
    vi.mocked(drainFlowEvents).mockReturnValueOnce({ effect: { type: "none" }, newWatermark: 0 });
    vi.mocked(reportResult).mockResolvedValueOnce(
      makeReportResult("terminal", {
        log_entry: {
          hitl_required: false,
          next_state: "terminal",
          normalized_condition: "done",
          state_id: "review",
          status_keyword: "done",
          stuck: false,
          timestamp: new Date().toISOString(),
        },
        transition_condition: "done",
      }),
    );
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Do implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: {
          artifacts: [],
          state_id: "review",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should have entered "implement" (return address), not "terminal" (review's own transition)
    const enterCall = vi.mocked(enterAndPrepareState).mock.calls[0][0];
    expect(enterCall.state_id).toBe("implement");
  });

  it("inserted state completes with non-done condition → uses its own transitions, not return address", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace, { currentState: "review" });

    // "review" was inserted with return address "implement", but completes with "needs_revision"
    store.upsertState("review", {
      entries: 1,
      inserted_return_to: "implement",
      status: "in_progress",
    });

    // Extend the flow to add a needs_revision transition on review
    const flow: ResolvedFlow = {
      ...makeFlow(),
      states: {
        ...makeFlow().states,
        review: {
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal", needs_revision: "implement" },
          type: "single",
        },
      },
    };

    vi.mocked(drainFlowEvents).mockReturnValueOnce({ effect: { type: "none" }, newWatermark: 0 });
    vi.mocked(reportResult).mockResolvedValueOnce(
      makeReportResult("implement", {
        log_entry: {
          hitl_required: false,
          next_state: "implement",
          normalized_condition: "needs_revision",
          state_id: "review",
          status_keyword: "needs_revision",
          stuck: false,
          timestamp: new Date().toISOString(),
        },
        transition_condition: "needs_revision",
      }),
    );
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Do implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const result = await driveFlow(
      {
        flow,
        result: {
          artifacts: [],
          state_id: "review",
          status: "needs_revision",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should follow review's own "needs_revision" transition to "implement"
    // (same destination, but via the flow transition, not the return address)
    const enterCall = vi.mocked(enterAndPrepareState).mock.calls[0][0];
    expect(enterCall.state_id).toBe("implement");
  });

  it("after insert fires, board state entry has inserted_return_to set", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // Drain returns insert effect
    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { state_id: "review", type: "insert" },
      newWatermark: 3,
    });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-reviewer",
            prompt: "Do review",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    // The inserted state "review" should have inserted_return_to = "implement" (the normal next state)
    const reviewState = store.getState("review");
    expect(reviewState?.inserted_return_to).toBe("implement");
  });

  it("insert with null resumeStateId → no inserted_return_to set on board state", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // Simulate insert at wave boundary (where resumeStateId is null)
    // We can only test this indirectly — insert fires at wave boundary which uses null resumeStateId
    // For now test the positive: if we call drainFlowEvents after an insert at a wave context,
    // the state should NOT have inserted_return_to set.
    // We model this by having the drain effect fire an insert with no prior next_state (first call scenario is not applicable)
    // Instead: verify that when insert fires in the routeReportResult code path with a null next_state
    // from reportResult, inserted_return_to is null/undefined on the inserted state.
    vi.mocked(drainFlowEvents).mockReturnValueOnce({
      effect: { state_id: "review", type: "insert" },
      newWatermark: 1,
    });
    // reportResult returns null next_state (e.g. stuck=true scenario where hitl was already cleared)
    vi.mocked(reportResult).mockResolvedValueOnce(
      makeReportResult(null, {
        log_entry: {
          hitl_required: false,
          next_state: null,
          normalized_condition: "done",
          state_id: "research",
          status_keyword: "done",
          stuck: false,
          timestamp: new Date().toISOString(),
        },
        next_state: null,
        transition_condition: "done",
      }),
    );
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-reviewer",
            prompt: "Do review",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    // inserted_return_to should be null/undefined since next_state was null
    const reviewState = store.getState("review");
    expect(reviewState?.inserted_return_to).toBeUndefined();
  });
});

describe("driveFlow — flow events: watermark reading", () => {
  it("passes the existing flow_events_watermark to drainFlowEvents", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // Set an existing watermark
    store.updateExecution({ metadata: { flow_events_watermark: 42 } });

    vi.mocked(drainFlowEvents).mockReturnValueOnce({ effect: { type: "none" }, newWatermark: 42 });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    const drainCall = vi.mocked(drainFlowEvents).mock.calls[0][0];
    expect(drainCall.watermark).toBe(42);
  });

  it("uses watermark 0 when board has no existing flow_events_watermark", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({ effect: { type: "none" }, newWatermark: 0 });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    const drainCall = vi.mocked(drainFlowEvents).mock.calls[0][0];
    expect(drainCall.watermark).toBe(0);
  });

  it("passes the current state_id and flowDef to drainFlowEvents", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(drainFlowEvents).mockReturnValueOnce({ effect: { type: "none" }, newWatermark: 0 });
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement"));
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(makeEnterResult());

    const flow = makeFlow();
    await driveFlow(
      {
        flow,
        result: { artifacts: [], state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    const drainCall = vi.mocked(drainFlowEvents).mock.calls[0][0];
    expect(drainCall.currentStateId).toBe("research");
    expect(drainCall.flowDef).toMatchObject({ name: "test-flow" });
  });
});
