/**
 * drive-flow — Core state machine loop for server-side flow execution.
 *
 * Implements a turn-by-turn protocol:
 *   - First call (no result): enters entry state, returns SpawnRequest[]
 *   - Subsequent calls (with result): reports result, advances, returns next action
 *
 * Design decisions:
 *   - dd-009-01: Composition over inline — calls enterAndPrepareState and reportResult
 *   - dd-009-02: Server-side worktree lifecycle in drive_flow
 *   - dd-009-03: Wave result accumulation via SQLite wave_results column
 *   - dd-009-06: Timestamp-based agent session eviction for ADR-009a
 *
 * Canon principles:
 *   - toolresult-contract: returns ToolResult<DriveFlowAction>
 *   - sqlite-transactions: board mutations inside store.transaction()
 *   - no-silent-failures: convergence, stuck, HITL, merge conflicts all produce explicit breakpoints
 *   - subprocess-isolation: all git operations go through wave-lifecycle.ts (gitExecAsync)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { drainFlowEvents } from "@domains/flows/flow-event-channel.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import type {
  DriveFlowAction,
  DriveFlowInput,
  SpawnRequest,
} from "../services/drive-flow-types.ts";
import { DriveFlowInputSchema, type DriveFlowParsed } from "../services/drive-flow-types.ts";
import {
  applySessionContinuation,
  buildApprovalAction,
  buildConvergenceHitl,
  buildDoneSummary,
  buildHitlContext,
  buildSpawnRequests,
  buildTerminalAction,
  type DriveCtx,
  handleGateFailure,
  handleSkippedState,
  injectSettingsIntoRequests,
  isParallelWaitState,
  persistToolScopeWarnings,
  resolveAndRunGates,
} from "./drive-flow-helpers.ts";
import { enterWaveState, handleWaveTaskResult } from "./drive-flow-wave.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import { reportResult } from "./report-result.ts";

// Re-export types for external consumers
export type { DriveFlowAction, DriveFlowInput, SpawnRequest };

// Re-export helpers used by other modules
export { buildSpawnRequests, injectSettingsIntoRequests };

// Approval gate helpers (ADR-017)

/**
 * Determine if a state should trigger an approval gate.
 * Checks explicit approval_gate field first, then applies tier-based defaults.
 * Returns false if auto_approve bypass is active.
 */
export function shouldApprovalGate(
  stateDef: StateDefinition | undefined,
  flow: DriveFlowInput["flow"],
  board: Board,
): boolean {
  if (!stateDef) return false;
  if (stateDef.type === "terminal") return false;

  // Explicit opt-out
  if (stateDef.approval_gate === false) return false;

  // Check auto_approve skip
  if (board.metadata?.auto_approve === true) return false;

  // Explicit opt-in
  if (stateDef.approval_gate === true) return true;

  // Tier-based defaults (approval_gate is undefined — apply defaults)
  const tier = flow.tier;
  if (tier === "medium" || tier === "large") {
    // Default gate on design states (agent is canon-architect, with or without prefix)
    const isArchitect =
      stateDef.agent === "canon-architect" || stateDef.agent === "canon:canon-architect";
    if (!isArchitect) return false;
    // Only apply default gate when the state's transitions include approval-related keys.
    // This prevents gating flows like migrate.md where design only has done/has_questions.
    const transitions = stateDef.transitions ?? {};
    const hasApprovalTransitions =
      "approved" in transitions || "revise" in transitions || "reject" in transitions;
    return hasApprovalTransitions;
  }

  return false;
}

/**
 * Determine if a wave boundary should trigger an approval gate.
 * Only applies to epic/large tier flows with more waves remaining.
 */
export function shouldApprovalGateWaveBoundary(
  stateDef: StateDefinition | undefined,
  flow: DriveFlowInput["flow"],
  board: Board,
): boolean {
  if (!stateDef) return false;
  if (stateDef.type !== "wave") return false;
  if (board.metadata?.auto_approve === true) return false;
  if (stateDef.approval_gate === false) return false;

  // Explicit opt-in on the wave state
  if (stateDef.approval_gate === true) return true;

  // Tier default: large gets wave boundary gates
  const tier = flow.tier;
  return tier === "large";
}

// driveFlow

/**
 * Drive the flow state machine by one turn.
 *
 * If `input.result` is absent: enters the current state and returns spawn requests.
 * If `input.result` is present: reports the result, advances the loop, returns the next action.
 */
/** Validate driveFlow input and return parsed data + store + board, or an error. */
function validateDriveFlowInput(input: DriveFlowInput): ToolResult<{
  data: DriveFlowParsed;
  store: ReturnType<typeof getExecutionStore>;
  board: Board;
}> {
  const parseResult = DriveFlowInputSchema.safeParse(input);
  if (!parseResult.success) {
    return toolError("INVALID_INPUT", parseResult.error.message);
  }
  const { workspace } = parseResult.data;
  if (!existsSync(resolve(workspace))) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace directory does not exist: ${workspace}`);
  }
  const store = getExecutionStore(workspace);
  const board = store.getBoard();
  if (!board) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${workspace}`);
  }
  return { board, data: parseResult.data, ok: true as const, store };
}

/** Check if a status string is an approval decision keyword. */
function isApprovalDecisionStatus(status: string): boolean {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "approved" ||
    normalized === "approve" ||
    normalized === "revise" ||
    normalized === "reject" ||
    normalized === "rejected"
  );
}

type HandleWaveResultOpts = {
  state_id: string;
  task_id: string | undefined;
  status: string;
  artifacts: string[] | undefined;
  store: ReturnType<typeof getExecutionStore>;
  /** Actual branch used by the agent's worktree (e.g. "worktree-agent-*"). */
  worktree_branch?: string;
};

/** Handle the result of a wave-type state, routing to wave task handler or validating task_id. */
function handleWaveResult(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: HandleWaveResultOpts,
): Promise<ToolResult<DriveFlowAction>> | ToolResult<DriveFlowAction> | null {
  const { state_id, task_id, status, artifacts, store, worktree_branch } = opts;
  const stateDef = flow.states[state_id];
  if (stateDef?.type !== "wave") return null;
  if (task_id) {
    return handleWaveTaskResult({
      flow,
      state_id,
      store,
      task_artifacts: artifacts,
      task_id,
      task_status: status,
      workspace,
      worktree_branch,
    });
  }
  return toolError(
    "INVALID_INPUT",
    `Wave state '${state_id}' received a result without task_id. Wave results must include task_id to identify which task completed.`,
  );
}

// ---------------------------------------------------------------------------
// Flow event channel drain (ADR-012 / fe-03)
// ---------------------------------------------------------------------------

/**
 * Drain the flow-events channel, persist the updated watermark, and return an
 * override action if the effect demands it (insert, skip, escalate).
 *
 * Returns `null` when the effect is `{ type: "none" }` — callers should proceed
 * normally.  Returns a `ToolResult<DriveFlowAction>` for any non-none effect.
 *
 * Called:
 *   1. After reportResult resolves (resolvePostReportAction / routeReportResult)
 *   2. At the wave boundary after handlePendingWaveEvents (completeWave)
 *
 * @param resumeStateId - The state to return to after the inserted state completes ("done").
 *   Pass `reportOut.next_state` from the calling context, or `null` at the wave boundary.
 */
type ApplyFlowEventDrainOpts = {
  workspace: string;
  flow: DriveFlowInput["flow"];
  currentStateId: string;
  store: ReturnType<typeof getExecutionStore>;
  resumeStateId: string | null;
  projectDir: string;
};

export async function applyFlowEventDrain(
  opts: ApplyFlowEventDrainOpts,
): Promise<ToolResult<DriveFlowAction> | null> {
  const { workspace, flow, currentStateId, store, resumeStateId, projectDir } = opts;
  const board = store.getBoard();
  const watermark =
    typeof board?.metadata?.flow_events_watermark === "number"
      ? board.metadata.flow_events_watermark
      : 0;

  const { effect, newWatermark } = drainFlowEvents({
    currentStateId,
    flowDef: flow,
    store,
    watermark,
  });

  // Persist the watermark whenever it advances so subsequent calls don't reprocess messages
  if (newWatermark > watermark) {
    const freshBoard = store.getBoard();
    store.updateExecution({
      metadata: { ...(freshBoard?.metadata ?? {}), flow_events_watermark: newWatermark },
    });
  }

  if (effect.type === "none") return null;

  if (effect.type === "insert") {
    const driveCtx: DriveCtx = { flow, projectDir, store, workspace };
    const spawnAction = await enterStateAndBuildSpawn(driveCtx, effect.state_id);
    // Persist the return address so that when the inserted state completes with "done",
    // the flow resumes at resumeStateId instead of the inserted state's own transition target.
    if (resumeStateId !== null) {
      const insertedEntry = store.getState(effect.state_id);
      store.upsertState(effect.state_id, {
        entries: insertedEntry?.entries ?? 1,
        inserted_return_to: resumeStateId,
        status: insertedEntry?.status ?? "in_progress",
      });
    }
    return spawnAction;
  }

  if (effect.type === "skip") {
    return enterStateAndBuildSpawn({ flow, projectDir, store, workspace }, effect.target);
  }

  // effect.type === "escalate"
  return {
    action: "hitl",
    breakpoint: {
      context: "",
      ...(effect.suggested_options ? { options: effect.suggested_options } : {}),
      reason: effect.message,
    },
    ok: true as const,
  };
}

type ResolvePostReportOpts = {
  state_id: string;
  status: string;
  artifacts: string[] | undefined;
  reportOut: Awaited<ReturnType<typeof reportResult>> & { ok: true };
  store: ReturnType<typeof getExecutionStore>;
  projectDir: string;
};

/** Check post-report conditions and return the appropriate action. */
async function resolvePostReportAction(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: ResolvePostReportOpts,
): Promise<ToolResult<DriveFlowAction>> {
  const { state_id, status, artifacts, reportOut, store, projectDir } = opts;
  const freshBoard = store.getBoard();
  if (!freshBoard) {
    return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
  }

  const { next_state, hitl_required, hitl_reason, stuck_reason } = reportOut;

  if (hitl_required) {
    return {
      action: "hitl",
      breakpoint: {
        context: buildHitlContext(freshBoard, state_id, reportOut),
        reason: hitl_reason ?? stuck_reason ?? "HITL required",
      },
      ok: true as const,
    };
  }

  const completedDef = flow.states[state_id];

  if (next_state === state_id && isParallelWaitState(completedDef)) {
    return { action: "spawn", ok: true as const, requests: [] };
  }

  if (!isApprovalDecisionStatus(status) && shouldApprovalGate(completedDef, flow, freshBoard)) {
    return buildApprovalAction(completedDef, artifacts, state_id, status);
  }

  // Flow event drain — check for agent/external directives before advancing.
  // Pass next_state as resumeStateId so an inserted state can return here when done.
  const drainAction = await applyFlowEventDrain({
    currentStateId: state_id,
    flow,
    projectDir,
    resumeStateId: next_state ?? null,
    store,
    workspace,
  });
  if (drainAction !== null) return drainAction;

  // Return-address semantics: if this state was inserted and completed with "done",
  // resume at the stored return address instead of the state's own transition target.
  const returnAddress = store.getState(state_id)?.inserted_return_to;
  const effectiveNextState =
    returnAddress && reportOut.transition_condition === "done" ? returnAddress : next_state;

  return resolveNextStateAction(workspace, flow, {
    board: store.getBoard() ?? freshBoard,
    current_state: state_id,
    next_state: effectiveNextState,
    projectDir,
    store,
  });
}

type ResolveNextStateOpts = {
  next_state: string | null | undefined;
  current_state: string;
  board: Board;
  store: ReturnType<typeof getExecutionStore>;
  projectDir: string;
};

/** Determine the action for the next state (done or spawn). */
export async function resolveNextStateAction(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: ResolveNextStateOpts,
): Promise<ToolResult<DriveFlowAction>> {
  const { next_state, current_state, board, store, projectDir } = opts;
  if (!next_state) {
    // Site 1: no next state — current state is terminal
    const doneSummary = await buildDoneSummary(board, current_state, projectDir);
    return {
      action: "done",
      ok: true as const,
      terminal_state: current_state,
      ...doneSummary,
    };
  }
  const nextStateDef = flow.states[next_state];
  if (nextStateDef?.type === "terminal") {
    // Site 2: next state is a terminal state
    const doneSummary = await buildDoneSummary(board, next_state, projectDir);
    return {
      action: "done",
      ok: true as const,
      terminal_state: next_state,
      ...doneSummary,
    };
  }
  return enterStateAndBuildSpawn({ flow, projectDir, store, workspace }, next_state);
}

export async function driveFlow(
  input: DriveFlowInput,
  projectDir: string,
): Promise<ToolResult<DriveFlowAction>> {
  const validated = validateDriveFlowInput(input);
  if (!validated.ok) return validated;
  const { data, store, board } = validated;
  const { workspace, flow } = data;

  if (data.result) {
    const {
      state_id,
      status,
      artifacts,
      parallel_results,
      metrics,
      agent_session_id,
      task_id,
      worktree_branch,
    } = data.result;

    if (agent_session_id) store.updateAgentSession(state_id, agent_session_id);

    const waveAction = handleWaveResult(workspace, flow, {
      artifacts,
      state_id,
      status,
      store,
      task_id,
      worktree_branch,
    });
    if (waveAction) return waveAction;

    const reportOut = await reportResult({
      artifacts,
      flow,
      metrics: metrics as Parameters<typeof reportResult>[0]["metrics"],
      parallel_results: parallel_results as
        | Array<{ item: string; status: string; artifacts?: string[] }>
        | undefined,
      state_id,
      status_keyword: status,
      workspace,
    });
    if (!reportOut.ok) return reportOut as ToolResult<DriveFlowAction>;

    return resolvePostReportAction(workspace, flow, {
      artifacts,
      projectDir,
      reportOut,
      state_id,
      status,
      store,
    });
  }

  // Branch B: no result — first call or re-entry after HITL
  const targetState = board.current_state ?? flow.entry;
  const targetStateDef = flow.states[targetState];
  if (targetStateDef?.type === "terminal") {
    const doneSummary = await buildDoneSummary(board, targetState, projectDir);
    return {
      action: "done",
      ok: true as const,
      terminal_state: targetState,
      ...doneSummary,
    };
  }
  return enterStateAndBuildSpawn({ flow, projectDir, store, workspace }, targetState);
}

// ---------------------------------------------------------------------------
// Internal: enter state with skip-state loop
// ---------------------------------------------------------------------------

/** Try to enter a single state. Returns a final action, or { nextStateId } to continue the skip loop. */
async function tryEnterSingleState(
  ctx: DriveCtx,
  currentStateId: string,
): Promise<ToolResult<DriveFlowAction> | { nextStateId: string }> {
  const { workspace, flow, store, projectDir } = ctx;
  const stateDef = flow.states[currentStateId];
  if (stateDef?.type === "terminal")
    return buildTerminalAction(workspace, currentStateId, store, projectDir);
  if (stateDef?.type === "wave") return enterWaveState(workspace, flow, currentStateId, store);

  // Gate-only state: no agent — run explicit or discovered gates deterministically, skip agent spawn
  if (stateDef?.type === "single" && !stateDef.agent) {
    return handleGateOnlyState(ctx, currentStateId, stateDef);
  }

  const enterOut = await enterAndPrepareState({
    flow,
    state_id: currentStateId,
    variables: {},
    workspace,
  });
  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;
  if (!enterOut.can_enter) return buildConvergenceHitl(currentStateId, enterOut);

  if (enterOut.skip_reason) return handleSkippedState(workspace, flow, currentStateId, projectDir);

  persistToolScopeWarnings(enterOut.prompts, currentStateId, store);
  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithSession = await applySessionContinuation(requests, currentStateId, store);
  await injectSettingsIntoRequests(requestsWithSession);
  return { action: "spawn", ok: true as const, requests: requestsWithSession };
}

async function enterStateAndBuildSpawn(
  ctx: DriveCtx,
  stateId: string,
): Promise<ToolResult<DriveFlowAction>> {
  const MAX_SKIP_ITERATIONS = 50;
  let currentStateId = stateId;

  for (let i = 0; i < MAX_SKIP_ITERATIONS; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: state machine loop — each iteration depends on the previous state's result
    const result = await tryEnterSingleState(ctx, currentStateId);
    if ("nextStateId" in result) {
      currentStateId = result.nextStateId;
      continue;
    }
    return result;
  }

  return toolError(
    "UNEXPECTED",
    `Exceeded maximum skip iterations (${MAX_SKIP_ITERATIONS}) in state loop`,
  );
}

// ---------------------------------------------------------------------------
// Gate-only state handler (needs enterStateAndBuildSpawn — stays in this file)
// ---------------------------------------------------------------------------

/**
 * Handle a gate-only state: a single state with no agent.
 *
 * Enters the state on the board (for convergence tracking), runs gates deterministically,
 * then either auto-advances (all gates pass) or returns a HITL breakpoint (any gate fails).
 *
 * Gate resolution: if the state declares explicit `gates: [...]`, those run. Otherwise,
 * discovered gates from all prior board states are collected and executed. This makes the
 * pre-launch-check language-agnostic — agents discover the right commands during the build.
 *
 * Fail-closed: empty gate results (no gates resolved/discovered) are treated as failure.
 */
async function handleGateOnlyState(
  ctx: DriveCtx,
  stateId: string,
  stateDef: StateDefinition,
): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, store, projectDir } = ctx;
  const enterOut = await enterAndPrepareState({
    flow,
    state_id: stateId,
    variables: {},
    workspace,
  });
  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;
  if (!enterOut.can_enter) return buildConvergenceHitl(stateId, enterOut);

  const gateResults = resolveAndRunGates(stateDef, flow, store, projectDir);
  const allPassed = gateResults.length > 0 && gateResults.every((g) => g.passed);

  if (!allPassed) return handleGateFailure(gateResults, ctx, stateId);

  const reportOut = await reportResult({
    flow,
    gate_results: gateResults,
    progress_line: `Pre-launch check passed (${gateResults.length} gates)`,
    state_id: stateId,
    status_keyword: "done",
    workspace,
  });
  if (!reportOut.ok) return reportOut as ToolResult<DriveFlowAction>;
  if (!reportOut.next_state) {
    const board = store.getBoard();
    if (!board)
      return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
    const doneSummary = await buildDoneSummary(board, stateId, projectDir);
    return { action: "done", ok: true as const, terminal_state: stateId, ...doneSummary };
  }
  return enterStateAndBuildSpawn(ctx, reportOut.next_state);
}
