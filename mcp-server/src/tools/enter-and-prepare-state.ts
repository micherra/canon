/**
 * Combined tool: check_convergence + skip_when evaluation + update_board(enter_state) + get_spawn_prompt
 * in a single round-trip. Reduces the orchestrator's per-state loop from 4 MCP calls to 2.
 *
 * Key behavior:
 * 1. Read board from ExecutionStore (synchronous — no 500ms retry needed; SQLite init is atomic).
 * 2. Check convergence (iteration limits) — if can't enter, return early with can_enter:false.
 * 3. Evaluate skip_when BEFORE entering state — if skip, return skip_reason without mutating store.
 * 4. Enter state via store.transaction() (no file locking).
 * 5. Resolve spawn prompts.
 * 6. Return combined result.
 */

import { gitExec } from "../platform/adapters/git-adapter.ts";
import { enterState } from "../orchestration/board.ts";
import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import { assembleEnrichment } from "../orchestration/context-enrichment.ts";
import { canEnterState } from "../orchestration/convergence.ts";
import type { FileCluster } from "../orchestration/diff-cluster.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type {
  Board,
  CannotFixItem,
  HistoryEntry,
  ResolvedFlow,
} from "../orchestration/flow-schema.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import type { ToolResult } from "../shared/lib/tool-result.ts";
import { toolError } from "../shared/lib/tool-result.ts";
import type { SpawnPromptEntry, TaskItem } from "./get-spawn-prompt.ts";
import { getSpawnPrompt } from "./get-spawn-prompt.ts";

export type ConsultationPromptEntry = {
  name: string;
  agent: string;
  prompt: string;
  role: string;
  timeout?: string;
  section?: string;
};

export type EnterAndPrepareStateInput = {
  workspace: string;
  state_id: string;
  flow: ResolvedFlow;
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  wave?: number;
  peer_count?: number;
  project_dir?: string;
};

export type EnterAndPrepareStateResult = {
  // Convergence data (always present)
  can_enter: boolean;
  iteration_count: number;
  max_iterations: number;
  cannot_fix_items: CannotFixItem[];
  history: HistoryEntry[];
  convergence_reason?: string;

  // Spawn prompt data (only when can_enter && !skipped)
  prompts: SpawnPromptEntry[];
  state_type: string;
  skip_reason?: string;
  warnings?: string[];
  clusters?: FileCluster[];
  timeout_ms?: number;
  fanned_out?: boolean;

  // Consultation prompts to spawn (only when state has consultations at the current breakpoint)
  consultation_prompts?: ConsultationPromptEntry[];

  // Updated board (only when state was entered)
  board?: Board;
};

/** Extract session branch variables from the persisted execution row. */
function extractSessionVars(store: ReturnType<typeof getExecutionStore>): Record<string, string> {
  const session = store.getSession();
  const vars: Record<string, string> = {};
  if (!session) return vars;
  vars.branch = session.branch;
  if (session.worktree_branch) vars.worktree_branch = session.worktree_branch;
  if (session.worktree_path) vars.worktree_path = session.worktree_path;
  return vars;
}

/** Extract convergence data from the board for a given state. */
function extractConvergenceData(board: Board, state_id: string) {
  const iteration = board.iterations[state_id];
  return {
    cannot_fix_items: (iteration?.cannot_fix ?? []) as CannotFixItem[],
    history: (iteration?.history ?? []) as HistoryEntry[],
    iteration_count: iteration?.count ?? 0,
    max_iterations: iteration?.max ?? 0,
  };
}

/** Persist the entered state inside a SQLite transaction. */
function persistStateEntry(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  state_id: string,
  now: string,
): Board {
  let enteredBoard: Board = board;
  store.transaction(() => {
    enteredBoard = enterState(board, state_id);
    store.updateExecution({ current_state: state_id, last_updated: now });

    const enteredStateEntry = enteredBoard.states[state_id];
    if (enteredStateEntry) {
      store.upsertState(state_id, {
        ...enteredStateEntry,
        entered_at: enteredStateEntry.entered_at,
        entries: enteredStateEntry.entries,
        status: enteredStateEntry.status,
      });
    }

    if (enteredBoard.iterations[state_id]) {
      const iter = enteredBoard.iterations[state_id];
      store.upsertIteration(state_id, {
        cannot_fix: iter.cannot_fix,
        count: iter.count,
        history: iter.history,
        max: iter.max,
      });
    }
  });
  return enteredBoard;
}

type EmitStateEntryEventsOpts = {
  state_id: string;
  stateType: string;
  now: string;
  iterationCount: number;
};

/** Emit board_updated and state_entered events (best-effort). */
function emitStateEntryEvents(
  store: ReturnType<typeof getExecutionStore>,
  opts: EmitStateEntryEventsOpts,
): void {
  const { state_id, stateType, now, iterationCount } = opts;
  const onBoardUpdated = (
    event: import("../orchestration/events.js").FlowEventMap["board_updated"],
  ) => {
    try {
      store.appendEvent("board_updated", event as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("board_updated", onBoardUpdated);
  try {
    flowEventBus.emit("board_updated", {
      action: "enter_state",
      stateId: state_id,
      timestamp: now,
    });
    const onStateEntered = (
      event: import("../orchestration/events.js").FlowEventMap["state_entered"],
    ) => {
      try {
        store.appendEvent("state_entered", event as Record<string, unknown>);
      } catch {
        /* best-effort */
      }
    };
    flowEventBus.once("state_entered", onStateEntered);
    try {
      flowEventBus.emit("state_entered", {
        iterationCount,
        stateId: state_id,
        stateType,
        timestamp: now,
      });
    } finally {
      flowEventBus.removeListener("state_entered", onStateEntered);
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }
}

/** Check if a consultation should be skipped due to min_waves constraint. */
function shouldSkipConsultation(
  name: string,
  flow: ResolvedFlow,
  enteredBoard: Board,
  state_id: string,
): boolean {
  const fragment = flow.consultations?.[name];
  if (fragment?.min_waves == null) return false;
  const waveTotal = enteredBoard.states[state_id]?.wave_total;
  return waveTotal != null && waveTotal < fragment.min_waves;
}

/** Build a ConsultationPromptEntry from a resolved prompt. */
function buildConsultationEntry(
  name: string,
  resolved: NonNullable<ReturnType<typeof resolveConsultationPrompt>>,
): ConsultationPromptEntry {
  return {
    agent: resolved.agent,
    name,
    prompt: resolved.prompt,
    role: resolved.role,
    ...(resolved.timeout ? { timeout: resolved.timeout } : {}),
    ...(resolved.section ? { section: resolved.section } : {}),
  };
}

type ResolveConsultationsOpts = {
  flow: ResolvedFlow;
  enteredBoard: Board;
  state_id: string;
  stateDef: ResolvedFlow["states"][string] | undefined;
};

/** Resolve consultation prompts for the current breakpoint. */
function resolveConsultations(
  input: EnterAndPrepareStateInput,
  opts: ResolveConsultationsOpts,
): {
  prompts: ConsultationPromptEntry[];
  outputs: Record<string, { section?: string; summary: string }>;
} {
  const { flow, enteredBoard, state_id, stateDef } = opts;
  const prompts: ConsultationPromptEntry[] = [];
  const outputs: Record<string, { section?: string; summary: string }> = {};

  if (!stateDef?.consultations) return { outputs, prompts };

  const breakpoint: "before" | "between" =
    input.wave == null || input.wave === 0 ? "before" : "between";
  const names = stateDef.consultations[breakpoint] ?? [];

  for (const name of names) {
    if (shouldSkipConsultation(name, flow, enteredBoard, state_id)) continue;
    const resolved = resolveConsultationPrompt(name, flow, input.variables);
    if (resolved) prompts.push(buildConsultationEntry(name, resolved));
  }

  collectConsultationOutputs(enteredBoard, state_id, flow, outputs);
  return { outputs, prompts };
}

/** Extract done consultation summaries from a single breakpoint map. */
function extractBreakpointOutputs(
  bpMap: Record<string, { status: string; summary?: string | null }> | undefined,
  flow: ResolvedFlow,
  outputs: Record<string, { section?: string; summary: string }>,
): void {
  if (!bpMap) return;
  for (const [cName, cResult] of Object.entries(bpMap)) {
    if (cResult.status === "done" && cResult.summary) {
      outputs[cName] = { section: flow.consultations?.[cName]?.section, summary: cResult.summary };
    }
  }
}

/** Collect completed consultation summaries from prior waves. */
function collectConsultationOutputs(
  board: Board,
  state_id: string,
  flow: ResolvedFlow,
  outputs: Record<string, { section?: string; summary: string }>,
): void {
  const stateEntry = board.states[state_id];
  if (!stateEntry?.wave_results) return;
  for (const [_waveKey, waveResult] of Object.entries(stateEntry.wave_results)) {
    const consultations = waveResult.consultations;
    if (!consultations) continue;
    for (const bp of ["before", "between", "after"] as const) {
      extractBreakpointOutputs(consultations[bp], flow, outputs);
    }
  }
}

/** Resolve review_scope variable for re-entered review states. */
function resolveReviewScope(enteredBoard: Board, state_id: string): Record<string, string> {
  if ((enteredBoard.states[state_id]?.entries ?? 0) <= 1) return {};
  const baseRef = enteredBoard.base_commit;
  if (!baseRef || !/^[a-f0-9]{7,40}$/.test(baseRef)) return {};
  try {
    const result = gitExec(["diff", "--name-only", `${baseRef}..HEAD`], process.cwd(), 5000);
    if (result.ok && result.stdout) {
      const files = result.stdout.trim().split("\n").filter(Boolean);
      return {
        review_scope:
          files.length > 0
            ? `Scoped re-review. Files changed since last review:\n${files.join("\n")}`
            : "",
      };
    }
    return { review_scope: "" };
  } catch {
    return { review_scope: "" };
  }
}

type ResolveEnrichmentVarsOpts = {
  state_id: string;
  enteredBoard: Board;
  flow: ResolvedFlow;
  projectDir: string | undefined;
};

/** Resolve context enrichment variables (non-blocking). */
async function resolveEnrichmentVars(
  workspace: string,
  opts: ResolveEnrichmentVarsOpts,
): Promise<Record<string, string>> {
  const { state_id, enteredBoard, flow, projectDir } = opts;
  try {
    const enrichment = await assembleEnrichment({
      baseCommit: enteredBoard.base_commit,
      board: enteredBoard,
      cwd: projectDir ?? process.cwd(),
      flow,
      projectDir,
      stateId: state_id,
      workspace,
    });
    if (enrichment.warnings.length > 0) {
      console.error(`enrichment warnings: ${enrichment.warnings.join("; ")}`);
    }
    return { enrichment: enrichment.content || "" };
  } catch {
    return { enrichment: "" };
  }
}

type CheckStateSkipWhenOpts = {
  state_id: string;
  workspace: string;
  board: Board;
  convergence: ReturnType<typeof extractConvergenceData>;
};

/** Check skip_when condition on a state definition. Returns skip result or null. */
async function checkStateSkipWhen(
  stateDef: ResolvedFlow["states"][string] | undefined,
  opts: CheckStateSkipWhenOpts,
): Promise<ToolResult<EnterAndPrepareStateResult> | null> {
  const { state_id, workspace, board, convergence } = opts;
  if (!stateDef?.skip_when) return null;
  const skipResult = await evaluateSkipWhen(stateDef.skip_when, workspace, board);
  if (!skipResult.skip) return null;
  return {
    can_enter: true,
    ok: true as const,
    ...convergence,
    prompts: [],
    skip_reason: `Skipping ${state_id}: ${stateDef.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`,
    state_type: stateDef.type,
  } as ToolResult<EnterAndPrepareStateResult>;
}

/** Build the final success result from spawn + consultation data. */
function buildPrepareResult(
  convergence: ReturnType<typeof extractConvergenceData>,
  spawnResult: Awaited<ReturnType<typeof getSpawnPrompt>>,
  consultationPrompts: ConsultationPromptEntry[],
  enteredBoard: Board,
): ToolResult<EnterAndPrepareStateResult> {
  return {
    can_enter: true,
    ok: true as const,
    ...convergence,
    prompts: spawnResult.prompts,
    state_type: spawnResult.state_type,
    ...(spawnResult.skip_reason ? { skip_reason: spawnResult.skip_reason } : {}),
    ...(spawnResult.warnings ? { warnings: spawnResult.warnings } : {}),
    ...(spawnResult.clusters ? { clusters: spawnResult.clusters } : {}),
    ...(spawnResult.timeout_ms != null ? { timeout_ms: spawnResult.timeout_ms } : {}),
    ...(spawnResult.fanned_out ? { fanned_out: true } : {}),
    ...(consultationPrompts.length > 0 ? { consultation_prompts: consultationPrompts } : {}),
    board: enteredBoard,
  } as ToolResult<EnterAndPrepareStateResult>;
}

/** Enter state, resolve consultations/enrichment, and build spawn prompt. */
async function enterAndResolveSpawn(
  input: EnterAndPrepareStateInput,
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  convergence: ReturnType<typeof extractConvergenceData>,
): Promise<ToolResult<EnterAndPrepareStateResult>> {
  const { workspace, state_id, flow } = input;
  const stateDef = flow.states[state_id];
  const skipEarly = await checkStateSkipWhen(stateDef, { board, convergence, state_id, workspace });
  if (skipEarly) return skipEarly;

  const now = new Date().toISOString();
  const enteredBoard = persistStateEntry(store, board, state_id, now);
  emitStateEntryEvents(store, {
    iterationCount: enteredBoard.iterations[state_id]?.count ?? 0,
    now,
    state_id,
    stateType: stateDef?.type ?? "unknown",
  });

  const { prompts: consultationPrompts, outputs: consultationOutputs } = resolveConsultations(
    input,
    { enteredBoard, flow, state_id, stateDef },
  );

  const sessionVars = extractSessionVars(store);
  const reviewScopeVars = resolveReviewScope(enteredBoard, state_id);
  const enrichmentVars = await resolveEnrichmentVars(workspace, {
    enteredBoard,
    flow,
    projectDir: input.project_dir,
    state_id,
  });

  const spawnResult = await getSpawnPrompt({
    _board: enteredBoard,
    consultation_outputs:
      Object.keys(consultationOutputs).length > 0 ? consultationOutputs : undefined,
    flow,
    items: input.items,
    peer_count: input.peer_count,
    project_dir: input.project_dir,
    role: input.role,
    state_id,
    variables: { ...sessionVars, ...input.variables, ...reviewScopeVars, ...enrichmentVars },
    wave: input.wave,
    workspace,
  });

  return buildPrepareResult(convergence, spawnResult, consultationPrompts, enteredBoard);
}

export async function enterAndPrepareState(
  input: EnterAndPrepareStateInput,
): Promise<ToolResult<EnterAndPrepareStateResult>> {
  const { workspace, state_id, flow } = input;
  const store = getExecutionStore(workspace);

  const board = store.getBoard();
  if (!board) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${workspace}`);
  }

  const convergence = extractConvergenceData(board, state_id);
  const { allowed, reason } = canEnterState(board, state_id);

  if (!allowed) {
    return {
      can_enter: false,
      ok: true as const,
      ...convergence,
      convergence_reason: reason,
      prompts: [],
      state_type: flow.states[state_id]?.type ?? "unknown",
    } as ToolResult<EnterAndPrepareStateResult>;
  }

  return enterAndResolveSpawn(input, store, board, convergence);
}
