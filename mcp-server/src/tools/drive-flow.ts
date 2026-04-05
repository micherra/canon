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
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DriveFlowAction,
  DriveFlowInput,
  SpawnRequest,
} from "../orchestration/drive-flow-types.ts";
import { DriveFlowInputSchema } from "../orchestration/drive-flow-types.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, StateDefinition, WaveResult } from "../orchestration/flow-schema.ts";
import { runGates } from "../orchestration/gate-runner.ts";
import type { WaveWorktreeResult } from "../orchestration/wave-lifecycle.ts";
import {
  cleanupWorktrees,
  createWaveWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "../orchestration/wave-lifecycle.ts";
import { parseTaskIdsForWave } from "../orchestration/wave-variables.ts";
import type { ToolResult } from "../shared/lib/tool-result.ts";
import { toolError } from "../shared/lib/tool-result.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import type { SpawnPromptEntry } from "./get-spawn-prompt.ts";
import { reportResult } from "./report-result.ts";
import { resolveAfterConsultations } from "./resolve-after-consultations.ts";

// Re-export types for external consumers
export type { DriveFlowAction, DriveFlowInput, SpawnRequest };

// Agent session eviction threshold (ADR-009a)

const AGENT_SESSION_EVICTION_MS = 600_000; // 10 minutes

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
function validateDriveFlowInput(
  input: DriveFlowInput,
): ToolResult<{ data: DriveFlowInput; store: ReturnType<typeof getExecutionStore>; board: Board }> {
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
  artifacts: unknown;
  store: ReturnType<typeof getExecutionStore>;
};

/** Handle the result of a wave-type state, routing to wave task handler or validating task_id. */
function handleWaveResult(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: HandleWaveResultOpts,
): Promise<ToolResult<DriveFlowAction>> | ToolResult<DriveFlowAction> | null {
  const { state_id, task_id, status, artifacts, store } = opts;
  const stateDef = flow.states[state_id];
  if (stateDef?.type !== "wave") return null;
  if (task_id) {
    return handleWaveTaskResult({
      flow,
      state_id,
      store,
      task_artifacts: artifacts as string[] | undefined,
      task_id,
      task_status: status,
      workspace,
    });
  }
  return toolError(
    "INVALID_INPUT",
    `Wave state '${state_id}' received a result without task_id. Wave results must include task_id to identify which task completed.`,
  );
}

type ResolvePostReportOpts = {
  state_id: string;
  status: string;
  artifacts: unknown;
  reportOut: Awaited<ReturnType<typeof reportResult>> & { ok: true };
  store: ReturnType<typeof getExecutionStore>;
};

/** Check post-report conditions and return the appropriate action. */
async function resolvePostReportAction(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: ResolvePostReportOpts,
): Promise<ToolResult<DriveFlowAction>> {
  const { state_id, status, artifacts, reportOut, store } = opts;
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

  // Parallel wait guard
  const completedDef = flow.states[state_id];
  if (
    next_state === state_id &&
    (completedDef?.type === "parallel" || completedDef?.type === "parallel-per")
  ) {
    return { action: "spawn", ok: true as const, requests: [] };
  }

  // Approval gate
  if (!isApprovalDecisionStatus(status) && shouldApprovalGate(completedDef, flow, freshBoard)) {
    return {
      action: "approval" as const,
      breakpoint: {
        agent_type: completedDef?.agent ?? completedDef?.type ?? "unknown",
        artifacts: (artifacts as string[] | undefined) ?? [],
        options: ["approved", "revise", "reject"] as const,
        state_id,
        summary: `State '${state_id}' completed with status '${status}'. Awaiting approval.`,
      },
      ok: true as const,
    };
  }

  return resolveNextStateAction(workspace, flow, {
    board: freshBoard,
    current_state: state_id,
    next_state,
    store,
  });
}

type ResolveNextStateOpts = {
  next_state: string | null | undefined;
  current_state: string;
  board: Board;
  store: ReturnType<typeof getExecutionStore>;
};

/** Determine the action for the next state (done or spawn). */
function resolveNextStateAction(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: ResolveNextStateOpts,
): Promise<ToolResult<DriveFlowAction>> | ToolResult<DriveFlowAction> {
  const { next_state, current_state, board, store } = opts;
  if (!next_state) {
    return {
      action: "done",
      ok: true as const,
      summary: buildDoneSummary(board, current_state),
      terminal_state: current_state,
    };
  }
  const nextStateDef = flow.states[next_state];
  if (nextStateDef?.type === "terminal") {
    return {
      action: "done",
      ok: true as const,
      summary: buildDoneSummary(board, next_state),
      terminal_state: next_state,
    };
  }
  return enterStateAndBuildSpawn(workspace, flow, next_state, store);
}

export async function driveFlow(input: DriveFlowInput): Promise<ToolResult<DriveFlowAction>> {
  const validated = validateDriveFlowInput(input);
  if (!validated.ok) return validated;
  const { data, store, board } = validated;
  const { workspace, flow } = data;

  // Branch A: result provided
  if (data.result) {
    const { state_id, status, artifacts, parallel_results, metrics, agent_session_id, task_id } =
      data.result;

    if (agent_session_id) store.updateAgentSession(state_id, agent_session_id);

    const waveAction = handleWaveResult(workspace, flow, {
      artifacts,
      state_id,
      status,
      store,
      task_id,
    });
    if (waveAction) return waveAction;

    const reportOut = await reportResult({
      artifacts: artifacts as string[] | undefined,
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
    return {
      action: "done",
      ok: true as const,
      summary: buildDoneSummary(board, targetState),
      terminal_state: targetState,
    };
  }
  return enterStateAndBuildSpawn(workspace, flow, targetState, store);
}

// Wave state handling

type WaveTaskResultInput = {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  task_id: string;
  task_status: string;
  task_artifacts?: string[];
  store: ReturnType<typeof getExecutionStore>;
};

/** Persist a wave task result into the store atomically. */
function persistWaveTaskResult(
  store: ReturnType<typeof getExecutionStore>,
  input: WaveTaskResultInput,
  conventionWorktreePath: string,
  conventionBranch: string,
): void {
  const { state_id, task_id, task_status, task_artifacts } = input;
  store.transaction(() => {
    const existing = store.getState(state_id);
    const waveResults: Record<
      string,
      WaveResult & { worktree_path?: string; branch?: string; artifacts?: string[] }
    > =
      (existing?.wave_results as Record<
        string,
        WaveResult & { worktree_path?: string; branch?: string; artifacts?: string[] }
      >) ?? {};
    const existingEntry = waveResults[task_id];
    waveResults[task_id] = {
      branch: existingEntry?.branch ?? conventionBranch,
      status: task_status,
      tasks: [task_id],
      worktree_path: existingEntry?.worktree_path ?? conventionWorktreePath,
      ...(task_artifacts && task_artifacts.length > 0 ? { artifacts: task_artifacts } : {}),
    };
    const currentEntries = existing?.entries ?? 0;
    store.upsertState(state_id, {
      entries: currentEntries,
      status: "in_progress",
      wave: existing?.wave ?? 1,
      wave_results: waveResults,
      wave_total: existing?.wave_total,
    });
  });
}

/**
 * Handle a wave task result submission.
 *
 * Per dd-009-03: append result to wave_results in a SQLite transaction,
 * check if all tasks complete, and proceed to merge if so.
 */
async function handleWaveTaskResult(
  input: WaveTaskResultInput,
): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, task_id, store } = input;

  const projectDir = getProjectDir(workspace);
  const conventionWorktreePath = join(projectDir, ".canon", "worktrees", task_id);
  const conventionBranch = `canon-wave/${task_id}`;

  persistWaveTaskResult(store, input, conventionWorktreePath, conventionBranch);

  // Re-read after transaction
  const stateEntry = store.getState(state_id);
  const waveResults: Record<string, WaveResult> =
    (stateEntry?.wave_results as Record<string, WaveResult>) ?? {};
  const waveTotal = stateEntry?.wave_total ?? 0;
  const currentWave = stateEntry?.wave ?? 1;

  // Guard: wave_total must be a positive integer before allowing completion
  if (!waveTotal || waveTotal <= 0) {
    return toolError(
      "UNEXPECTED",
      `Wave state '${state_id}' has invalid wave_total (${waveTotal}). Wave total must be set to a positive integer when entering the wave state.`,
    );
  }

  // Not all tasks done yet — return waiting signal (empty requests)
  if (Object.keys(waveResults).length < waveTotal) {
    return {
      action: "spawn",
      ok: true as const,
      requests: [],
    };
  }

  // All tasks for this wave are done — proceed to merge + gate + events
  return completeWave({
    currentWave,
    flow,
    state_id,
    store,
    workspace,
  });
}

type CompleteWaveInput = {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  currentWave: number;
  store: ReturnType<typeof getExecutionStore>;
};

/**
 * Complete a wave: merge worktrees, run gates, handle events, advance.
 *
 * Called after all tasks in currentWave have submitted results.
 */
/** Build WaveWorktreeResult array from stored wave results. */
function buildWorktreeResults(
  waveResults: Record<string, WaveResult>,
  projectDir: string,
): WaveWorktreeResult[] {
  return Object.keys(waveResults)
    .sort()
    .map((tid) => {
      const entry = waveResults[tid] as
        | (WaveResult & { worktree_path?: string; branch?: string })
        | undefined;
      return {
        branch: typeof entry?.branch === "string" ? entry.branch : `canon-wave/${tid}`,
        task_id: tid,
        worktree_path:
          typeof entry?.worktree_path === "string"
            ? entry.worktree_path
            : join(projectDir, ".canon", "worktrees", tid),
      };
    });
}

type HandleMergeFailureOpts = {
  onConflict: "hitl" | "replan" | "retry-single";
  flow: DriveFlowInput["flow"];
  state_id: string;
  mergeStrategy: string;
  store: ReturnType<typeof getExecutionStore>;
};

/** Handle a merge failure — route to conflict handler or return unexpected error. */
async function handleMergeFailure(
  mergeResult: { ok: false; conflict_task: string; conflict_detail: string },
  opts: HandleMergeFailureOpts,
): Promise<ToolResult<DriveFlowAction>> {
  const { onConflict, flow, state_id, mergeStrategy, store } = opts;
  const conflictTask = mergeResult.conflict_task.trim();
  if (conflictTask) {
    return handleMergeConflict({
      conflictDetail: mergeResult.conflict_detail,
      conflictTask,
      flow,
      onConflict,
      state_id,
      store,
    });
  }
  const detail = mergeResult.conflict_detail.trim()
    ? ` Details: ${mergeResult.conflict_detail.trim()}`
    : "";
  return toolError(
    "UNEXPECTED",
    `Wave merge failed for state '${state_id}' with strategy '${mergeStrategy}', but no conflicting task was reported. The merge strategy may be unsupported or not yet implemented.${detail}`,
  );
}

type RouteReportResultOpts = {
  state_id: string;
  reportOut: Awaited<ReturnType<typeof reportResult>> & { ok: true };
  store: ReturnType<typeof getExecutionStore>;
};

/** Route a report result to HITL, done, or next-state spawn. */
async function routeReportResult(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: RouteReportResultOpts,
): Promise<ToolResult<DriveFlowAction>> {
  const { state_id, reportOut, store } = opts;
  const { next_state, hitl_required, hitl_reason, stuck_reason } = reportOut;

  if (hitl_required) {
    const board = store.getBoard();
    if (!board)
      return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
    return {
      action: "hitl",
      breakpoint: {
        context: buildHitlContext(board, state_id, reportOut),
        reason: hitl_reason ?? stuck_reason ?? "HITL required",
      },
      ok: true as const,
    };
  }

  return resolveNextStateAction(workspace, flow, {
    board: store.getBoard()!,
    current_state: state_id,
    next_state,
    store,
  });
}

type HandleLastWaveOpts = {
  state_id: string;
  statusKeyword: string;
  gateResults: ReturnType<typeof runGates>;
  store: ReturnType<typeof getExecutionStore>;
};

/** Handle the last wave: after-consultations, report result, and advance. */
async function handleLastWave(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: HandleLastWaveOpts,
): Promise<ToolResult<DriveFlowAction>> {
  const { state_id, statusKeyword, gateResults, store } = opts;
  const afterConsultationsResult = resolveAfterConsultations({
    flow,
    state_id,
    variables: {},
    workspace,
  });
  const afterConsultationPrompts = afterConsultationsResult?.consultation_prompts ?? [];

  if (afterConsultationPrompts.length > 0) {
    return {
      action: "spawn",
      ok: true as const,
      requests: afterConsultationPrompts.map((cp) => ({
        agent_type: cp.agent,
        isolation: "none" as const,
        prompt: cp.prompt,
        role: "consultation",
      })),
    };
  }

  const reportOut = await reportResult({
    flow,
    gate_results: gateResults,
    state_id,
    status_keyword: statusKeyword,
    workspace,
  });
  if (!reportOut.ok) return reportOut as ToolResult<DriveFlowAction>;

  return routeReportResult(workspace, flow, { reportOut, state_id, store });
}

type CheckWaveBoundaryApprovalOpts = {
  state_id: string;
  currentWave: number;
  nextWaveTaskIds: string[];
  store: ReturnType<typeof getExecutionStore>;
};

/** Check wave boundary approval gate and return approval action if needed. */
function checkWaveBoundaryApproval(
  stateDef: StateDefinition | undefined,
  flow: DriveFlowInput["flow"],
  opts: CheckWaveBoundaryApprovalOpts,
): ToolResult<DriveFlowAction> | null {
  const { state_id, currentWave, nextWaveTaskIds, store } = opts;
  const board = store.getBoard();
  if (!board || !shouldApprovalGateWaveBoundary(stateDef, flow, board)) return null;
  return {
    action: "approval" as const,
    breakpoint: {
      agent_type: stateDef?.agent ?? "wave",
      artifacts: [],
      options: ["approved", "revise", "reject"] as const,
      state_id,
      summary: `Wave ${currentWave} completed. ${nextWaveTaskIds.length} tasks in next wave. Awaiting approval to proceed.`,
    },
    ok: true as const,
  };
}

async function completeWave(input: CompleteWaveInput): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, currentWave, store } = input;

  const stateDef = flow.states[state_id];
  const wavePolicy = stateDef?.type === "wave" ? stateDef.wave_policy : undefined;
  const mergeStrategy = wavePolicy?.merge_strategy ?? "sequential";
  const onConflict = wavePolicy?.on_conflict ?? "hitl";
  const projectDir = getProjectDir(workspace);

  const stateEntry = store.getState(state_id);
  const waveResults: Record<string, WaveResult> =
    (stateEntry?.wave_results as Record<string, WaveResult>) ?? {};
  const worktreeResults = buildWorktreeResults(waveResults, projectDir);

  const mergeResult = await mergeWaveResults(worktreeResults, projectDir, mergeStrategy);
  if (!mergeResult.ok) {
    return handleMergeFailure(
      mergeResult as { ok: false; conflict_task: string; conflict_detail: string },
      { flow, mergeStrategy, onConflict, state_id, store },
    );
  }

  await cleanupWorktrees(worktreeResults, projectDir);

  if (!stateDef) {
    return toolError(
      "UNEXPECTED",
      `State definition not found for state '${state_id}' during wave completion`,
    );
  }

  const gateResults = runGates(stateDef, flow, projectDir, stateEntry ?? undefined);
  const statusKeyword = gateResults.some((g) => !g.passed) ? "gate_failed" : "done";

  const eventResult = handlePendingWaveEvents(store, currentWave);
  if (eventResult !== null) return eventResult;

  const nextWave = currentWave + 1;
  const nextWaveTaskIds = await resolveNextWaveTaskIds(workspace, store, nextWave);

  if (nextWaveTaskIds.length === 0) {
    return handleLastWave(workspace, flow, { gateResults, state_id, statusKeyword, store });
  }

  const approvalAction = checkWaveBoundaryApproval(stateDef, flow, {
    currentWave,
    nextWaveTaskIds,
    state_id,
    store,
  });
  if (approvalAction) return approvalAction;

  return startNextWave({ flow, nextWave, nextWaveTaskIds, projectDir, state_id, store, workspace });
}

type HandleMergeConflictInput = {
  conflictTask: string;
  conflictDetail: string;
  onConflict: "hitl" | "replan" | "retry-single";
  flow: DriveFlowInput["flow"];
  state_id: string;
  store: ReturnType<typeof getExecutionStore>;
};

/**
 * Handle a merge conflict per the WavePolicy.on_conflict strategy.
 * (no-silent-failures: conflicts always surface as structured outputs)
 */
async function handleMergeConflict(
  input: HandleMergeConflictInput,
): Promise<ToolResult<DriveFlowAction>> {
  const { conflictTask, conflictDetail, onConflict, flow, state_id, store } = input;

  if (onConflict === "hitl") {
    return {
      action: "hitl",
      breakpoint: {
        context: `Task: ${conflictTask}\nConflict detail: ${conflictDetail}`,
        options: [
          "Resolve conflict manually and retry",
          "Abandon the conflicting task",
          "Replan the wave",
        ],
        reason: `Merge conflict in wave task '${conflictTask}'`,
      },
      ok: true as const,
    };
  }

  if (onConflict === "replan") {
    return {
      action: "hitl",
      breakpoint: {
        context: `Task: ${conflictTask}\nConflict detail: ${conflictDetail}\nSuggestion: Split or reorder conflicting tasks to avoid overlap.`,
        options: ["Replan affected tasks", "Abandon conflicting task and continue"],
        reason: `replan: Merge conflict requires replanning — conflict in task '${conflictTask}'`,
      },
      ok: true as const,
    };
  }

  // retry-single: return a SpawnRequest for the conflicting task only.
  // Look up the persisted worktree path from wave_results so the agent lands in
  // the correct worktree — the server owns the worktree lifecycle (dd-009-02).
  const stateDef = flow.states[state_id];
  const spawnInstruction = flow.spawn_instructions[state_id] ?? "Retry task";

  const stateEntry = store.getState(state_id);
  const waveResults = stateEntry?.wave_results as
    | Record<string, { worktree_path?: string }>
    | undefined;
  const worktreePath = waveResults?.[conflictTask]?.worktree_path;

  return {
    action: "spawn",
    ok: true as const,
    requests: [
      {
        agent_type: stateDef?.agent ?? "canon:canon-implementor",
        isolation: "worktree",
        prompt: `${spawnInstruction}\n\nNote: This is a retry for task '${conflictTask}' after a merge conflict. Conflict detail:\n${conflictDetail}`,
        task_id: conflictTask,
        ...(worktreePath ? { worktree_path: worktreePath } : {}),
      },
    ],
  };
}

// Wave event and next-wave helpers (extracted from completeWave for testability)

/**
 * Handle pending wave events between waves.
 *
 * - `pause` event  → returns a HITL breakpoint immediately (non-null)
 * - `skip_task` events → applied mechanically; returns null (proceed)
 * - No pending events  → returns null (proceed)
 */
function handlePendingWaveEvents(
  store: ReturnType<typeof getExecutionStore>,
  currentWave: number,
): ToolResult<DriveFlowAction> | null {
  const pendingEvents = store.getWaveEvents({ status: "pending" });
  if (pendingEvents.length === 0) return null;

  const pauseEvent = pendingEvents.find((e) => e.type === "pause");
  if (pauseEvent) {
    return {
      action: "hitl",
      breakpoint: {
        context: `Wave ${currentWave} merged successfully. Pause event ID: ${pauseEvent.id}`,
        reason: `pause: wave execution paused — ${String(pauseEvent.payload.reason ?? "user requested pause")}`,
      },
      ok: true as const,
    };
  }

  // Handle skip_task events mechanically
  const skipTaskEvents = pendingEvents.filter((e) => e.type === "skip_task");
  for (const evt of skipTaskEvents) {
    try {
      store.updateWaveEvent(evt.id, {
        applied_at: new Date().toISOString(),
        resolution: { skipped_by: "drive_flow" },
        status: "applied",
      });
    } catch {
      // Already applied — ignore
    }
  }

  return null;
}

/**
 * Resolve the task IDs for the next wave by reading INDEX.md and filtering
 * out any tasks targeted by pending skip_task events.
 *
 * Returns an empty array when no tasks exist for that wave or INDEX.md is absent.
 */
async function resolveNextWaveTaskIds(
  workspace: string,
  store: ReturnType<typeof getExecutionStore>,
  nextWave: number,
): Promise<string[]> {
  const slug = store.getSession()?.slug;
  if (!slug) return [];

  const indexPath = join(workspace, "plans", slug, "INDEX.md");
  if (!existsSync(indexPath)) return [];

  const indexContent = await readFile(indexPath, "utf-8");
  let taskIds = parseTaskIdsForWave(indexContent, nextWave);

  // Filter out tasks targeted by applied or pending skip_task events.
  // skip_task events may already be marked "applied" by handlePendingWaveEvents,
  // so we look at ALL skip_task events regardless of status.
  const allSkipEvents = store.getWaveEvents({}).filter((e) => e.type === "skip_task");
  const skipIds = new Set(allSkipEvents.map((e) => String(e.payload.task_id ?? "")));
  taskIds = taskIds.filter((tid) => !skipIds.has(tid));

  return taskIds;
}

type StartNextWaveInput = {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  nextWave: number;
  nextWaveTaskIds: string[];
  store: ReturnType<typeof getExecutionStore>;
  projectDir: string;
};

/**
 * Start the next wave: create worktrees, update state, return spawn requests.
 */
async function startNextWave(input: StartNextWaveInput): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, nextWave, nextWaveTaskIds, store, projectDir } = input;

  // Create worktrees for next wave tasks (subprocess-isolation via wave-lifecycle.ts)
  const waveTaskDefs = nextWaveTaskIds.map((tid) => ({ task_id: tid }));
  const worktreeResults = (await createWaveWorktrees(waveTaskDefs, projectDir)) ?? [];

  // Build a worktree lookup map
  const worktreeMap = new Map<string, string>(
    worktreeResults.map((r) => [r.task_id, r.worktree_path]),
  );

  // Update state with new wave tracking (sqlite-transactions)
  store.transaction(() => {
    const existing = store.getState(state_id);
    store.upsertState(state_id, {
      entries: (existing?.entries ?? 0) + 1,
      status: "in_progress",
      wave: nextWave,
      wave_results: {}, // reset for new wave
      wave_total: nextWaveTaskIds.length,
    });
  });

  // Get spawn prompts for the next wave state
  const enterOut = await enterAndPrepareState({
    flow,
    items: nextWaveTaskIds.map((tid) => ({ task_id: tid })),
    peer_count: nextWaveTaskIds.length,
    state_id,
    variables: {},
    wave: nextWave,
    workspace,
  });

  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;

  if (!enterOut.can_enter) {
    return {
      action: "hitl",
      breakpoint: {
        context: buildConvergenceContext(enterOut),
        reason: enterOut.convergence_reason
          ? `Convergence exhausted for state '${state_id}' wave ${nextWave}: ${enterOut.convergence_reason}`
          : `Max iterations reached for state '${state_id}' wave ${nextWave}`,
      },
      ok: true as const,
    };
  }

  // Build spawn requests and inject worktree paths
  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithWorktrees = requests.map((req) => {
    if (req.task_id && worktreeMap.has(req.task_id)) {
      return { ...req, worktree_path: worktreeMap.get(req.task_id) };
    }
    return req;
  });

  return {
    action: "spawn",
    ok: true as const,
    requests: requestsWithWorktrees,
  };
}

// Internal: enter state with skip-state loop

/**
 * Enter a state, handling the skip-state loop internally.
 * If the state has a skip_when condition that is satisfied, automatically
 * calls reportResult with "skipped" and loops to the next state.
 * Returns spawn requests for the first non-skipped state.
 *
 * For wave states: reads INDEX.md, creates worktrees, injects worktree_path
 * on each SpawnRequest, and persists wave metadata to execution_states.
 */
/** Handle a skipped state: report and return the next state ID or a terminal action. */
async function handleSkippedState(
  workspace: string,
  flow: DriveFlowInput["flow"],
  currentStateId: string,
): Promise<{ nextStateId: string } | ToolResult<DriveFlowAction>> {
  const reportOut = await reportResult({
    flow,
    state_id: currentStateId,
    status_keyword: "skipped",
    workspace,
  });
  if (!reportOut.ok) return reportOut as ToolResult<DriveFlowAction>;

  if (reportOut.hitl_required) {
    return {
      action: "hitl",
      breakpoint: { context: "", reason: reportOut.hitl_reason ?? "HITL required after skip" },
      ok: true as const,
    };
  }

  const nextState = reportOut.next_state;
  if (!nextState) {
    return {
      action: "done",
      ok: true as const,
      summary: buildDoneSummary(reportOut.board, currentStateId),
      terminal_state: currentStateId,
    };
  }
  if (flow.states[nextState]?.type === "terminal") {
    return {
      action: "done",
      ok: true as const,
      summary: buildDoneSummary(reportOut.board, nextState),
      terminal_state: nextState,
    };
  }

  return { nextStateId: nextState };
}

/** Build a terminal "done" action for a state. */
function buildTerminalAction(
  workspace: string,
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): ToolResult<DriveFlowAction> {
  const board = store.getBoard();
  if (!board)
    return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
  return {
    action: "done",
    ok: true as const,
    summary: buildDoneSummary(board, stateId),
    terminal_state: stateId,
  };
}

/** Build convergence-exhausted HITL action. */
function buildConvergenceHitl(
  currentStateId: string,
  enterOut: { iteration_count: number; max_iterations: number; convergence_reason?: string },
): ToolResult<DriveFlowAction> {
  return {
    action: "hitl",
    breakpoint: {
      context: buildConvergenceContext(enterOut),
      reason: enterOut.convergence_reason
        ? `Convergence exhausted for state '${currentStateId}': ${enterOut.convergence_reason}`
        : `Max iterations reached for state '${currentStateId}'`,
    },
    ok: true as const,
  };
}

/** Try to enter a single state. Returns a final action, or { nextStateId } to continue the skip loop. */
async function tryEnterSingleState(
  workspace: string,
  flow: DriveFlowInput["flow"],
  currentStateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<ToolResult<DriveFlowAction> | { nextStateId: string }> {
  const stateDef = flow.states[currentStateId];
  if (stateDef?.type === "terminal") return buildTerminalAction(workspace, currentStateId, store);
  if (stateDef?.type === "wave") return enterWaveState(workspace, flow, currentStateId, store);

  const enterOut = await enterAndPrepareState({
    flow,
    state_id: currentStateId,
    variables: {},
    workspace,
  });
  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;
  if (!enterOut.can_enter) return buildConvergenceHitl(currentStateId, enterOut);

  if (enterOut.skip_reason) return handleSkippedState(workspace, flow, currentStateId);

  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithSession = await applySessionContinuation(requests, currentStateId, store);
  return { action: "spawn", ok: true as const, requests: requestsWithSession };
}

async function enterStateAndBuildSpawn(
  workspace: string,
  flow: DriveFlowInput["flow"],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<ToolResult<DriveFlowAction>> {
  const MAX_SKIP_ITERATIONS = 50;
  let currentStateId = stateId;

  for (let i = 0; i < MAX_SKIP_ITERATIONS; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: state machine loop — each iteration depends on the previous state's result
    const result = await tryEnterSingleState(workspace, flow, currentStateId, store);
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

/**
 * Enter a wave state on first call (no result yet).
 *
 * Reads INDEX.md for the current wave number, creates worktrees for each task,
 * persists wave metadata (wave=1, wave_total=N), and returns spawn requests
 * with worktree_path pre-populated.
 */
/** Read wave task IDs from INDEX.md for the given wave number. */
async function readWaveTaskIds(
  workspace: string,
  slug: string | undefined,
  wave: number,
): Promise<string[]> {
  if (!slug) return [];
  const indexPath = join(workspace, "plans", slug, "INDEX.md");
  if (!existsSync(indexPath)) return [];
  const indexContent = await readFile(indexPath, "utf-8");
  return parseTaskIdsForWave(indexContent, wave);
}

/** Build a unified worktree map from newly-created and previously-persisted worktrees. */
function buildWorktreeMap(
  newResults: Array<{ task_id: string; worktree_path: string }>,
  existingWaveResults: Record<string, { worktree_path?: string; branch?: string }>,
): Map<string, string> {
  const map = new Map<string, string>(newResults.map((r) => [r.task_id, r.worktree_path]));
  for (const [tid, entry] of Object.entries(existingWaveResults)) {
    if (entry.worktree_path && !map.has(tid)) map.set(tid, entry.worktree_path);
  }
  return map;
}

async function enterWaveState(
  workspace: string,
  flow: DriveFlowInput["flow"],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<ToolResult<DriveFlowAction>> {
  const session = store.getSession();
  const projectDir = getProjectDir(workspace);
  const existingState = store.getState(stateId);
  const currentWave = existingState?.wave ?? 1;

  const waveTaskIds = await readWaveTaskIds(workspace, session?.slug, currentWave);
  if (waveTaskIds.length === 0) {
    return toolError(
      "INVALID_INPUT",
      `Wave state '${stateId}' has no tasks for wave ${currentWave}. INDEX.md is missing or contains no tasks for this wave. Ensure write_plan_index was called before entering the wave state.`,
    );
  }

  const existingWaveResults = (existingState?.wave_results ?? {}) as Record<
    string,
    { worktree_path?: string; branch?: string }
  >;
  const tasksNeedingWorktrees = waveTaskIds.filter(
    (tid) => !existingWaveResults[tid]?.worktree_path,
  );
  const worktreeResults =
    tasksNeedingWorktrees.length > 0
      ? await createWaveWorktrees(
          tasksNeedingWorktrees.map((tid) => ({ task_id: tid })),
          projectDir,
        )
      : [];

  const worktreeMap = buildWorktreeMap(worktreeResults, existingWaveResults);

  store.transaction(() => {
    store.upsertState(stateId, {
      entries: (existingState?.entries ?? 0) + 1,
      status: "in_progress",
      wave: currentWave,
      wave_results: existingState?.wave_results ?? {},
      wave_total: waveTaskIds.length,
    });
  });

  const enterOut = await enterAndPrepareState({
    flow,
    items: waveTaskIds.map((tid) => ({ task_id: tid })),
    peer_count: waveTaskIds.length,
    state_id: stateId,
    variables: {},
    wave: currentWave,
    workspace,
  });
  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;
  if (!enterOut.can_enter) return buildConvergenceHitl(stateId, enterOut);

  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithWorktrees = requests.map((req) =>
    req.task_id && worktreeMap.has(req.task_id)
      ? { ...req, worktree_path: worktreeMap.get(req.task_id) }
      : req,
  );

  return { action: "spawn", ok: true as const, requests: requestsWithWorktrees };
}

// SpawnRequest marshalling

/**
 * Convert SpawnPromptEntry[] and consultation prompts into SpawnRequest[].
 */
function buildSpawnRequests(
  prompts: SpawnPromptEntry[],
  consultationPrompts?: ConsultationPromptEntry[],
): SpawnRequest[] {
  const requests: SpawnRequest[] = prompts.map((entry) => ({
    agent_type: entry.agent,
    isolation: (entry.isolation ?? "worktree") as SpawnRequest["isolation"],
    prompt: entry.prompt,
    ...(entry.role !== undefined ? { role: entry.role } : {}),
    ...(entry.item !== undefined
      ? {
          task_id:
            typeof entry.item === "string"
              ? entry.item
              : ((entry.item as Record<string, unknown>).task_id as string | undefined),
        }
      : {}),
    ...(entry.worktree_path !== undefined ? { worktree_path: entry.worktree_path } : {}),
  }));

  if (consultationPrompts && consultationPrompts.length > 0) {
    for (const cp of consultationPrompts) {
      requests.push({
        agent_type: cp.agent,
        isolation: "none",
        prompt: cp.prompt,
        role: "consultation",
      });
    }
  }

  return requests;
}

// ADR-009a: Session continuation

/**
 * Apply continue_from to SpawnRequests when a fresh agent session exists.
 * Only adds continue_from when the session is < 10 minutes old.
 */
async function applySessionContinuation(
  requests: SpawnRequest[],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<SpawnRequest[]> {
  // Only apply continue_from for single-agent states (issue #20).
  // Parallel/wave states have multiple requests with different task IDs —
  // injecting continue_from into the first request could resume the wrong agent.
  if (requests.length !== 1) {
    return requests;
  }

  const session = store.getAgentSession(stateId);
  if (!session) {
    return requests;
  }

  const now = Date.now();
  const lastActivity = new Date(session.last_agent_activity).getTime();

  if (!Number.isFinite(lastActivity)) {
    // Invalid timestamp — treat session as stale
    return requests;
  }

  const idleMs = now - lastActivity;

  if (idleMs >= AGENT_SESSION_EVICTION_MS) {
    // Session is stale — don't include continue_from
    return requests;
  }

  // Fresh session — inject continue_from into the single spawn request
  return [
    {
      ...requests[0],
      continue_from: {
        agent_id: session.agent_session_id,
        context_summary: `Continuing agent session for state '${stateId}'`,
      },
    },
  ];
}

// Context builders for HITL and done summaries

function buildHitlContext(
  board: ReturnType<typeof getExecutionStore>["getBoard"] extends () => infer T
    ? NonNullable<T>
    : never,
  stateId: string,
  reportOut: {
    transition_condition: string;
    stuck: boolean;
    stuck_reason?: string;
    hitl_reason?: string;
  },
): string {
  const parts: string[] = [`State: ${stateId}`, `Condition: ${reportOut.transition_condition}`];
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

function buildConvergenceContext(enterOut: {
  iteration_count: number;
  max_iterations: number;
  convergence_reason?: string;
}): string {
  return [
    `Iterations: ${enterOut.iteration_count}/${enterOut.max_iterations}`,
    ...(enterOut.convergence_reason ? [`Reason: ${enterOut.convergence_reason}`] : []),
  ].join("\n");
}

function buildDoneSummary(
  board: ReturnType<typeof getExecutionStore>["getBoard"] extends () => infer T
    ? NonNullable<T>
    : never,
  terminalState: string,
): string {
  const stateCount = Object.keys(board.states ?? {}).length;
  const doneCount = Object.values(board.states ?? {}).filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
  return `Flow completed at state '${terminalState}'. States completed: ${doneCount}/${stateCount}.`;
}
