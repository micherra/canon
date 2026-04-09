/** drive-flow-wave — Wave entry: task setup, worktree creation, and initial spawn. */

import { join } from "node:path";
import type { WaveResult } from "@domains/flows/board-state-schemas.ts";
import type { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { getProjectDir } from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import type { DriveFlowAction, DriveFlowInput } from "../services/drive-flow-types.ts";
import {
  attachWorktreeAndResumeContext,
  buildConvergenceHitl,
  buildSpawnRequests,
  buildWorktreeMap,
  createWorktreesForUnfinishedTasks,
  type ExistingWaveTaskEntry,
  getUnfinishedWaveTaskIds,
  injectSettingsIntoRequests,
  persistToolScopeWarnings,
  readWaveTaskIds,
} from "./drive-flow-helpers.ts";
import { completeWave } from "./drive-flow-wave-lifecycle.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";

export type WaveTaskResultInput = {
  workspace: string;
  flow: DriveFlowInput["flow"];
  state_id: string;
  task_id: string;
  task_status: string;
  task_artifacts?: string[];
  store: ReturnType<typeof getExecutionStore>;
  /** Actual branch used by the agent's worktree (e.g. "worktree-agent-*"). */
  worktree_branch?: string;
};

/** Persist a wave task result into the store atomically. */
export function persistWaveTaskResult(
  store: ReturnType<typeof getExecutionStore>,
  input: WaveTaskResultInput,
  conventionWorktreePath: string,
  conventionBranch: string,
): void {
  const { state_id, task_id, task_status, task_artifacts } = input;
  store.transaction(() => {
    const existing = store.getState(state_id);
    type WR = WaveResult & { worktree_path?: string; branch?: string; artifacts?: string[] };
    const waveResults = (existing?.wave_results ?? {}) as Record<string, WR>;
    const existingEntry = waveResults[task_id];
    waveResults[task_id] = {
      branch: conventionBranch,
      status: task_status,
      tasks: [task_id],
      worktree_path: existingEntry?.worktree_path ?? conventionWorktreePath,
      ...(task_artifacts && task_artifacts.length > 0 ? { artifacts: task_artifacts } : {}),
    };
    store.upsertState(state_id, {
      entries: existing?.entries ?? 0,
      status: "in_progress",
      wave: existing?.wave ?? 1,
      wave_results: waveResults,
      wave_total: existing?.wave_total,
    });
  });
}

/** Handle a wave task result: persist, check completion, merge if all done. */
export async function handleWaveTaskResult(
  input: WaveTaskResultInput,
): Promise<ToolResult<DriveFlowAction>> {
  const { workspace, flow, state_id, task_id, store } = input;
  const projectDir = getProjectDir(workspace);
  persistWaveTaskResult(
    store,
    input,
    join(projectDir, ".canon", "worktrees", task_id),
    `canon-wave/${task_id}`,
  );
  const stateEntry = store.getState(state_id);
  const waveResults = (stateEntry?.wave_results as Record<string, WaveResult>) ?? {};
  const waveTotal = stateEntry?.wave_total ?? 0;
  const currentWave = stateEntry?.wave ?? 1;
  if (!waveTotal || waveTotal <= 0) {
    return toolError(
      "UNEXPECTED",
      `Wave state '${state_id}' has invalid wave_total (${waveTotal}). Wave total must be set to a positive integer when entering the wave state.`,
    );
  }
  if (Object.keys(waveResults).length < waveTotal) {
    return { action: "spawn", ok: true as const, requests: [] };
  }
  return completeWave({ currentWave, flow, state_id, store, workspace });
}

/**
 * Enter a wave state on first call.
 * Reads INDEX.md for the current wave number, creates worktrees, persists metadata,
 * and returns spawn requests with worktree_path pre-populated.
 */
export async function enterWaveState(
  workspace: string,
  flow: DriveFlowInput["flow"],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<ToolResult<DriveFlowAction>> {
  const session = store.getSession();
  const projectDir = getProjectDir(workspace);
  const mergeCwd = store.getExecution()?.worktree_path ?? projectDir;
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
    ExistingWaveTaskEntry
  >;
  const unfinishedTaskIds = getUnfinishedWaveTaskIds(waveTaskIds, existingWaveResults);
  if (unfinishedTaskIds.length === 0) {
    return { action: "spawn", ok: true as const, requests: [] };
  }
  const worktreeResults = await createWorktreesForUnfinishedTasks(
    unfinishedTaskIds,
    existingWaveResults,
    projectDir,
    mergeCwd,
  );
  const worktreeMap = buildWorktreeMap(worktreeResults, existingWaveResults);
  const enterOut = await enterAndPrepareState({
    flow,
    items: unfinishedTaskIds.map((tid) => ({ task_id: tid })),
    peer_count: unfinishedTaskIds.length,
    state_id: stateId,
    variables: {},
    wave: currentWave,
    workspace,
  });
  if (!enterOut.ok) return enterOut as ToolResult<DriveFlowAction>;
  if (!enterOut.can_enter) return buildConvergenceHitl(stateId, enterOut);
  store.transaction(() => {
    store.upsertState(stateId, {
      entries: (existingState?.entries ?? 0) + 1,
      status: "in_progress",
      wave: currentWave,
      wave_results: existingState?.wave_results ?? {},
      wave_total: waveTaskIds.length,
    });
  });
  persistToolScopeWarnings(enterOut.prompts, stateId, store);
  const requests = buildSpawnRequests(enterOut.prompts, enterOut.consultation_prompts);
  const requestsWithResume = attachWorktreeAndResumeContext(
    requests,
    worktreeMap,
    existingWaveResults,
  );
  await injectSettingsIntoRequests(requestsWithResume);
  return { action: "spawn", ok: true as const, requests: requestsWithResume };
}
