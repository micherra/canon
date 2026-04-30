/**
 * drive-flow-helpers — Spawn marshalling, session management, and context builders.
 *
 * Contains helper functions for building spawn requests, applying session continuation,
 * persisting tool scope warnings, and building HITL/done context strings.
 * Also contains gate helpers and skipped/terminal state handlers.
 *
 * Extracted from drive-flow.ts to keep the main module under 600 lines.
 * No imports from sibling drive-flow-*.ts files — zero circular dependencies.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { type GateResult, runGates } from "@domains/flows/gate-runner.ts";
import type { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { createWaveWorktrees } from "@domains/workspaces/wave-lifecycle.ts";
import { parseTaskIdsForWave } from "@domains/workspaces/wave-variables.ts";
import { evaluateLearnGate } from "@features/orchestration/services/learn-gate.ts";
import { resolveToolProfile } from "@features/prompt-pipeline/model/tool-profiles.ts";
import { injectWorktreeSettings } from "@features/prompt-pipeline/services/worktree-settings.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import type { DriveFlowInput, SpawnRequest } from "../services/drive-flow-types.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";
import type { SpawnPromptEntry } from "./get-spawn-prompt.ts";
import { reportResult } from "./report-result.ts";

// Re-export for external consumers
export type { SpawnRequest };

// DriveCtx type (shared context for internal drive-flow state-entry helpers)

export type DriveCtx = {
  workspace: string;
  flow: DriveFlowInput["flow"];
  store: ReturnType<typeof getExecutionStore>;
  projectDir: string;
};

// Wave task ID helpers

/** Read wave task IDs from INDEX.md for the given wave number. */
export async function readWaveTaskIds(
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
export function buildWorktreeMap(
  newResults: Array<{ task_id: string; worktree_path: string }>,
  existingWaveResults: Record<string, { worktree_path?: string; branch?: string }>,
): Map<string, string> {
  const map = new Map<string, string>(newResults.map((r) => [r.task_id, r.worktree_path]));
  for (const [tid, entry] of Object.entries(existingWaveResults)) {
    if (entry.worktree_path && !map.has(tid)) map.set(tid, entry.worktree_path);
  }
  return map;
}

// Non-respawnable wave task status helpers

const NON_RESPAWNABLE_WAVE_TASK_STATUSES = ["done", "skipped"] as const;
type NonRespawnableWaveTaskStatus = (typeof NON_RESPAWNABLE_WAVE_TASK_STATUSES)[number];
const NON_RESPAWNABLE_WAVE_TASK_STATUS_SET = new Set<string>(NON_RESPAWNABLE_WAVE_TASK_STATUSES);

function isNonRespawnableWaveTaskStatus(status: unknown): status is NonRespawnableWaveTaskStatus {
  return typeof status === "string" && NON_RESPAWNABLE_WAVE_TASK_STATUS_SET.has(status);
}

export type ExistingWaveTaskEntry = { status?: string; worktree_path?: string; branch?: string };

function hasExistingWaveTaskProgress(entry: ExistingWaveTaskEntry): boolean {
  return !!entry.worktree_path || !!entry.branch || typeof entry.status === "string";
}

function withResumeContextPrompt(prompt: string): string {
  return `${prompt}\n\n## Resume Context\nExisting progress detected for this unfinished task. Inspect recent commits in this worktree and continue from prior work; do not restart from scratch.\n`;
}

export function getUnfinishedWaveTaskIds(
  waveTaskIds: string[],
  existingWaveResults: Record<string, ExistingWaveTaskEntry>,
): string[] {
  return waveTaskIds.filter(
    (tid) => !isNonRespawnableWaveTaskStatus(existingWaveResults[tid]?.status),
  );
}

export async function createWorktreesForUnfinishedTasks(
  unfinishedTaskIds: string[],
  existingWaveResults: Record<string, ExistingWaveTaskEntry>,
  projectDir: string,
  mergeCwd: string,
): Promise<Array<{ task_id: string; worktree_path: string }>> {
  const tasksNeedingWorktrees = unfinishedTaskIds.filter(
    (tid) => !existingWaveResults[tid]?.worktree_path,
  );
  return tasksNeedingWorktrees.length > 0
    ? await createWaveWorktrees(
        tasksNeedingWorktrees.map((tid) => ({ task_id: tid })),
        projectDir,
        mergeCwd,
      )
    : [];
}

export function attachWorktreeAndResumeContext(
  requests: SpawnRequest[],
  worktreeMap: Map<string, string>,
  existingWaveResults: Record<string, ExistingWaveTaskEntry>,
): SpawnRequest[] {
  return requests.map((req) => {
    const worktreePath = req.task_id ? worktreeMap.get(req.task_id) : undefined;
    // worktree_path presence → isolation: "none" (Canon owns the worktree; no Agent tool worktree)
    const withWorktree = worktreePath
      ? { ...req, isolation: "none" as const, worktree_path: worktreePath }
      : req;
    if (!withWorktree.task_id) return withWorktree;
    const existing = existingWaveResults[withWorktree.task_id];
    if (!existing || !hasExistingWaveTaskProgress(existing)) return withWorktree;
    return { ...withWorktree, prompt: withResumeContextPrompt(withWorktree.prompt) };
  });
}

// SpawnRequest marshalling

/** Convert SpawnPromptEntry[] and consultation prompts into SpawnRequest[]. */
function entryToSpawnRequest(entry: SpawnPromptEntry): SpawnRequest {
  // Wave entries have worktree_path (Canon-managed worktree, isolation: "none").
  // Non-wave entries get isolation: "worktree" (Agent tool creates its own worktree).
  const isolation: SpawnRequest["isolation"] = entry.worktree_path ? "none" : "worktree";
  const req: SpawnRequest = {
    agent_type: entry.agent,
    isolation,
    prompt: entry.prompt,
  };
  if (entry.role !== undefined) req.role = entry.role;
  if (entry.item !== undefined) {
    req.task_id =
      typeof entry.item === "string"
        ? entry.item
        : ((entry.item as Record<string, unknown>).task_id as string | undefined);
  }
  if (entry.worktree_path !== undefined) req.worktree_path = entry.worktree_path;
  if (entry.tools !== undefined) req.tools = entry.tools;
  if (entry.disallowed_tools !== undefined) req.disallowed_tools = entry.disallowed_tools;
  // Permission mode safety net: all drive_flow-spawned agents run in worktrees
  // (either Canon-managed or Agent-tool-managed), so auto mode is always safe.
  // Explicit permission_mode from the profile takes precedence; otherwise default to "auto".
  req.permission_mode = entry.permission_mode ?? "auto";
  return req;
}

export function buildSpawnRequests(
  prompts: SpawnPromptEntry[],
  consultationPrompts?: ConsultationPromptEntry[],
): SpawnRequest[] {
  const requests: SpawnRequest[] = prompts.map(entryToSpawnRequest);

  if (consultationPrompts && consultationPrompts.length > 0) {
    for (const cp of consultationPrompts) {
      const profile = resolveToolProfile(cp.agent);
      const req: SpawnRequest = {
        agent_type: cp.agent,
        isolation: "none",
        prompt: cp.prompt,
        role: "consultation",
      };
      if (profile.tools.length > 0) req.tools = profile.tools;
      if (profile.disallowed_tools.length > 0) req.disallowed_tools = profile.disallowed_tools;
      req.permission_mode = profile.permission_mode;
      requests.push(req);
    }
  }

  return requests;
}

// Settings injection

/**
 * Inject worktree settings into spawn requests that have a worktree_path and auto permission_mode.
 * Sequential (not Promise.all) for error isolation — one failure must not abort others.
 * fail-closed-by-default: injection failure returns false but never blocks the spawn.
 */
export async function injectSettingsIntoRequests(requests: SpawnRequest[]): Promise<void> {
  for (const req of requests) {
    if (req.worktree_path && req.permission_mode === "auto" && req.tools) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential injection for error isolation — one failure must not abort others
      await injectWorktreeSettings(req.worktree_path, req.tools);
    }
  }
}

// Tool scope warnings

/**
 * Persist tool_scope_audit warnings from prompt entries to the SQLite event log.
 * resolveToolProfile returns warnings on ResolvedProfile; this drains them into the event log.
 */
export function persistToolScopeWarnings(
  prompts: SpawnPromptEntry[],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): void {
  for (const entry of prompts) {
    if (!entry.tool_scope_warnings) continue;
    for (const warning of entry.tool_scope_warnings) {
      store.appendEvent("tool_scope_audit", {
        agent: warning.agent,
        event: warning.event,
        granted_disallowed: warning.granted_disallowed,
        stateId,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// ADR-009a: Session continuation

/** Agent session eviction threshold (ADR-009a) */
const AGENT_SESSION_EVICTION_MS = 600_000; // 10 minutes

/**
 * Apply continue_from to SpawnRequests when a fresh agent session exists.
 * Only adds continue_from when the session is < 10 minutes old.
 */
export async function applySessionContinuation(
  requests: SpawnRequest[],
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
): Promise<SpawnRequest[]> {
  // Only apply continue_from for single-agent states (issue #20).
  // Parallel/wave states have multiple requests with different task IDs —
  // injecting continue_from into the first request could resume the wrong agent.
  if (requests.length !== 1) return requests;

  const session = store.getAgentSession(stateId);
  if (!session) return requests;

  const now = Date.now();
  const lastActivity = new Date(session.last_agent_activity).getTime();

  if (!Number.isFinite(lastActivity)) return requests; // Invalid timestamp — treat as stale

  const idleMs = now - lastActivity;
  if (idleMs >= AGENT_SESSION_EVICTION_MS) return requests; // Session is stale

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

export function buildHitlContext(
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
  if (reportOut.stuck) parts.push(`Stuck: ${reportOut.stuck_reason ?? "yes"}`);
  if (reportOut.hitl_reason) parts.push(`Reason: ${reportOut.hitl_reason}`);
  const iter = board.iterations?.[stateId];
  if (iter) parts.push(`Iteration: ${iter.count}/${iter.max}`);
  return parts.join("\n");
}

export function buildConvergenceContext(enterOut: {
  iteration_count: number;
  max_iterations: number;
  convergence_reason?: string;
}): string {
  return [
    `Iterations: ${enterOut.iteration_count}/${enterOut.max_iterations}`,
    ...(enterOut.convergence_reason ? [`Reason: ${enterOut.convergence_reason}`] : []),
  ].join("\n");
}

/** Build convergence-exhausted HITL action. Returns a ToolResult-compatible object. */
export function buildConvergenceHitl(
  currentStateId: string,
  enterOut: { iteration_count: number; max_iterations: number; convergence_reason?: string },
): { action: "hitl"; breakpoint: { context: string; reason: string }; ok: true } {
  return {
    action: "hitl" as const,
    breakpoint: {
      context: buildConvergenceContext(enterOut),
      reason: enterOut.convergence_reason
        ? `Convergence exhausted for state '${currentStateId}': ${enterOut.convergence_reason}`
        : `Max iterations reached for state '${currentStateId}'`,
    },
    ok: true as const,
  };
}

export async function buildDoneSummary(
  board: ReturnType<typeof getExecutionStore>["getBoard"] extends () => infer T
    ? NonNullable<T>
    : never,
  terminalState: string,
  projectDir: string,
): Promise<{
  summary: string;
  state_artifacts?: Record<string, string[]>;
  learn_gate_passed?: boolean;
}> {
  const stateEntries = Object.entries(board.states ?? {});
  const stateCount = stateEntries.length;
  const doneCount = stateEntries.filter(
    ([, s]) => s.status === "done" || s.status === "skipped",
  ).length;

  // Collect per-state artifact paths — only states with at least one artifact appear
  const state_artifacts: Record<string, string[]> = {};
  for (const [stateId, s] of stateEntries) {
    if (s.artifacts && s.artifacts.length > 0) state_artifacts[stateId] = s.artifacts;
  }

  const result: {
    summary: string;
    state_artifacts?: Record<string, string[]>;
    learn_gate_passed?: boolean;
  } = {
    summary: `Flow completed at state '${terminalState}'. States completed: ${doneCount}/${stateCount}.`,
  };
  if (Object.keys(state_artifacts).length > 0) result.state_artifacts = state_artifacts;

  // ADR-016: Evaluate learn gate — best-effort, must never block flow completion
  let learn_gate_passed: boolean | undefined;
  try {
    const gateResult = await evaluateLearnGate(projectDir);
    if (gateResult.passed) learn_gate_passed = true;
  } catch (err) {
    console.warn("[canon] learn gate evaluation failed:", err instanceof Error ? err.message : err);
  }
  if (learn_gate_passed !== undefined) result.learn_gate_passed = learn_gate_passed;

  return result;
}

// Skipped and terminal state handlers

/** Handle a skipped state: report and return the next state ID or a terminal action. */
export async function handleSkippedState(
  workspace: string,
  flow: DriveFlowInput["flow"],
  currentStateId: string,
  projectDir: string,
): Promise<
  | { nextStateId: string }
  | { action: "hitl"; breakpoint: { context: string; reason: string }; ok: true }
  | {
      action: "done";
      ok: true;
      terminal_state: string;
      summary: string;
      state_artifacts?: Record<string, string[]>;
      learn_gate_passed?: boolean;
    }
  | ToolResult<never>
> {
  const reportOut = await reportResult({
    flow,
    state_id: currentStateId,
    status_keyword: "skipped",
    workspace,
  });
  if (!reportOut.ok) return reportOut as ToolResult<never>;

  if (reportOut.hitl_required) {
    return {
      action: "hitl" as const,
      breakpoint: { context: "", reason: reportOut.hitl_reason ?? "HITL required after skip" },
      ok: true as const,
    };
  }

  const nextState = reportOut.next_state;
  if (!nextState) {
    const doneSummary = await buildDoneSummary(reportOut.board, currentStateId, projectDir);
    return {
      action: "done" as const,
      ok: true as const,
      terminal_state: currentStateId,
      ...doneSummary,
    };
  }
  if (flow.states[nextState]?.type === "terminal") {
    const doneSummary = await buildDoneSummary(reportOut.board, nextState, projectDir);
    return {
      action: "done" as const,
      ok: true as const,
      terminal_state: nextState,
      ...doneSummary,
    };
  }

  return { nextStateId: nextState };
}

/** Build a terminal "done" action for a state. */
export async function buildTerminalAction(
  workspace: string,
  stateId: string,
  store: ReturnType<typeof getExecutionStore>,
  projectDir: string,
): Promise<
  | {
      action: "done";
      ok: true;
      terminal_state: string;
      summary: string;
      state_artifacts?: Record<string, string[]>;
      learn_gate_passed?: boolean;
    }
  | ToolResult<never>
> {
  const board = store.getBoard();
  if (!board)
    return toolError("WORKSPACE_NOT_FOUND", `Board not found for workspace: ${workspace}`);
  const doneSummary = await buildDoneSummary(board, stateId, projectDir);
  return { action: "done" as const, ok: true as const, terminal_state: stateId, ...doneSummary };
}

// Approval action builder

export function buildApprovalAction(
  completedDef: { agent?: string; type?: string } | undefined,
  artifacts: string[] | undefined,
  state_id: string,
  status: string,
): {
  action: "approval";
  breakpoint: {
    agent_type: string;
    artifacts: string[];
    options: readonly ["approved", "revise", "reject"];
    state_id: string;
    summary: string;
  };
  ok: true;
} {
  return {
    action: "approval" as const,
    breakpoint: {
      agent_type: completedDef?.agent ?? completedDef?.type ?? "unknown",
      artifacts: artifacts ?? [],
      options: ["approved", "revise", "reject"] as const,
      state_id,
      summary: `State '${state_id}' completed with status '${status}'. Awaiting approval.`,
    },
    ok: true as const,
  };
}

export function isParallelWaitState(def: { type?: string } | undefined): boolean {
  return def?.type === "parallel" || def?.type === "parallel-per";
}

// Gate helpers

/** Resolve and run gates for a gate-only state. */
export function resolveAndRunGates(
  stateDef: StateDefinition,
  flow: DriveFlowInput["flow"],
  store: ReturnType<typeof getExecutionStore>,
  projectDir: string,
): GateResult[] {
  if (stateDef.gates?.length) return runGates(stateDef, flow, projectDir);
  const allStates = store.getAllStates();
  const discoveredCommands = allStates
    .flatMap((s) => s.discovered_gates ?? [])
    .map((g) => g.command)
    .filter((cmd, i, arr) => arr.indexOf(cmd) === i);
  if (discoveredCommands.length === 0) return [];
  return runGates({ ...stateDef, gates: discoveredCommands }, flow, projectDir);
}

/** Handle gate failure: report blocked and return HITL breakpoint. */
export async function handleGateFailure(
  gateResults: GateResult[],
  ctx: DriveCtx,
  stateId: string,
): Promise<
  { action: "hitl"; breakpoint: { context: string; reason: string }; ok: true } | ToolResult<never>
> {
  const failedGates = gateResults.filter((g) => !g.passed);
  const gateOutput =
    gateResults.length === 0
      ? "No gates were resolved — failing closed."
      : failedGates
          .map((g) => `Gate "${g.gate}" failed (exit ${g.exitCode}):\n${g.output}`)
          .join("\n\n");

  const reportOut = await reportResult({
    flow: ctx.flow,
    gate_results: gateResults,
    progress_line: `Pre-launch check failed (${failedGates.length}/${gateResults.length} gates failed)`,
    state_id: stateId,
    status_keyword: "blocked",
    workspace: ctx.workspace,
  });
  if (!reportOut.ok) return reportOut as ToolResult<never>;

  return {
    action: "hitl" as const,
    breakpoint: {
      context: `State: ${stateId}`,
      reason: `Pre-launch gates failed:\n\n${gateOutput}`,
    },
    ok: true as const,
  };
}
