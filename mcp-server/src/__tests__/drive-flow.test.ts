/**
 * drive-flow.test.ts — Unit tests for the driveFlow core loop.
 *
 * Tests use an in-memory SQLite database via a temporary workspace directory.
 * We stub enterAndPrepareState and reportResult to avoid heavy integration
 * dependencies (git, enrichment, etc.).
 *
 * TDD: tests were written before the implementation.
 *
 * Coverage:
 * - First call (no result): enters entry state, returns spawn requests
 * - Subsequent call (with result): reports result, advances to next state
 * - Skip-state loop: auto-advances without returning to caller
 * - Terminal state: returns { action: "done" }
 * - Convergence exhaustion: returns HITL breakpoint
 * - Stuck detection: returns HITL breakpoint
 * - Consultation prompts included in SpawnRequest array
 * - ADR-009a: fresh session includes continue_from
 * - ADR-009a: stale session (>10min) omits continue_from
 * - Parallel state: returns all role prompts; partial result waits; all results advance
 * - Workspace not found: returns error
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock these two functions so we don't need live git/enrichment
vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

import { driveFlow } from "../tools/drive-flow.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import type { ToolResult } from "../utils/tool-result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    flow: "test-flow",
    task: "build feature",
    entry: "research",
    current_state: "research",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    branch: "feat/test",
    sanitized: "feat-test",
    created: new Date().toISOString(),
    tier: "medium",
    flow_name: "test-flow",
    slug: "test-slug",
  });
  return store;
}

/** A minimal resolved flow with research → implement → terminal */
function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "test",
    entry: "research",
    spawn_instructions: {
      research: "Do research",
      implement: "Do implement",
    },
    states: {
      research: {
        type: "single",
        agent: "canon:canon-researcher",
        transitions: { done: "implement" },
      },
      implement: {
        type: "single",
        agent: "canon:canon-implementor",
        transitions: { done: "terminal" },
      },
      terminal: {
        type: "terminal",
      },
    },
    ...overrides,
  };
}

/** Build a fake EnterAndPrepareStateResult for a single-state that can enter */
function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {}
): ToolResult<EnterAndPrepareStateResult> {
  return {
    ok: true,
    can_enter: true,
    iteration_count: 1,
    max_iterations: 3,
    cannot_fix_items: [],
    history: [],
    prompts: [
      {
        agent: "canon:canon-researcher",
        prompt: "Do research task",
        template_paths: [],
        role: "main",
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

/** Build a fake reportResult output for a successful transition */
function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    transition_condition: "done",
    next_state: nextState,
    stuck: false,
    hitl_required: false,
    board: {
      flow: "test-flow",
      task: "build feature",
      entry: "research",
      current_state: nextState ?? "terminal",
      base_commit: "abc123",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      blocked: null,
      concerns: [],
      skipped: [],
      states: {},
      iterations: {},
    },
    log_entry: {},
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// 1. First call (no result) — enters entry state, returns spawn requests
// ---------------------------------------------------------------------------

describe("driveFlow — first call (no result)", () => {
  it("returns spawn action with request derived from enterAndPrepareState prompts", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-researcher",
            prompt: "Research the codebase",
            template_paths: [],
            role: "main",
          },
        ],
      })
    );

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].agent_type).toBe("canon:canon-researcher");
    expect(result.requests[0].prompt).toBe("Research the codebase");
    expect(result.requests[0].role).toBe("main");
  });

  it("passes the flow entry state to enterAndPrepareState on first call", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(makeEnterResult());

    const flow = makeFlow();
    await driveFlow({ workspace, flow });

    expect(enterAndPrepareState).toHaveBeenCalledWith(
      expect.objectContaining({ state_id: "research", workspace })
    );
  });

  it("uses board.current_state if already set to a non-entry state", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    // Simulate the flow already partway through: current_state = implement
    store.updateExecution({ current_state: "implement" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" },
        ],
        state_type: "single",
      })
    );

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    // Should have entered implement, not research
    expect(enterAndPrepareState).toHaveBeenCalledWith(
      expect.objectContaining({ state_id: "implement" })
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Subsequent call (with result) — advances to next state
// ---------------------------------------------------------------------------

describe("driveFlow — call with result", () => {
  it("calls reportResult with the provided result and returns next spawn requests", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as any);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" },
        ],
        state_type: "single",
      })
    );

    const flow = makeFlow();
    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(reportResult).toHaveBeenCalledWith(
      expect.objectContaining({ state_id: "research", status_keyword: "done" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0].agent_type).toBe("canon:canon-implementor");
  });

  it("returns done when next_state is terminal", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("terminal") as any);
    // enterAndPrepareState for terminal should not be called — we detect terminal type

    const flow = makeFlow();
    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "implement", status: "done" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.terminal_state).toBe("terminal");
  });

  it("returns done when next_state is null (no transition matched)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult(null) as any);

    const flow = makeFlow();
    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 3. HITL — convergence exhaustion
// ---------------------------------------------------------------------------

describe("driveFlow — HITL breakpoints", () => {
  it("returns hitl when enterAndPrepareState returns can_enter:false", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ok: true,
      can_enter: false,
      iteration_count: 3,
      max_iterations: 3,
      cannot_fix_items: [],
      history: [],
      prompts: [],
      state_type: "single",
      convergence_reason: "Max iterations reached",
    });

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason).toMatch(/convergence|max iteration/i);
  });

  it("returns hitl when reportResult returns hitl_required:true", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce({
      ...makeReportResult(null),
      hitl_required: true,
      hitl_reason: "Agent is stuck in state 'research'",
    } as any);

    const flow = makeFlow();
    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason).toMatch(/stuck/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Skip-state loop
// ---------------------------------------------------------------------------

describe("driveFlow — skip-state auto-advancement", () => {
  it("auto-advances through a skipped state without returning to caller", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow = makeFlow({
      states: {
        research: {
          type: "single",
          agent: "canon:canon-researcher",
          transitions: { done: "security", skipped: "implement" },
          skip_when: "no_contract_changes",
        },
        security: {
          type: "single",
          agent: "canon:canon-security",
          transitions: { done: "implement" },
          skip_when: "no_contract_changes",
        },
        implement: {
          type: "single",
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as any);

    // research: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ok: true,
      can_enter: true,
      iteration_count: 0,
      max_iterations: 3,
      cannot_fix_items: [],
      history: [],
      prompts: [],
      state_type: "single",
      skip_reason: "Skipping research: no_contract_changes condition met",
    });
    // reportResult for skipped research → next_state = implement (or security, depends on transitions)
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as any);
    // implement: actual spawn
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" },
        ],
        state_type: "single",
      })
    );

    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should return implement spawn, not research spawn
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0].agent_type).toBe("canon:canon-implementor");
    // reportResult should have been called once (for the skip)
    expect(reportResult).toHaveBeenCalledTimes(1);
    expect(reportResult).toHaveBeenCalledWith(
      expect.objectContaining({ status_keyword: "skipped" })
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal state returns done
// ---------------------------------------------------------------------------

describe("driveFlow — terminal state", () => {
  it("returns done immediately when current state is terminal type", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "terminal" });

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.terminal_state).toBe("terminal");
    // enterAndPrepareState should not be called for terminal states
    expect(enterAndPrepareState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Consultation prompts
// ---------------------------------------------------------------------------

describe("driveFlow — consultation prompts", () => {
  it("includes consultation prompts in SpawnRequest array with role consultation", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-researcher", prompt: "Research task", template_paths: [], role: "main" },
        ],
        consultation_prompts: [
          {
            name: "security-check",
            agent: "canon:canon-security",
            prompt: "Check security",
            role: "consultation",
          },
        ],
      })
    );

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(2);
    const consultationReq = result.requests.find((r) => r.role === "consultation");
    expect(consultationReq).toBeDefined();
    expect(consultationReq?.agent_type).toBe("canon:canon-security");
    expect(consultationReq?.prompt).toBe("Check security");
  });
});

// ---------------------------------------------------------------------------
// 7. ADR-009a — continue_from for fix-loop sessions
// ---------------------------------------------------------------------------

describe("driveFlow — ADR-009a agent session continuation", () => {
  it("includes continue_from when session exists and is fresh (<10min)", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "implement" });
    // Set up state row first (upsert so agent session can update it)
    store.upsertState("implement", { status: "pending", entries: 0 });
    // Record a fresh agent session (last activity just now)
    store.updateAgentSession("implement", "agent-id-abc123");

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-implementor", prompt: "Fix the issue", template_paths: [], role: "main" },
        ],
        state_type: "single",
      })
    );

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].continue_from).toBeDefined();
    expect(result.requests[0].continue_from?.agent_id).toBe("agent-id-abc123");
  });

  it("omits continue_from when session is stale (>10min)", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "implement" });
    store.upsertState("implement", { status: "pending", entries: 0 });

    // Manually insert a stale session (>10 minutes ago)
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    // Use the store's underlying update to set stale timestamp
    (store as any).db.prepare(
      `UPDATE execution_states SET agent_session_id = ?, last_agent_activity = ? WHERE state_id = ?`
    ).run("stale-agent-id", staleTime, "implement");

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-implementor", prompt: "Fix the issue", template_paths: [], role: "main" },
        ],
        state_type: "single",
      })
    );

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0].continue_from).toBeUndefined();
  });

  it("stores agent_session_id from result into execution store", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.upsertState("research", { status: "in_progress", entries: 1 });

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as any);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" },
        ],
      })
    );

    const flow = makeFlow();
    await driveFlow({
      workspace,
      flow,
      result: {
        state_id: "research",
        status: "done",
        agent_session_id: "session-xyz-456",
      },
    });

    const session = store.getAgentSession("research");
    expect(session?.agent_session_id).toBe("session-xyz-456");
  });
});

// ---------------------------------------------------------------------------
// 8. Parallel state handling
// ---------------------------------------------------------------------------

describe("driveFlow — parallel state", () => {
  it("returns all role prompts for a parallel state on first entry", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    const flow = makeFlow({
      entry: "review",
      states: {
        review: {
          type: "parallel",
          roles: ["reviewer-a", "reviewer-b"],
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as any);
    store.updateExecution({ current_state: "review" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ok: true,
      can_enter: true,
      iteration_count: 1,
      max_iterations: 3,
      cannot_fix_items: [],
      history: [],
      prompts: [
        { agent: "canon:canon-reviewer", prompt: "Review A", template_paths: [], role: "reviewer-a" },
        { agent: "canon:canon-reviewer", prompt: "Review B", template_paths: [], role: "reviewer-b" },
      ],
      state_type: "parallel",
    });

    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(2);
    const roles = result.requests.map((r) => r.role);
    expect(roles).toContain("reviewer-a");
    expect(roles).toContain("reviewer-b");
  });

  it("returns empty spawn requests when not all parallel roles have completed", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    const flow = makeFlow({
      entry: "review",
      states: {
        review: {
          type: "parallel",
          roles: ["reviewer-a", "reviewer-b"],
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as any);
    store.updateExecution({ current_state: "review" });

    // partial result from one role — reportResult returns hitl_required: false, next_state: review (loop)
    vi.mocked(reportResult).mockResolvedValueOnce({
      ...makeReportResult("review"),
      hitl_required: false,
      next_state: "review", // not done yet — still in review
    } as any);

    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "review", status: "done", parallel_results: [{ item: "reviewer-a", status: "done" }] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Waiting for more parallel results — return empty spawn
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Error case — workspace not found
// ---------------------------------------------------------------------------

describe("driveFlow — error handling", () => {
  it("returns WORKSPACE_NOT_FOUND error when workspace does not exist", async () => {
    const flow = makeFlow();
    const result = await driveFlow({
      workspace: "/nonexistent/path/workspace",
      flow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns error when enterAndPrepareState returns an error", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ok: false,
      error_code: "WORKSPACE_NOT_FOUND",
      message: "No execution found",
      recoverable: false,
    });

    const flow = makeFlow();
    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns error when reportResult returns an error", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce({
      ok: false,
      error_code: "WORKSPACE_NOT_FOUND",
      message: "No execution found",
      recoverable: false,
    });

    const flow = makeFlow();
    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});
