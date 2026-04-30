/** drive-flow-wave-lifecycle — Wave completion, merge, routing, and advancement. */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WaveResult } from "@domains/flows/board-state-schemas.ts";
import type { StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { runGates } from "@domains/flows/gate-runner.ts";
import type { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { WaveWorktreeResult } from "@domains/workspaces/wave-lifecycle.ts";
import {
  cleanupWorktrees,
  createWaveWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "@domains/workspaces/wave-lifecycle.ts";
import { parseTaskIdsForWave } from "@domains/workspaces/wave-variables.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import type { DriveFlowAction, DriveFlowInput } from "../services/drive-flow-types.ts";
// Deliberate circular import: values are resolved at runtime (after module init), not at load time.
import {
  applyFlowEventDrain,
  resolveNextStateAction,
  shouldApprovalGateWaveBoundary,
} from "./drive-flow.ts";
import {
  buildConvergenceContext,
  buildHitlContext,
  buildSpawnRequests,
  injectSettingsIntoRequests,
  persistToolScopeWarnings,
} from "./drive-flow-helpers.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import { reportResult } from "./report-result.ts";
import { resolveAfterConsultations } from "./resolve-after-consultations.ts";

/** Build WaveWorktreeResult array from stored wave results. */
export function buildWorktreeResults(
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

/** Handle pending wave events between waves. `pause` → HITL. `skip_task` → apply + null. */
export function handlePendingWaveEvents(
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
  for (const evt of pendingEvents.filter((e) => e.type === "skip_task")) {
    try {
      store.updateWaveEvent(evt.id, {
        applied_at: new Date().toISOString(),
        resolution: { skipped_by: "drive_flow" },
        status: "applied",
      });
    } catch (err) {
      console.warn("[canon] wave event update failed:", err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/** Resolve task IDs for the next wave, filtering out skip_task event targets. */
export async function resolveNextWaveTaskIds(
  workspace: string,
  store: ReturnType<typeof getExecutionStore>,
  nextWave: number,
): Promise<string[]> {
  const slug = store.getSession()?.slug;
  if (!slug) return [];
  const indexPath = join(workspace, "plans", slug, "INDEX.md");
  if (!existsSync(indexPath)) return [];
  const indexContent = await readFile(indexPath, "utf-8");
  const taskIds = parseTaskIdsForWave(indexContent, nextWave);
  const skipIds = new Set(
    store
      .getWaveEvents({})
      .filter((e) => e.type === "skip_task")
      .map((e) => String(e.payload.task_id ?? "")),
  );
  return taskIds.filter((tid) => !skipIds.has(tid));
}

/** Handle a merge conflict per the WavePolicy.on_conflict strategy. */
export async function handleMergeConflict(input: {
  conflictTask: string;
  conflictDetail: string;
  onConflict: "hitl" | "replan" | "retry-single";
  flow: DriveFlowInput["flow"];
  state_id: string;
  store: ReturnType<typeof getExecutionStore>;
}): Promise<ToolResult<DriveFlowAction>> {
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
  // retry-single: spawn the conflicting task only
  const stateDef = flow.states[state_id];
  const spawnInstruction = flow.spawn_instructions[state_id] ?? "Retry task";
  const waveResults = store.getState(state_id)?.wave_results as
    | Record<string, { worktree_path?: string }>
    | undefined;
  const worktreePath = waveResults?.[conflictTask]?.worktree_path;
  return {
    action: "spawn",
    ok: true as const,
    requests: [
      {
        agent_type: stateDef?.agent ?? "canon:implementor",
        isolation: worktreePath ? "none" : "worktree",
        prompt: `${spawnInstruction}\n\nNote: This is a retry for task '${conflictTask}' after a merge conflict. Conflict detail:\n${conflictDetail}`,
        task_id: conflictTask,
        ...(worktreePath ? { worktree_path: worktreePath } : {}),
      },
    ],
  };
}

/** Handle a merge failure — route to conflict handler or return unexpected error. */
export async function handleMergeFailure(
  mergeResult: { ok: false; conflict_task: string; conflict_detail: string },
  opts: {
    onConflict: "hitl" | "replan" | "retry-single";
    flow: DriveFlowInput["flow"];
    state_id: string;
    mergeStrategy: string;
    store: ReturnType<typeof getExecutionStore>;
  },
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

/** Route a report result to HITL, done, or next-state spawn. */
export async function routeReportResult(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: {
    state_id: string;
    reportOut: Awaited<ReturnType<typeof reportResult>> & { ok: true };
    store: ReturnType<typeof getExecutionStore>;
    projectDir: string;
  },
): Promise<ToolResult<DriveFlowAction>> {
  const { state_id, reportOut, store, projectDir } = opts;
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
  const drainAction = await applyFlowEventDrain({
    currentStateId: state_id,
    flow,
    projectDir,
    resumeStateId: next_state ?? null,
    store,
    workspace,
  });
  if (drainAction !== null) return drainAction;
  const returnAddress = store.getState(state_id)?.inserted_return_to;
  const effectiveNextState =
    returnAddress && reportOut.transition_condition === "done" ? returnAddress : next_state;
  return resolveNextStateAction(workspace, flow, {
    board: store.getBoard()!,
    current_state: state_id,
    next_state: effectiveNextState,
    projectDir,
    store,
  });
}

/** Handle the last wave: after-consultations, report result, and advance. */
export async function handleLastWave(
  workspace: string,
  flow: DriveFlowInput["flow"],
  opts: {
    state_id: string;
    statusKeyword: string;
    gateResults: ReturnType<typeof runGates>;
    store: ReturnType<typeof getExecutionStore>;
    projectDir: string;
  },
): Promise<ToolResult<DriveFlowAction>> {
  const { state_id, statusKeyword, gateResults, store, projectDir } = opts;
  const afterConsultationPrompts =
    resolveAfterConsultations({ flow, state_id, variables: {}, workspace })?.consultation_prompts ??
    [];
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
  return routeReportResult(workspace, flow, { projectDir, reportOut, state_id, store });
}

/** Check wave boundary approval gate and return approval action if needed. */
export function checkWaveBoundaryApproval(
  stateDef: StateDefinition | undefined,
  flow: DriveFlowInput["flow"],
  opts: {
    state_id: string;
    currentWave: number;
    nextWaveTaskIds: string[];
    store: ReturnType<typeof getExecutionStore>;
  },
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

export async function advanceWave(input: {
  currentWave: number;
  flow: DriveFlowInput["flow"];
  gateResults: ReturnType<typeof runGates>;
  projectDir: string;
  state_id: string;
  stateDef: StateDefinition;
  store: ReturnType<typeof getExecutionStore>;
  workspace: string;
}): Promise<ToolResult<DriveFlowAction>> {
  const { currentWave, flow, gateResults, projectDir, state_id, stateDef, store, workspace } =
    input;
  const statusKeyword = gateResults.some((g) => !g.passed) ? "gate_failed" : "done";
  const eventResult = handlePendingWaveEvents(store, currentWave);
  if (eventResult !== null) return eventResult;
  const drainActionWave = await applyFlowEventDrain({
    currentStateId: state_id,
    flow,
    projectDir,
    resumeStateId: null,
    store,
    workspace,
  });
  if (drainActionWave !== null) return drainActionWave;
  const nextWave = currentWave + 1;
  const nextWaveTaskIds = await resolveNextWaveTaskIds(workspace, store, nextWave);
  if (nextWaveTaskIds.length === 0) {
    return handleLastWave(workspace, flow, {
      gateResults,
      projectDir,
      state_id,
      statusKeyword,
      store,
    });
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

/** Complete a wave: merge worktrees, run gates, handle events, advance. */
export async function completeWave(input: {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  currentWave: number;
  store: ReturnType<typeof getExecutionStore>;
}): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, currentWave, store } = input;
  const stateDef = flow.states[state_id];
  const wavePolicy = stateDef?.type === "wave" ? stateDef.wave_policy : undefined;
  const mergeStrategy = wavePolicy?.merge_strategy ?? "sequential";
  const onConflict = wavePolicy?.on_conflict ?? "hitl";
  const projectDir = getProjectDir(workspace);
  const mergeCwd = store.getExecution()?.worktree_path ?? projectDir;
  const stateEntry = store.getState(state_id);
  const waveResults = (stateEntry?.wave_results as Record<string, WaveResult>) ?? {};
  const worktreeResults = buildWorktreeResults(waveResults, projectDir);
  const mergeResult = await mergeWaveResults(worktreeResults, mergeCwd, mergeStrategy);
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
  const gateResults = runGates(stateDef, flow, mergeCwd, stateEntry ?? undefined);
  return advanceWave({
    currentWave,
    flow,
    gateResults,
    projectDir,
    state_id,
    stateDef,
    store,
    workspace,
  });
}

/** Start the next wave: create worktrees, update state, return spawn requests. */
export async function startNextWave(input: {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  nextWave: number;
  nextWaveTaskIds: string[];
  store: ReturnType<typeof getExecutionStore>;
  projectDir: string;
}): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, nextWave, nextWaveTaskIds, store, projectDir } = input;
  const mergeCwd = store.getExecution()?.worktree_path ?? projectDir;
  const worktreeResults =
    (await createWaveWorktrees(
      nextWaveTaskIds.map((tid) => ({ task_id: tid })),
      projectDir,
      mergeCwd,
    )) ?? [];
  const worktreeMap = new Map<string, string>(
    worktreeResults.map((r) => [r.task_id, r.worktree_path]),
  );
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
  store.transaction(() => {
    const existing = store.getState(state_id);
    store.upsertState(state_id, {
      entries: (existing?.entries ?? 0) + 1,
      status: "in_progress",
      wave: nextWave,
      wave_results: {},
      wave_total: nextWaveTaskIds.length,
    });
  });
  persistToolScopeWarnings(enterOut.prompts, state_id, store);
  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithWorktrees = requests.map((req) =>
    req.task_id && worktreeMap.has(req.task_id)
      ? { ...req, isolation: "none" as const, worktree_path: worktreeMap.get(req.task_id) }
      : req,
  );
  await injectSettingsIntoRequests(requestsWithWorktrees);
  return { action: "spawn", ok: true as const, requests: requestsWithWorktrees };
}
