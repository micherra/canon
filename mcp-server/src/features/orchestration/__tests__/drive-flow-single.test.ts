/**
 * drive-flow-single.test.ts — Unit tests for driveFlow single-state advanced scenarios.
 *
 * Tests use an in-memory SQLite database via a temporary workspace directory.
 * We stub enterAndPrepareState and reportResult to avoid heavy integration
 * dependencies (git, enrichment, etc.).
 *
 * Coverage:
 * - ADR-009a: fresh session includes continue_from
 * - ADR-009a: stale session (>10min) omits continue_from
 * - Parallel state: returns all role prompts; partial result waits; all results advance
 * - Error handling: workspace not found, enterAndPrepareState error, reportResult error
 * - tool_scope_audit event persistence
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// We mock these two functions so we don't need live git/enrichment
vi.mock("../services/learn-gate.ts", () => ({
  evaluateLearnGate: vi.fn().mockResolvedValue({ passed: false, reason: "test mode" }),
}));

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { isToolError } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

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
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: "research",
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

/** A minimal resolved flow with research → implement → terminal */
function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "test",
    entry: "research",
    name: "test-flow",
    spawn_instructions: {
      implement: "Do implement",
      research: "Do research",
    },
    states: {
      implement: {
        agent: "canon:implementor",
        transitions: { done: "terminal" },
        type: "single",
      },
      research: {
        agent: "canon:researcher",
        transitions: { done: "implement" },
        type: "single",
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
        agent: "canon:researcher",
        prompt: "Do research task",
        role: "main",
        template_paths: [],
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

/** Build a fake reportResult output for a successful transition */
function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
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
    log_entry: {},
    next_state: nextState,
    ok: true,
    stuck: false,
    transition_condition: "done",
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// 7. ADR-009a — continue_from for fix-loop sessions

describe("driveFlow — ADR-009a agent session continuation", () => {
  it("includes continue_from when session exists and is fresh (<10min)", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "implement" });
    // Set up state row first (upsert so agent session can update it)
    store.upsertState("implement", { entries: 0, status: "pending" });
    // Record a fresh agent session (last activity just now)
    store.updateAgentSession("implement", "agent-id-abc123");

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:implementor",
            prompt: "Fix the issue",
            role: "main",
            template_paths: [],
          },
        ],
        state_type: "single",
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

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
    store.upsertState("implement", { entries: 0, status: "pending" });

    // Manually insert a stale session (>10 minutes ago)
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    // Use the store's underlying update to set stale timestamp
    (store as any).db
      .prepare(
        `UPDATE execution_states SET agent_session_id = ?, last_agent_activity = ? WHERE state_id = ?`,
      )
      .run("stale-agent-id", staleTime, "implement");

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:implementor",
            prompt: "Fix the issue",
            role: "main",
            template_paths: [],
          },
        ],
        state_type: "single",
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0].continue_from).toBeUndefined();
  });

  it("stores agent_session_id from result into execution store", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.upsertState("research", { entries: 1, status: "in_progress" });

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as any);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:implementor",
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
        result: {
          agent_session_id: "session-xyz-456",
          state_id: "research",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    const session = store.getAgentSession("research");
    expect(session?.agent_session_id).toBe("session-xyz-456");
  });
});

// 8. Parallel state handling

describe("driveFlow — parallel state", () => {
  it("returns all role prompts for a parallel state on first entry", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    const flow = makeFlow({
      entry: "review",
      states: {
        review: {
          agent: "canon:reviewer",
          roles: ["reviewer-a", "reviewer-b"],
          transitions: { done: "terminal" },
          type: "parallel",
        },
        terminal: { type: "terminal" },
      },
    } as any);
    store.updateExecution({ current_state: "review" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      can_enter: true,
      cannot_fix_items: [],
      history: [],
      iteration_count: 1,
      max_iterations: 3,
      ok: true,
      prompts: [
        {
          agent: "canon:reviewer",
          prompt: "Review A",
          role: "reviewer-a",
          template_paths: [],
        },
        {
          agent: "canon:reviewer",
          prompt: "Review B",
          role: "reviewer-b",
          template_paths: [],
        },
      ],
      state_type: "parallel",
    });

    const result = await driveFlow({ flow, workspace }, "/fake/project");

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
          agent: "canon:reviewer",
          roles: ["reviewer-a", "reviewer-b"],
          transitions: { done: "terminal" },
          type: "parallel",
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

    const result = await driveFlow(
      {
        flow,
        result: {
          parallel_results: [{ item: "reviewer-a", status: "done" }],
          state_id: "review",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Waiting for more parallel results — return empty spawn
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(0);
  });
});

// 9. Error case — workspace not found

describe("driveFlow — error handling", () => {
  it("returns WORKSPACE_NOT_FOUND error when workspace does not exist", async () => {
    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        workspace: "/nonexistent/path/workspace",
      },
      "/fake/project",
    );

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns error when enterAndPrepareState returns an error", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      error_code: "WORKSPACE_NOT_FOUND",
      message: "No execution found",
      ok: false,
      recoverable: false,
    });

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns error when reportResult returns an error", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce({
      error_code: "WORKSPACE_NOT_FOUND",
      message: "No execution found",
      ok: false,
      recoverable: false,
    });

    const flow = makeFlow();
    const result = await driveFlow(
      {
        flow,
        result: { state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});

// tool_scope_audit event persistence (ADR-014)

describe("driveFlow — tool_scope_audit event persistence", () => {
  it("persists tool_scope_audit event when prompt entry carries tool_scope_warnings", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ...makeEnterResult({
        prompts: [
          {
            agent: "canon:researcher",
            prompt: "Do research",
            template_paths: [],
            tool_scope_warnings: [
              {
                agent: "canon:researcher",
                event: "adr014_replace_override_grants_disallowed",
                granted_disallowed: ["Edit"],
              },
            ],
          },
        ],
      }),
    });
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("terminal") as never);

    await driveFlow({ flow: makeFlow(), workspace }, "/fake/project");

    const events = store.getEvents({ type: "tool_scope_audit" });
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.event).toBe("adr014_replace_override_grants_disallowed");
    expect(payload.agent).toBe("canon:researcher");
    expect(payload.granted_disallowed).toEqual(["Edit"]);
    expect(payload.stateId).toBe("research");
  });

  it("does not persist any tool_scope_audit event when no warnings present", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ...makeEnterResult(),
    });
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("terminal") as never);

    await driveFlow({ flow: makeFlow(), workspace }, "/fake/project");

    const events = store.getEvents({ type: "tool_scope_audit" });
    expect(events).toHaveLength(0);
  });
});
