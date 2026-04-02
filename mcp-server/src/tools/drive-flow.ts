/**
 * drive-flow — Core state machine loop for server-side flow execution.
 *
 * Implements a turn-by-turn protocol:
 *   - First call (no result): enters entry state, returns SpawnRequest[]
 *   - Subsequent calls (with result): reports result, advances, returns next action
 *
 * Design decisions:
 *   - dd-009-01: Composition over inline — calls enterAndPrepareState and reportResult
 *   - dd-009-03: Wave result accumulation via SQLite wave_results column
 *   - dd-009-06: Timestamp-based agent session eviction for ADR-009a
 *
 * Canon principles:
 *   - toolresult-contract: returns ToolResult<DriveFlowAction>
 *   - sqlite-transactions: board mutations inside store.transaction()
 *   - no-silent-failures: convergence, stuck, HITL all produce explicit breakpoints
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import { toolError } from "../utils/tool-result.ts";
import type { DriveFlowAction, DriveFlowInput, SpawnRequest } from "../orchestration/drive-flow-types.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";
import { reportResult } from "./report-result.ts";
import type { SpawnPromptEntry } from "./get-spawn-prompt.ts";

// Re-export types for external consumers
export type { DriveFlowAction, DriveFlowInput, SpawnRequest };

// ---------------------------------------------------------------------------
// Agent session eviction threshold (ADR-009a)
// ---------------------------------------------------------------------------

const AGENT_SESSION_EVICTION_MS = 600_000; // 10 minutes

// ---------------------------------------------------------------------------
// driveFlow
// ---------------------------------------------------------------------------

/**
 * Drive the flow state machine by one turn.
 *
 * If `input.result` is absent: enters the current state and returns spawn requests.
 * If `input.result` is present: reports the result, advances the loop, returns the next action.
 */
export async function driveFlow(
  input: DriveFlowInput,
): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow } = input;

  // Guard: workspace must exist on disk (getExecutionStore throws otherwise)
  if (!existsSync(resolve(workspace))) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Workspace directory does not exist: ${workspace}`,
    );
  }

  const store = getExecutionStore(workspace);

  // Guard: execution must exist
  const board = store.getBoard();
  if (!board) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `No execution found for workspace: ${workspace}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Branch A: result provided — report it, then determine next action
  // ---------------------------------------------------------------------------

  if (input.result) {
    const { state_id, status, artifacts, parallel_results, metrics, agent_session_id, ...rest } = input.result;

    // Store agent session ID for ADR-009a continue_from support
    if (agent_session_id) {
      store.updateAgentSession(state_id, agent_session_id);
    }

    // Report the result and evaluate transition
    const reportOut = await reportResult({
      workspace,
      state_id,
      status_keyword: status,
      flow,
      artifacts: artifacts as string[] | undefined,
      parallel_results: parallel_results as Array<{ item: string; status: string; artifacts?: string[] }> | undefined,
      metrics: metrics as Parameters<typeof reportResult>[0]["metrics"],
    });

    if (!reportOut.ok) {
      return reportOut;
    }

    const { next_state, hitl_required, hitl_reason, stuck, stuck_reason } = reportOut;

    // HITL required (stuck, no transition, debate checkpoint, etc.)
    if (hitl_required) {
      return {
        ok: true as const,
        action: "hitl",
        breakpoint: {
          reason: hitl_reason ?? stuck_reason ?? "HITL required",
          context: buildHitlContext(board, state_id, reportOut),
        },
      };
    }

    // Parallel state: check if all roles are done
    // When next_state loops back to the same state, it means we're waiting for
    // more parallel results. Return empty spawn to signal "waiting".
    if (next_state === state_id) {
      return {
        ok: true as const,
        action: "spawn",
        requests: [],
      };
    }

    // No next state (and not hitl_required) — terminal or unknown
    if (!next_state) {
      const stateDef = flow.states[state_id];
      return {
        ok: true as const,
        action: "done",
        terminal_state: state_id,
        summary: buildDoneSummary(board, state_id),
      };
    }

    // Check if next state is terminal
    const nextStateDef = flow.states[next_state];
    if (nextStateDef?.type === "terminal") {
      return {
        ok: true as const,
        action: "done",
        terminal_state: next_state,
        summary: buildDoneSummary(board, next_state),
      };
    }

    // Advance to next state — enter and return spawn requests
    return enterStateAndBuildSpawn(workspace, flow, next_state, store);
  }

  // ---------------------------------------------------------------------------
  // Branch B: no result — first call or re-entry after HITL
  // ---------------------------------------------------------------------------

  // Determine which state to enter
  const targetState = board.current_state ?? flow.entry;

  // Check if the current state is already terminal
  const targetStateDef = flow.states[targetState];
  if (targetStateDef?.type === "terminal") {
    return {
      ok: true as const,
      action: "done",
      terminal_state: targetState,
      summary: buildDoneSummary(board, targetState),
    };
  }

  return enterStateAndBuildSpawn(workspace, flow, targetState, store);
}

// ---------------------------------------------------------------------------
// Internal: enter state with skip-state loop
// ---------------------------------------------------------------------------

/**
 * Enter a state, handling the skip-state loop internally.
 * If the state has a skip_when condition that is satisfied, automatically
 * calls reportResult with "skipped" and loops to the next state.
 * Returns spawn requests for the first non-skipped state.
 */
async function enterStateAndBuildSpawn(
  workspace: string,
  flow: DriveFlowInput["flow"],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<ToolResult<DriveFlowAction>> {
  // Limit skip loops to prevent infinite cycles
  const MAX_SKIP_ITERATIONS = 50;
  let currentStateId = stateId;

  for (let i = 0; i < MAX_SKIP_ITERATIONS; i++) {
    // Check if current state is terminal before entering
    const stateDef = flow.states[currentStateId];
    if (stateDef?.type === "terminal") {
      return {
        ok: true as const,
        action: "done",
        terminal_state: currentStateId,
        summary: buildDoneSummary(store.getBoard()!, currentStateId),
      };
    }

    const enterOut = await enterAndPrepareState({
      workspace,
      state_id: currentStateId,
      flow,
      variables: {},
    });

    if (!enterOut.ok) {
      return enterOut;
    }

    // Convergence exhausted — cannot enter state
    if (!enterOut.can_enter) {
      return {
        ok: true as const,
        action: "hitl",
        breakpoint: {
          reason: enterOut.convergence_reason
            ? `Convergence exhausted for state '${currentStateId}': ${enterOut.convergence_reason}`
            : `Max iterations reached for state '${currentStateId}'`,
          context: buildConvergenceContext(enterOut),
        },
      };
    }

    // Skip-state: auto-advance without returning to caller
    if (enterOut.skip_reason) {
      const reportOut = await reportResult({
        workspace,
        state_id: currentStateId,
        status_keyword: "skipped",
        flow,
      });

      if (!reportOut.ok) {
        return reportOut;
      }

      // If HITL or no next state after skip, return done
      if (reportOut.hitl_required) {
        return {
          ok: true as const,
          action: "hitl",
          breakpoint: {
            reason: reportOut.hitl_reason ?? "HITL required after skip",
            context: "",
          },
        };
      }

      const nextState = reportOut.next_state;
      if (!nextState) {
        return {
          ok: true as const,
          action: "done",
          terminal_state: currentStateId,
          summary: buildDoneSummary(reportOut.board, currentStateId),
        };
      }

      // Check if next state is terminal
      if (flow.states[nextState]?.type === "terminal") {
        return {
          ok: true as const,
          action: "done",
          terminal_state: nextState,
          summary: buildDoneSummary(reportOut.board, nextState),
        };
      }

      // Loop to the next state
      currentStateId = nextState;
      continue;
    }

    // Non-skipped state: build spawn requests
    const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);

    // Apply ADR-009a continue_from for fix-loop states
    const requestsWithSession = await applySessionContinuation(requests, workspace, currentStateId, store);

    return {
      ok: true as const,
      action: "spawn",
      requests: requestsWithSession,
    };
  }

  // Safety net: hit max skip iterations (shouldn't happen in practice)
  return toolError(
    "UNEXPECTED",
    `Exceeded maximum skip iterations (${MAX_SKIP_ITERATIONS}) in state loop`,
  );
}

// ---------------------------------------------------------------------------
// SpawnRequest marshalling
// ---------------------------------------------------------------------------

/**
 * Convert SpawnPromptEntry[] and consultation prompts into SpawnRequest[].
 */
function buildSpawnRequests(
  prompts: SpawnPromptEntry[],
  consultationPrompts?: ConsultationPromptEntry[],
): SpawnRequest[] {
  const requests: SpawnRequest[] = prompts.map((entry) => ({
    agent_type: entry.agent,
    prompt: entry.prompt,
    isolation: (entry.isolation ?? "none") as SpawnRequest["isolation"],
    ...(entry.role !== undefined ? { role: entry.role } : {}),
    ...(entry.item !== undefined
      ? {
          task_id:
            typeof entry.item === "string"
              ? entry.item
              : (entry.item as Record<string, unknown>).task_id as string | undefined,
        }
      : {}),
    ...(entry.worktree_path !== undefined ? { worktree_path: entry.worktree_path } : {}),
  }));

  if (consultationPrompts && consultationPrompts.length > 0) {
    for (const cp of consultationPrompts) {
      requests.push({
        agent_type: cp.agent,
        prompt: cp.prompt,
        isolation: "none",
        role: "consultation",
      });
    }
  }

  return requests;
}

// ---------------------------------------------------------------------------
// ADR-009a: Session continuation
// ---------------------------------------------------------------------------

/**
 * Apply continue_from to SpawnRequests when a fresh agent session exists.
 * Only adds continue_from when the session is < 10 minutes old.
 */
async function applySessionContinuation(
  requests: SpawnRequest[],
  workspace: string,
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<SpawnRequest[]> {
  const session = store.getAgentSession(stateId);
  if (!session) {
    return requests;
  }

  const now = Date.now();
  const lastActivity = new Date(session.last_agent_activity).getTime();
  const idleMs = now - lastActivity;

  if (idleMs >= AGENT_SESSION_EVICTION_MS) {
    // Session is stale — don't include continue_from
    return requests;
  }

  // Fresh session — inject continue_from into the primary (first) spawn request
  return requests.map((req, idx) => {
    if (idx === 0) {
      return {
        ...req,
        continue_from: {
          agent_id: session.agent_session_id,
          context_summary: `Continuing agent session for state '${stateId}'`,
        },
      };
    }
    return req;
  });
}

// ---------------------------------------------------------------------------
// Context builders for HITL and done summaries
// ---------------------------------------------------------------------------

function buildHitlContext(
  board: ReturnType<typeof getExecutionStore>["getBoard"] extends () => infer T ? NonNullable<T> : never,
  stateId: string,
  reportOut: { transition_condition: string; stuck: boolean; stuck_reason?: string; hitl_reason?: string },
): string {
  const parts: string[] = [
    `State: ${stateId}`,
    `Condition: ${reportOut.transition_condition}`,
  ];
  if (reportOut.stuck) {
    parts.push(`Stuck: ${reportOut.stuck_reason ?? "yes"}`);
  }
  if (reportOut.hitl_reason) {
    parts.push(`Reason: ${reportOut.hitl_reason}`);
  }
  const iter = board.iterations?.[stateId];
  if (iter) {
    parts.push(`Iteration: ${iter.count}/${iter.max}`);
  }
  return parts.join("\n");
}

function buildConvergenceContext(
  enterOut: { iteration_count: number; max_iterations: number; convergence_reason?: string },
): string {
  return [
    `Iterations: ${enterOut.iteration_count}/${enterOut.max_iterations}`,
    ...(enterOut.convergence_reason ? [`Reason: ${enterOut.convergence_reason}`] : []),
  ].join("\n");
}

function buildDoneSummary(
  board: ReturnType<typeof getExecutionStore>["getBoard"] extends () => infer T ? NonNullable<T> : never,
  terminalState: string,
): string {
  const stateCount = Object.keys(board.states ?? {}).length;
  const doneCount = Object.values(board.states ?? {}).filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
  return `Flow completed at state '${terminalState}'. States completed: ${doneCount}/${stateCount}.`;
}
