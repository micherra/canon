/**
 * ADR-017 Integration Tests — Canon Tester (Part 2)
 *
 * Fills coverage gaps in the approval gate implementation:
 *
 * 5. initBoard: max_revisions on wave state (not just single)
 * 6. driveFlow Branch A: "reject" status routes to HITL, not approval gate
 * 7. driveFlow Branch B (no result): approval gate does NOT fire on initial entry
 * 8. driveFlow: approval gate does not fire when status is "approved" and
 *    the design state lacks approval_gate (post-approval re-entry path)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 5: initBoard — max_revisions on wave state type

import { initBoard } from "@domains/board/board.ts";
import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";

describe("initBoard with approval gate fields — wave state", () => {
  function makeMinimalFlow(
    stateOverrides?: Partial<Record<string, StateDefinition>>,
  ): ResolvedFlow {
    return {
      description: "test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        implement: { agent: "canon:canon-implementor", type: "wave" },
        terminal: { type: "terminal" },
        ...stateOverrides,
      },
    } as ResolvedFlow;
  }

  it("wave state with max_revisions creates IterationEntry", () => {
    const flow = makeMinimalFlow({
      implement: { max_revisions: 4, type: "wave" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.implement).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 4,
    });
  });

  it("wave state with approval_gate: true creates default IterationEntry (max: 3)", () => {
    const flow = makeMinimalFlow({
      implement: { approval_gate: true, type: "wave" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.implement).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 3,
    });
  });

  it("wave state with both max_revisions and max_iterations uses max_revisions", () => {
    const flow = makeMinimalFlow({
      implement: { max_iterations: 10, max_revisions: 2, type: "wave" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.implement).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 2,
    });
  });

  it("terminal state does NOT create IterationEntry even with approval_gate: true", () => {
    const flow = {
      description: "test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        implement: { agent: "canon:canon-implementor", type: "wave" as const },
        // Terminal with approval_gate — semantically nonsensical but the terminal guard
        // in initBoard prevents creating an iteration entry (fix #5).
        terminal: { approval_gate: true, type: "terminal" as const },
      },
    } as ResolvedFlow;
    const board = initBoard(flow, "task", "abc");
    // Terminal states are skipped by the approval_gate iteration entry guard.
    expect(board.iterations.terminal).toBeUndefined();
  });
});

// 6 & 7 & 8: driveFlow integration — reject path, Branch B no gate, re-entry

vi.mock("../services/learn-gate.ts", () => ({
  evaluateLearnGate: vi.fn().mockResolvedValue({ passed: false, reason: "test mode" }),
}));

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr017-skip-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: "design",
    entry: "design",
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

function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {},
): { ok: true } & EnterAndPrepareStateResult {
  return {
    can_enter: true,
    cannot_fix_items: [],
    history: [],
    iteration_count: 1,
    max_iterations: 3,
    ok: true,
    prompts: [
      {
        agent: "canon-architect",
        prompt: "Design the feature",
        role: "main",
        template_paths: [],
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    board: {
      base_commit: "abc123",
      blocked: null,
      concerns: [],
      current_state: nextState ?? "terminal",
      entry: "design",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {},
      task: "build feature",
    },
    hitl_reason: overrides.hitl_reason,
    hitl_required: overrides.hitl_required ?? false,
    log_entry: {},
    next_state: nextState,
    ok: true,
    stuck: false,
    transition_condition: overrides.transition_condition ?? "done",
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  vi.clearAllMocks();
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// Flow with design state having approval_gate: true (medium tier)
function makeApprovalFlow(): ResolvedFlow {
  return {
    description: "test",
    entry: "design",
    name: "test-flow",
    spawn_instructions: {
      design: "Design something",
      implement: "Implement it",
    },
    states: {
      design: {
        agent: "canon-architect",
        approval_gate: true,
        transitions: {
          approved: "implement",
          done: "implement",
          reject: "hitl",
          revise: "design",
        },
        type: "single",
      },
      implement: {
        agent: "canon:canon-implementor",
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: { type: "terminal" },
    },
    tier: "medium",
  } as unknown as ResolvedFlow;
}

describe("driveFlow — reject status routes to HITL, not approval gate", () => {
  it("'reject' status triggers HITL breakpoint (not approval)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    // report-result returns hitl_required: true when status leads to hitl
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult(null, {
        hitl_reason: "Design rejected — returning to orchestrator",
        hitl_required: true,
        transition_condition: "reject",
      }) as any,
    );

    const result = await driveFlow(
      {
        flow: makeApprovalFlow(),
        result: {
          artifacts: ["/workspace/design.md"],
          state_id: "design",
          status: "reject",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should be HITL, not approval
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason).toContain("rejected");
  });

  it("'reject' status does not produce action: 'approval'", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult(null, {
        hitl_reason: "rejected",
        hitl_required: true,
        transition_condition: "reject",
      }) as any,
    );

    const result = await driveFlow(
      {
        flow: makeApprovalFlow(),
        result: {
          state_id: "design",
          status: "reject",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).not.toBe("approval");
  });
});

describe("driveFlow Branch B — no result, approval gate does NOT fire on initial entry", () => {
  it("initial entry (no result) spawns agent without triggering approval gate", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());

    const result = await driveFlow(
      {
        flow: makeApprovalFlow(),
        workspace,
        // No result — Branch B
      },
      "/fake/project",
    );

    // Should spawn (enter state), not produce approval breakpoint
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.requests[0]?.agent_type).toContain("architect");
  });

  it("Branch B does not call reportResult (no result to report)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());

    await driveFlow(
      {
        flow: makeApprovalFlow(),
        workspace,
      },
      "/fake/project",
    );

    expect(vi.mocked(reportResult)).not.toHaveBeenCalled();
  });
});

describe("driveFlow — approval gate fires on 'done' but not on terminal state", () => {
  it("terminal next_state skips approval gate and returns done action", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(
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
    // implement → terminal; implement has no approval_gate
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("terminal", { transition_condition: "done" }) as any,
    );

    const flowNoGate: ResolvedFlow = {
      description: "test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: { implement: "Implement" },
      states: {
        implement: {
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
          type: "single",
          // No approval_gate — implementor on medium tier doesn't trigger tier default either
        },
        terminal: { type: "terminal" },
      },
      tier: "medium",
    } as unknown as ResolvedFlow;

    const result = await driveFlow(
      {
        flow: flowNoGate,
        result: {
          state_id: "implement",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
  });

  it("approval gate fires before terminal check — gated state + done → approval (not done)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());
    // Report: next_state is "terminal" but design has approval_gate: true
    // The approval gate check fires BEFORE the terminal check
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("terminal", { transition_condition: "done" }) as any,
    );

    const flowGatedToTerminal: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: { design: "Design" },
      states: {
        design: {
          agent: "canon-architect",
          approval_gate: true,
          transitions: { approved: "terminal", done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
      tier: "medium",
    } as unknown as ResolvedFlow;

    const result = await driveFlow(
      {
        flow: flowGatedToTerminal,
        result: {
          artifacts: ["/workspace/design.md"],
          state_id: "design",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Approval gate fires before terminal check
    expect(result.action).toBe("approval");
  });
});
