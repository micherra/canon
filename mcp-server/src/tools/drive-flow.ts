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
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import { toolError } from "../utils/tool-result.ts";
import type { DriveFlowAction, DriveFlowInput, SpawnRequest } from "../orchestration/drive-flow-types.ts";
import { DriveFlowInputSchema } from "../orchestration/drive-flow-types.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";
import { reportResult } from "./report-result.ts";
import type { SpawnPromptEntry } from "./get-spawn-prompt.ts";
import {
  createWaveWorktrees,
  mergeWaveResults,
  cleanupWorktrees,
  getProjectDir,
} from "../orchestration/wave-lifecycle.ts";
import type { WaveWorktreeResult } from "../orchestration/wave-lifecycle.ts";
import type { WaveResult, StateDefinition, Board } from "../orchestration/flow-schema.ts";
import { runGates } from "../orchestration/gate-runner.ts";
import { resolveAfterConsultations } from "./resolve-after-consultations.ts";
import { parseTaskIdsForWave } from "../orchestration/wave-variables.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Re-export types for external consumers
export type { DriveFlowAction, DriveFlowInput, SpawnRequest };

// ---------------------------------------------------------------------------
// Agent session eviction threshold (ADR-009a)
// ---------------------------------------------------------------------------

const AGENT_SESSION_EVICTION_MS = 600_000; // 10 minutes

// ---------------------------------------------------------------------------
// Approval gate helpers (ADR-017)
// ---------------------------------------------------------------------------

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
    const isArchitect = stateDef.agent === "canon-architect" || stateDef.agent === "canon:canon-architect";
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
  // Validate at trust boundary (validate-at-trust-boundaries)
  const parseResult = DriveFlowInputSchema.safeParse(input);
  if (!parseResult.success) {
    return toolError("INVALID_INPUT", parseResult.error.message);
  }

  const { workspace, flow } = parseResult.data;

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

  if (parseResult.data.result) {
    const { state_id, status, artifacts, parallel_results, metrics, agent_session_id, task_id } = parseResult.data.result;

    // Store agent session ID for ADR-009a continue_from support
    if (agent_session_id) {
      store.updateAgentSession(state_id, agent_session_id);
    }

    // ---------------------------------------------------------------------------
    // Wave state: accumulate task result, check if all done
    // ---------------------------------------------------------------------------
    const stateDef = flow.states[state_id];
    if (stateDef?.type === "wave" && task_id) {
      return handleWaveTaskResult({
        workspace,
        flow,
        state_id,
        task_id,
        task_status: status,
        task_artifacts: artifacts as string[] | undefined,
        store,
      });
    }

    // Guard: wave state results MUST include task_id
    if (stateDef?.type === "wave" && !task_id) {
      return toolError(
        "INVALID_INPUT",
        `Wave state '${state_id}' received a result without task_id. Wave results must include task_id to identify which task completed.`,
      );
    }

    // Report the result and evaluate transition (non-wave states)
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
      return reportOut as ToolResult<DriveFlowAction>;
    }

    // Re-read board after reportResult so HITL/done context reflects updated state
    const freshBoard = store.getBoard();
    if (!freshBoard) {
      return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
    }

    const { next_state, hitl_required, hitl_reason, stuck_reason } = reportOut;

    // HITL required (stuck, no transition, debate checkpoint, etc.)
    if (hitl_required) {
      return {
        ok: true as const,
        action: "hitl",
        breakpoint: {
          reason: hitl_reason ?? stuck_reason ?? "HITL required",
          context: buildHitlContext(freshBoard, state_id, reportOut),
        },
      };
    }

    // Parallel/parallel-per state: check if all roles are done.
    // When next_state loops back to the same state, it means we're waiting for
    // more parallel results. Return empty spawn to signal "waiting".
    // Note: for non-parallel states, same-state transitions (e.g. revise: design) must NOT be
    // short-circuited here — they are legitimate self-transitions that should proceed normally.
    const completedDef = flow.states[state_id];
    if (next_state === state_id && (completedDef?.type === "parallel" || completedDef?.type === "parallel-per")) {
      return {
        ok: true as const,
        action: "spawn",
        requests: [],
      };
    }

    // Approval gate check (ADR-017) — fires on the COMPLETED state, not the next state.
    // Placed AFTER the parallel-wait guard so it only fires when all roles are done.
    // Skip the gate when the orchestrator is re-submitting an approval decision — otherwise
    // the gate would fire again, creating an infinite loop.
    const normalizedStatus = String(status ?? "").trim().toLowerCase();
    const isApprovalDecision =
      normalizedStatus === "approved" ||
      normalizedStatus === "approve" ||
      normalizedStatus === "revise" ||
      normalizedStatus === "reject" ||
      normalizedStatus === "rejected";

    const completedStateDef = flow.states[state_id];
    if (!isApprovalDecision && shouldApprovalGate(completedStateDef, flow, freshBoard)) {
      return {
        ok: true as const,
        action: "approval" as const,
        breakpoint: {
          state_id,
          agent_type: completedStateDef?.agent ?? completedStateDef?.type ?? "unknown",
          artifacts: (artifacts as string[] | undefined) ?? [],
          summary: `State '${state_id}' completed with status '${status}'. Awaiting approval.`,
          options: ["approved", "revise", "reject"] as const,
        },
      };
    }

    // No next state (and not hitl_required) — terminal or unknown
    if (!next_state) {
      return {
        ok: true as const,
        action: "done",
        terminal_state: state_id,
        summary: buildDoneSummary(freshBoard, state_id),
      };
    }

    // Check if next state is terminal
    const nextStateDef = flow.states[next_state];
    if (nextStateDef?.type === "terminal") {
      return {
        ok: true as const,
        action: "done",
        terminal_state: next_state,
        summary: buildDoneSummary(freshBoard, next_state),
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
// Wave state handling
// ---------------------------------------------------------------------------

interface WaveTaskResultInput {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  task_id: string;
  task_status: string;
  task_artifacts?: string[];
  store: ReturnType<typeof getExecutionStore>;
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
  const { workspace, flow, state_id, task_id, task_status, task_artifacts, store } = input;

  // Derive convention-based worktree info for this task so it is persisted
  // alongside the result — completeWave can read it back without reconstructing.
  const projectDir = getProjectDir(workspace);
  const conventionWorktreePath = join(projectDir, ".canon", "worktrees", task_id);
  const conventionBranch = `canon-wave/${task_id}`;

  // Atomically append the task result to wave_results (sqlite-transactions)
  store.transaction(() => {
    const existing = store.getState(state_id);
    const waveResults: Record<string, WaveResult & { worktree_path?: string; branch?: string; artifacts?: string[] }> =
      (existing?.wave_results as Record<string, WaveResult & { worktree_path?: string; branch?: string; artifacts?: string[] }>) ?? {};
    // Prefer already-persisted worktree metadata; fall back to convention
    const existingEntry = waveResults[task_id];
    waveResults[task_id] = {
      tasks: [task_id],
      status: task_status,
      worktree_path: existingEntry?.worktree_path ?? conventionWorktreePath,
      branch: existingEntry?.branch ?? conventionBranch,
      // Persist artifacts if provided (issue #22: task_artifacts previously silently dropped)
      ...(task_artifacts && task_artifacts.length > 0 ? { artifacts: task_artifacts } : {}),
    };
    const currentEntries = existing?.entries ?? 0;
    store.upsertState(state_id, {
      status: "in_progress",
      entries: currentEntries,
      wave: existing?.wave ?? 1,
      wave_total: existing?.wave_total,
      wave_results: waveResults,
    });
  });

  // Re-read after transaction
  const stateEntry = store.getState(state_id);
  const waveResults: Record<string, WaveResult> = (stateEntry?.wave_results as Record<string, WaveResult>) ?? {};
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
      ok: true as const,
      action: "spawn",
      requests: [],
    };
  }

  // All tasks for this wave are done — proceed to merge + gate + events
  return completeWave({
    workspace,
    flow,
    state_id,
    currentWave,
    store,
  });
}

interface CompleteWaveInput {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  currentWave: number;
  store: ReturnType<typeof getExecutionStore>;
}

/**
 * Complete a wave: merge worktrees, run gates, handle events, advance.
 *
 * Called after all tasks in currentWave have submitted results.
 */
async function completeWave(
  input: CompleteWaveInput,
): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, currentWave, store } = input;

  const stateDef = flow.states[state_id];
  const wavePolicy = stateDef?.type === "wave" ? stateDef.wave_policy : undefined;
  const mergeStrategy = wavePolicy?.merge_strategy ?? "sequential";
  const onConflict = wavePolicy?.on_conflict ?? "hitl";
  const projectDir = getProjectDir(workspace);

  // Gather worktree results from board state metadata.
  // We reconstruct task IDs for this wave from the stored wave_results keys.
  const stateEntry = store.getState(state_id);
  const waveResults: Record<string, WaveResult> = (stateEntry?.wave_results as Record<string, WaveResult>) ?? {};
  const taskIds = Object.keys(waveResults).sort();

  // Build WaveWorktreeResult array from task IDs.
  // Prefer worktree metadata persisted during wave entry; fall back to convention.
  const worktreeResults: WaveWorktreeResult[] = taskIds.map((tid) => {
    const entry = waveResults[tid] as (WaveResult & { worktree_path?: string; branch?: string }) | undefined;
    return {
      task_id: tid,
      worktree_path: typeof entry?.worktree_path === "string" ? entry.worktree_path : join(projectDir, ".canon", "worktrees", tid),
      branch: typeof entry?.branch === "string" ? entry.branch : `canon-wave/${tid}`,
    };
  });

  // Merge worktrees
  const mergeResult = await mergeWaveResults(worktreeResults, projectDir, mergeStrategy);

  if (!mergeResult.ok) {
    type MergeFailure = { ok: false; merged_count: number; conflict_task: string; conflict_detail: string };
    const failMerge = mergeResult as MergeFailure;
    const conflictTask = failMerge.conflict_task.trim();

    if (conflictTask) {
      // Merge conflict — handle per on_conflict policy (no-silent-failures)
      return handleMergeConflict({
        conflictTask,
        conflictDetail: failMerge.conflict_detail,
        onConflict,
        flow,
        state_id,
        store,
      });
    }

    // Empty conflict_task means an unimplemented merge strategy was requested
    const detail = failMerge.conflict_detail.trim()
      ? ` Details: ${failMerge.conflict_detail.trim()}`
      : "";
    return toolError(
      "UNEXPECTED",
      `Wave merge failed for state '${state_id}' with strategy '${mergeStrategy}', but no conflicting task was reported. The merge strategy may be unsupported or not yet implemented.${detail}`,
    );
  }

  // Cleanup worktrees (best-effort — errors don't fail the flow)
  await cleanupWorktrees(worktreeResults, projectDir);

  // Guard: stateDef must exist (it was validated when entering the wave state)
  if (!stateDef) {
    return toolError("UNEXPECTED", `State definition not found for state '${state_id}' during wave completion`);
  }

  // Run gates
  const gateResults = runGates(stateDef, flow, projectDir, stateEntry ?? undefined);
  const gateFailed = gateResults.some((g) => !g.passed);

  // Determine the status keyword to report
  const statusKeyword = gateFailed ? "gate_failed" : "done";

  // Handle pending wave events between waves (before advancing)
  const eventResult = handlePendingWaveEvents(store, currentWave);
  if (eventResult !== null) return eventResult;

  // Resolve next-wave task IDs from INDEX.md (filtering applied skip_task events)
  const nextWave = currentWave + 1;
  const nextWaveTaskIds = await resolveNextWaveTaskIds(workspace, store, nextWave);

  const hasMoreWaves = nextWaveTaskIds.length > 0;

  if (!hasMoreWaves) {
    // Last wave — check for after-consultations
    const afterConsultationsResult = resolveAfterConsultations({
      workspace,
      state_id,
      flow,
      variables: {},
    });
    const afterConsultationPrompts = afterConsultationsResult?.consultation_prompts ?? [];

    if (afterConsultationPrompts.length > 0) {
      const consultRequests: SpawnRequest[] = afterConsultationPrompts.map((cp) => ({
        agent_type: cp.agent,
        prompt: cp.prompt,
        isolation: "none" as const,
        role: "consultation",
      }));
      return {
        ok: true as const,
        action: "spawn",
        requests: consultRequests,
      };
    }

    // Report the wave state result and advance
    const reportOut = await reportResult({
      workspace,
      state_id,
      status_keyword: statusKeyword,
      flow,
      gate_results: gateResults,
    });

    if (!reportOut.ok) return reportOut as ToolResult<DriveFlowAction>;

    const { next_state, hitl_required, hitl_reason, stuck_reason } = reportOut;

    if (hitl_required) {
      const board = store.getBoard();
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
      }
      return {
        ok: true as const,
        action: "hitl",
        breakpoint: {
          reason: hitl_reason ?? stuck_reason ?? "HITL required",
          context: buildHitlContext(board, state_id, reportOut),
        },
      };
    }

    if (!next_state || flow.states[next_state]?.type === "terminal") {
      const board = store.getBoard();
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
      }
      return {
        ok: true as const,
        action: "done",
        terminal_state: next_state ?? state_id,
        summary: buildDoneSummary(board, next_state ?? state_id),
      };
    }

    return enterStateAndBuildSpawn(workspace, flow, next_state, store);
  }

  // More waves — check for wave boundary approval gate before starting next wave
  const freshBoardForApproval = store.getBoard();
  if (freshBoardForApproval && shouldApprovalGateWaveBoundary(stateDef, flow, freshBoardForApproval)) {
    return {
      ok: true as const,
      action: "approval" as const,
      breakpoint: {
        state_id,
        agent_type: stateDef?.agent ?? "wave",
        artifacts: [],
        summary: `Wave ${currentWave} completed. ${nextWaveTaskIds.length} tasks in next wave. Awaiting approval to proceed.`,
        options: ["approved", "revise", "reject"] as const,
      },
    };
  }

  return startNextWave({
    workspace,
    flow,
    state_id,
    nextWave,
    nextWaveTaskIds,
    store,
    projectDir,
  });
}

interface HandleMergeConflictInput {
  conflictTask: string;
  conflictDetail: string;
  onConflict: "hitl" | "replan" | "retry-single";
  flow: DriveFlowInput["flow"];
  state_id: string;
  store: ReturnType<typeof getExecutionStore>;
}

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
      ok: true as const,
      action: "hitl",
      breakpoint: {
        reason: `Merge conflict in wave task '${conflictTask}'`,
        context: `Task: ${conflictTask}\nConflict detail: ${conflictDetail}`,
        options: ["Resolve conflict manually and retry", "Abandon the conflicting task", "Replan the wave"],
      },
    };
  }

  if (onConflict === "replan") {
    return {
      ok: true as const,
      action: "hitl",
      breakpoint: {
        reason: `replan: Merge conflict requires replanning — conflict in task '${conflictTask}'`,
        context: `Task: ${conflictTask}\nConflict detail: ${conflictDetail}\nSuggestion: Split or reorder conflicting tasks to avoid overlap.`,
        options: ["Replan affected tasks", "Abandon conflicting task and continue"],
      },
    };
  }

  // retry-single: return a SpawnRequest for the conflicting task only.
  // Look up the persisted worktree path from wave_results so the agent lands in
  // the correct worktree — the server owns the worktree lifecycle (dd-009-02).
  const stateDef = flow.states[state_id];
  const spawnInstruction = flow.spawn_instructions[state_id] ?? "Retry task";

  const stateEntry = store.getState(state_id);
  const waveResults = stateEntry?.wave_results as Record<string, { worktree_path?: string }> | undefined;
  const worktreePath = waveResults?.[conflictTask]?.worktree_path;

  return {
    ok: true as const,
    action: "spawn",
    requests: [
      {
        agent_type: stateDef?.agent ?? "canon:canon-implementor",
        prompt: `${spawnInstruction}\n\nNote: This is a retry for task '${conflictTask}' after a merge conflict. Conflict detail:\n${conflictDetail}`,
        isolation: "worktree",
        task_id: conflictTask,
        ...(worktreePath ? { worktree_path: worktreePath } : {}),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Wave event and next-wave helpers (extracted from completeWave for testability)
// ---------------------------------------------------------------------------

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
      ok: true as const,
      action: "hitl",
      breakpoint: {
        reason: `pause: wave execution paused — ${String(pauseEvent.payload["reason"] ?? "user requested pause")}`,
        context: `Wave ${currentWave} merged successfully. Pause event ID: ${pauseEvent.id}`,
      },
    };
  }

  // Handle skip_task events mechanically
  const skipTaskEvents = pendingEvents.filter((e) => e.type === "skip_task");
  for (const evt of skipTaskEvents) {
    try {
      store.updateWaveEvent(evt.id, {
        status: "applied",
        applied_at: new Date().toISOString(),
        resolution: { skipped_by: "drive_flow" },
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
  const skipIds = new Set(
    allSkipEvents.map((e) => String(e.payload["task_id"] ?? "")),
  );
  taskIds = taskIds.filter((tid) => !skipIds.has(tid));

  return taskIds;
}

interface StartNextWaveInput {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  nextWave: number;
  nextWaveTaskIds: string[];
  store: ReturnType<typeof getExecutionStore>;
  projectDir: string;
}

/**
 * Start the next wave: create worktrees, update state, return spawn requests.
 */
async function startNextWave(
  input: StartNextWaveInput,
): Promise<ToolResult<DriveFlowAction>> {
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
      status: "in_progress",
      entries: (existing?.entries ?? 0) + 1,
      wave: nextWave,
      wave_total: nextWaveTaskIds.length,
      wave_results: {}, // reset for new wave
    });
  });

  // Get spawn prompts for the next wave state
  const enterOut = await enterAndPrepareState({
    workspace,
    state_id,
    flow,
    variables: {},
    wave: nextWave,
    peer_count: nextWaveTaskIds.length,
  });

  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;

  if (!enterOut.can_enter) {
    return {
      ok: true as const,
      action: "hitl",
      breakpoint: {
        reason: enterOut.convergence_reason
          ? `Convergence exhausted for state '${state_id}' wave ${nextWave}: ${enterOut.convergence_reason}`
          : `Max iterations reached for state '${state_id}' wave ${nextWave}`,
        context: buildConvergenceContext(enterOut),
      },
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
    ok: true as const,
    action: "spawn",
    requests: requestsWithWorktrees,
  };
}

// ---------------------------------------------------------------------------
// Internal: enter state with skip-state loop
// ---------------------------------------------------------------------------

/**
 * Enter a state, handling the skip-state loop internally.
 * If the state has a skip_when condition that is satisfied, automatically
 * calls reportResult with "skipped" and loops to the next state.
 * Returns spawn requests for the first non-skipped state.
 *
 * For wave states: reads INDEX.md, creates worktrees, injects worktree_path
 * on each SpawnRequest, and persists wave metadata to execution_states.
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
      const board = store.getBoard();
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
      }
      return {
        ok: true as const,
        action: "done",
        terminal_state: currentStateId,
        summary: buildDoneSummary(board, currentStateId),
      };
    }

    // ---------------------------------------------------------------------------
    // Wave state entry: create worktrees, track wave, inject worktree_path
    // ---------------------------------------------------------------------------
    if (stateDef?.type === "wave") {
      return enterWaveState(workspace, flow, currentStateId, store);
    }

    const enterOut = await enterAndPrepareState({
      workspace,
      state_id: currentStateId,
      flow,
      variables: {},
    });

    if (!enterOut.ok) {
      return enterOut as ToolResult<DriveFlowAction>;
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
        return reportOut as ToolResult<DriveFlowAction>;
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
    const requestsWithSession = await applySessionContinuation(requests, currentStateId, store);

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

/**
 * Enter a wave state on first call (no result yet).
 *
 * Reads INDEX.md for the current wave number, creates worktrees for each task,
 * persists wave metadata (wave=1, wave_total=N), and returns spawn requests
 * with worktree_path pre-populated.
 */
async function enterWaveState(
  workspace: string,
  flow: DriveFlowInput["flow"],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<ToolResult<DriveFlowAction>> {
  const session = store.getSession();
  const slug = session?.slug;
  const projectDir = getProjectDir(workspace);

  // Determine current wave number (1 on first entry)
  const existingState = store.getState(stateId);
  const currentWave = existingState?.wave ?? 1;

  // Read INDEX.md to find tasks for this wave
  let waveTaskIds: string[] = [];
  if (slug) {
    const indexPath = join(workspace, "plans", slug, "INDEX.md");
    if (existsSync(indexPath)) {
      const indexContent = await readFile(indexPath, "utf-8");
      waveTaskIds = parseTaskIdsForWave(indexContent, currentWave);
    }
  }

  const waveTotal = waveTaskIds.length;

  // Guard: waveTotal=0 means INDEX.md is missing or has no tasks for this wave.
  // Proceeding with zero tasks would cause a deadlock — return a structured error (issue #10).
  if (waveTotal === 0) {
    return toolError(
      "INVALID_INPUT",
      `Wave state '${stateId}' has no tasks for wave ${currentWave}. INDEX.md is missing or contains no tasks for this wave. Ensure write_plan_index was called before entering the wave state.`,
    );
  }

  // Create worktrees for tasks that don't already have one persisted.
  // On restart/resume, some worktrees may already exist from a previous entry —
  // only create worktrees for tasks without an existing entry (dd-009-02, issue #14).
  const existingWaveResults = (existingState?.wave_results ?? {}) as Record<string, { worktree_path?: string; branch?: string }>;
  const tasksNeedingWorktrees = waveTaskIds.filter((tid) => !existingWaveResults[tid]?.worktree_path);
  const worktreeResults = tasksNeedingWorktrees.length > 0
    ? await createWaveWorktrees(tasksNeedingWorktrees.map((tid) => ({ task_id: tid })), projectDir)
    : [];

  // Build worktree map: newly-created worktrees + already-persisted worktrees from prior entry
  const worktreeMap = new Map<string, string>(
    worktreeResults.map((r) => [r.task_id, r.worktree_path]),
  );
  for (const [tid, entry] of Object.entries(existingWaveResults)) {
    if (entry.worktree_path && !worktreeMap.has(tid)) {
      worktreeMap.set(tid, entry.worktree_path);
    }
  }

  // Persist wave tracking metadata atomically (sqlite-transactions)
  store.transaction(() => {
    store.upsertState(stateId, {
      status: "in_progress",
      entries: (existingState?.entries ?? 0) + 1,
      wave: currentWave,
      wave_total: waveTotal,
      wave_results: existingState?.wave_results ?? {},
    });
  });

  // Get spawn prompts via enterAndPrepareState
  const enterOut = await enterAndPrepareState({
    workspace,
    state_id: stateId,
    flow,
    variables: {},
    wave: currentWave,
    peer_count: waveTotal,
  });

  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;

  if (!enterOut.can_enter) {
    return {
      ok: true as const,
      action: "hitl",
      breakpoint: {
        reason: enterOut.convergence_reason
          ? `Convergence exhausted for state '${stateId}' wave ${currentWave}: ${enterOut.convergence_reason}`
          : `Max iterations reached for state '${stateId}' wave ${currentWave}`,
        context: buildConvergenceContext(enterOut),
      },
    };
  }

  // Build spawn requests and populate worktree_path for each task
  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithWorktrees = requests.map((req) => {
    if (req.task_id && worktreeMap.has(req.task_id)) {
      return { ...req, worktree_path: worktreeMap.get(req.task_id) };
    }
    return req;
  });

  return {
    ok: true as const,
    action: "spawn",
    requests: requestsWithWorktrees,
  };
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
