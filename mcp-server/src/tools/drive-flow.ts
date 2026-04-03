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
import type { WaveResult } from "../orchestration/flow-schema.ts";
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
    const { state_id, status, artifacts, parallel_results, metrics, agent_session_id, task_id, ...rest } = parseResult.data.result as DriveFlowInput["result"] & { task_id?: string };

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

  // Atomically append the task result to wave_results (sqlite-transactions)
  store.transaction(() => {
    const existing = store.getState(state_id);
    const waveResults: Record<string, WaveResult> = (existing?.wave_results as Record<string, WaveResult>) ?? {};
    waveResults[task_id] = {
      tasks: [task_id],
      status: task_status,
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
  const taskIds = Object.keys(waveResults);

  // Build WaveWorktreeResult array from task IDs (worktree paths follow the convention)
  const worktreeResults: WaveWorktreeResult[] = taskIds.map((tid) => ({
    task_id: tid,
    worktree_path: join(projectDir, ".canon", "worktrees", tid),
    branch: `canon-wave/${tid}`,
  }));

  // Merge worktrees
  const mergeResult = await mergeWaveResults(worktreeResults, projectDir, mergeStrategy);

  if (!mergeResult.ok) {
    // Merge conflict — handle per on_conflict policy (no-silent-failures)
    return handleMergeConflict({
      conflictTask: mergeResult.conflict_task,
      conflictDetail: mergeResult.conflict_detail,
      onConflict,
      workspace,
      flow,
      state_id,
      store,
    });
  }

  // Cleanup worktrees (best-effort — errors don't fail the flow)
  await cleanupWorktrees(worktreeResults, projectDir);

  // Run gates
  const gateResults = runGates(stateDef!, flow, projectDir, stateEntry ?? undefined);
  const gateFailed = gateResults.some((g) => !g.passed);

  // Determine the status keyword to report
  const statusKeyword = gateFailed ? "gate_failed" : "done";

  // Check for pending wave events between waves (before advancing)
  const pendingEvents = store.getWaveEvents({ status: "pending" });
  if (pendingEvents.length > 0) {
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
      // Mark the event as applied
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
  }

  // Check if there are more waves
  const slug = store.getSession()?.slug;
  const nextWave = currentWave + 1;
  let nextWaveTaskIds: string[] = [];

  if (slug) {
    const indexPath = join(workspace, "plans", slug, "INDEX.md");
    if (existsSync(indexPath)) {
      const indexContent = await readFile(indexPath, "utf-8");
      nextWaveTaskIds = parseTaskIdsForWave(indexContent, nextWave);

      // Filter out tasks marked for skip by skip_task events
      const allPendingNow = store.getWaveEvents({ status: "pending" });
      const skipIds = new Set(
        allPendingNow
          .filter((e) => e.type === "skip_task")
          .map((e) => String(e.payload["task_id"] ?? "")),
      );
      nextWaveTaskIds = nextWaveTaskIds.filter((tid) => !skipIds.has(tid));
    }
  }

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

    if (!reportOut.ok) return reportOut;

    const { next_state, hitl_required, hitl_reason, stuck_reason } = reportOut;

    if (hitl_required) {
      const board = store.getBoard()!;
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
      const board = store.getBoard()!;
      return {
        ok: true as const,
        action: "done",
        terminal_state: next_state ?? state_id,
        summary: buildDoneSummary(board, next_state ?? state_id),
      };
    }

    return enterStateAndBuildSpawn(workspace, flow, next_state, store);
  }

  // More waves — start next wave
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
  workspace: string;
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
  const { conflictTask, conflictDetail, onConflict, workspace, flow, state_id, store } = input;

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

  // retry-single: return a SpawnRequest for the conflicting task only
  const stateDef = flow.states[state_id];
  const spawnInstruction = flow.spawn_instructions[state_id] ?? "Retry task";

  return {
    ok: true as const,
    action: "spawn",
    requests: [
      {
        agent_type: stateDef?.agent ?? "canon:canon-implementor",
        prompt: `${spawnInstruction}\n\nNote: This is a retry for task '${conflictTask}' after a merge conflict. Conflict detail:\n${conflictDetail}`,
        isolation: "worktree",
        task_id: conflictTask,
      },
    ],
  };
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

  if (!enterOut.ok) return enterOut;

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
      return {
        ok: true as const,
        action: "done",
        terminal_state: currentStateId,
        summary: buildDoneSummary(store.getBoard()!, currentStateId),
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

  // Create worktrees for this wave's tasks (subprocess-isolation rule)
  const worktreeResults = await createWaveWorktrees(
    waveTaskIds.map((tid) => ({ task_id: tid })),
    projectDir,
  );

  const worktreeMap = new Map<string, string>(
    worktreeResults.map((r) => [r.task_id, r.worktree_path]),
  );

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

  if (!enterOut.ok) return enterOut;

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
