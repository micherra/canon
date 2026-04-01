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

import { enterState } from "../orchestration/board.ts";
import { canEnterState } from "../orchestration/convergence.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { getSpawnPrompt } from "./get-spawn-prompt.ts";
import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { gitExec } from "../adapters/git-adapter.ts";
import { toolError } from "../utils/tool-result.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import type { ResolvedFlow, Board, CannotFixItem, HistoryEntry } from "../orchestration/flow-schema.ts";
import type { TaskItem, SpawnPromptEntry } from "./get-spawn-prompt.ts";
import type { FileCluster } from "../orchestration/diff-cluster.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, CannotFixItem, HistoryEntry, ResolvedFlow, WorktreeEntry } from "../orchestration/flow-schema.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import { toolError } from "../utils/tool-result.ts";
import type { SpawnPromptEntry, TaskItem } from "./get-spawn-prompt.ts";
import { getSpawnPrompt } from "./get-spawn-prompt.ts";

export interface ConsultationPromptEntry {
  name: string;
  agent: string;
  prompt: string;
  role: string;
  timeout?: string;
  section?: string;
}

export interface EnterAndPrepareStateInput {
  workspace: string;
  state_id: string;
  flow: ResolvedFlow;
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  wave?: number;
  peer_count?: number;
  project_dir?: string;
}

export interface EnterAndPrepareStateResult {
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

  worktree_entries?: WorktreeEntry[];

  // Updated board (only when state was entered)
  board?: Board;
}

/** Persist state entry into the SQLite store via a transaction. */
function persistStateEntry(store: ReturnType<typeof getExecutionStore>, board: Board, state_id: string): Board {
  let enteredBoard: Board = board;
  store.transaction(() => {
    enteredBoard = enterState(board, state_id);

    store.updateExecution({
      current_state: state_id,
      last_updated: enteredBoard.last_updated,
    });

    const enteredStateEntry = enteredBoard.states[state_id];
    if (enteredStateEntry) {
      store.upsertState(state_id, {
        ...enteredStateEntry,
        status: enteredStateEntry.status,
        entries: enteredStateEntry.entries,
        entered_at: enteredStateEntry.entered_at,
      });
    }

    if (enteredBoard.iterations[state_id]) {
      const iter = enteredBoard.iterations[state_id];
      store.upsertIteration(state_id, {
        count: iter.count,
        max: iter.max,
        history: iter.history,
        cannot_fix: iter.cannot_fix,
      });
    }
  });
  return enteredBoard;
}

/** Emit board_updated and state_entered events (best-effort). */
function emitStateEntryEvents(
  store: ReturnType<typeof getExecutionStore>,
  state_id: string,
  stateType: string,
  enteredAt: string,
  iterationCount: number,
): void {
  const onBoardUpdated = (event: import("../orchestration/events.js").FlowEventMap["board_updated"]) => {
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
      timestamp: enteredAt,
    });
    const onStateEntered = (event: import("../orchestration/events.js").FlowEventMap["state_entered"]) => {
      try {
        store.appendEvent("state_entered", event as Record<string, unknown>);
      } catch {
        /* best-effort */
      }
    };
    flowEventBus.once("state_entered", onStateEntered);
    try {
      flowEventBus.emit("state_entered", {
        stateId: state_id,
        stateType,
        timestamp: enteredAt,
        iterationCount,
      });
    } finally {
      flowEventBus.removeListener("state_entered", onStateEntered);
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }
}

/** Resolve consultation prompts for the current breakpoint. */
function resolveConsultationPrompts(input: EnterAndPrepareStateInput, enteredBoard: Board): ConsultationPromptEntry[] {
  const { state_id, flow } = input;
  const stateDef = flow.states[state_id];
  if (!stateDef?.consultations) return [];

  const breakpoint: "before" | "between" = input.wave == null || input.wave === 0 ? "before" : "between";
  const names = stateDef.consultations[breakpoint] ?? [];
  const prompts: ConsultationPromptEntry[] = [];

  for (const name of names) {
    const fragment = flow.consultations?.[name];
    if (fragment?.min_waves != null) {
      const waveTotal = enteredBoard.states[state_id]?.wave_total;
      if (waveTotal != null && waveTotal < fragment.min_waves) continue;
    }

    const resolved = resolveConsultationPrompt(name, flow, input.variables);
    if (!resolved) continue;
    prompts.push({
      name,
      agent: resolved.agent,
      prompt: resolved.prompt,
      role: resolved.role,
      ...(resolved.timeout ? { timeout: resolved.timeout } : {}),
      ...(resolved.section ? { section: resolved.section } : {}),
    });
  }
  return prompts;
}

/** Collect completed consultation summaries from prior wave results. */
function collectConsultationOutputs(
  enteredBoard: Board,
  state_id: string,
  flow: EnterAndPrepareStateInput["flow"],
): Record<string, { section?: string; summary: string }> {
  const outputs: Record<string, { section?: string; summary: string }> = {};
  const stateEntry = enteredBoard.states[state_id];
  if (!stateEntry?.wave_results) return outputs;

  for (const [_waveKey, waveResult] of Object.entries(stateEntry.wave_results)) {
    const consultations = waveResult.consultations;
    if (!consultations) continue;
    for (const bp of ["before", "between", "after"] as const) {
      const bpMap = consultations[bp];
      if (!bpMap) continue;
      for (const [cName, cResult] of Object.entries(bpMap)) {
        if (cResult.status !== "done" || !cResult.summary) continue;
        const frag = flow.consultations?.[cName];
        outputs[cName] = {
          section: frag?.section,
          summary: escapeDollarBrace(cResult.summary),
        };
      }
    }
  }
  return outputs;
}

/** Resolve review_scope variable for re-entered review states. */
function resolveReviewScope(enteredBoard: Board, state_id: string): Record<string, string> {
  if (!(enteredBoard.states[state_id]?.entries > 1)) return {};

  const baseRef = enteredBoard.base_commit;
  if (!baseRef || !/^[a-f0-9]{7,40}$/.test(baseRef)) return {};

  try {
    const result = gitExec(["diff", "--name-only", `${baseRef}..HEAD`], process.cwd(), 5000);
    if (result.ok && result.stdout) {
      const files = result.stdout.trim().split("\n").filter(Boolean);
      return {
        review_scope: files.length > 0 ? `Scoped re-review. Files changed since last review:\n${files.join("\n")}` : "",
      };
    }
  } catch {
    // fall through
  }
  return { review_scope: "" };
}

/** Extract worktree entries for the current wave from the board. */
function extractWorktreeEntries(
  enteredBoard: Board,
  state_id: string,
  stateType: string | undefined,
  wave: number | undefined,
): WorktreeEntry[] | undefined {
  if (stateType !== "wave" || wave == null) return undefined;
  const stateEntry = enteredBoard.states[state_id];
  const waveKey = `wave_${wave}`;
  return stateEntry?.wave_results?.[waveKey]?.worktree_entries;
}

/** Extract iteration info from board for a given state. */
function getIterationInfo(
  board: Board,
  state_id: string,
): {
  iteration_count: number;
  max_iterations: number;
  cannot_fix_items: CannotFixItem[];
  history: HistoryEntry[];
} {
  const iteration = board.iterations[state_id];
  return {
    iteration_count: iteration?.count ?? 0,
    max_iterations: iteration?.max ?? 0,
    cannot_fix_items: iteration?.cannot_fix ?? [],
    history: iteration?.history ?? [],
  };
}

/** Attach worktree paths to spawn prompts based on worktree entries. */
function attachWorktreePaths(prompts: SpawnPromptEntry[], worktreeEntries: WorktreeEntry[] | undefined): void {
  if (!worktreeEntries || prompts.length === 0) return;
  const entryMap = new Map(worktreeEntries.map((e) => [e.task_id, e]));
  for (const prompt of prompts) {
    const taskId = typeof prompt.item === "string" ? prompt.item : undefined;
    if (!taskId) continue;
    const entry = entryMap.get(taskId);
    if (entry?.status === "active") {
      prompt.worktree_path = entry.worktree_path;
    }
  }
}

export async function enterAndPrepareState(
  input: EnterAndPrepareStateInput,
): Promise<ToolResult<EnterAndPrepareStateResult>> {
  const { workspace, state_id, flow } = input;
  const store = getExecutionStore(workspace);

  const store = getExecutionStore(workspace);

  // Step 1: Read board once from ExecutionStore (synchronous — no retry needed).
  // SQLite init is atomic — the execution row is always present after initWorkspaceFlow.
  const board = store.getBoard();
  if (!board) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${workspace}`);
  }

  const { allowed, reason } = canEnterState(board, state_id);
  const iterInfo = getIterationInfo(board, state_id);

  if (!allowed) {
    return {
      ok: true as const,
      can_enter: false,
      ...iterInfo,
      convergence_reason: reason,
      prompts: [],
      state_type: flow.states[state_id]?.type ?? "unknown",
    };
  }

  // Step 3: Evaluate skip_when BEFORE entering state.
  const stateDef = flow.states[state_id];
  if (stateDef?.skip_when) {
    const skipResult = await evaluateSkipWhen(stateDef.skip_when, workspace, board);
    if (skipResult.skip) {
      return {
        ok: true as const,
        can_enter: true,
        ...iterInfo,
        prompts: [],
        state_type: stateDef.type,
        skip_reason: `Skipping ${state_id}: ${stateDef.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`,
      };
    }
  }

  // Step 4: Enter the state inside a SQLite transaction (replaces withBoardLock).
  // Pure mutation on in-memory board, then persist only changed fields.
  let enteredBoard: Board = board;
  const now = new Date().toISOString();

  store.transaction(() => {
    enteredBoard = enterState(board, state_id);

    // Persist execution-level changes
    store.updateExecution({
      current_state: state_id,
      last_updated: now,
    });

    // Persist the entered state
    const enteredStateEntry = enteredBoard.states[state_id];
    if (enteredStateEntry) {
      store.upsertState(state_id, {
        ...enteredStateEntry,
        status: enteredStateEntry.status,
        entries: enteredStateEntry.entries,
        entered_at: enteredStateEntry.entered_at,
      });
    }

    // Persist iteration count if the state has iteration limits
    if (enteredBoard.iterations[state_id]) {
      const iter = enteredBoard.iterations[state_id];
      store.upsertIteration(state_id, {
        count: iter.count,
        max: iter.max,
        history: iter.history,
        cannot_fix: iter.cannot_fix,
      });
    }
  });

  // Emit events (best-effort)
  const onBoardUpdated = (event: import("../orchestration/events.js").FlowEventMap["board_updated"]) => {
    try { store.appendEvent("board_updated", event as Record<string, unknown>); } catch { /* best-effort */ }
  };
  flowEventBus.once("board_updated", onBoardUpdated);
  try {
    flowEventBus.emit("board_updated", {
      action: "enter_state",
      stateId: state_id,
      timestamp: now,
    });
    const onStateEntered = (event: import("../orchestration/events.js").FlowEventMap["state_entered"]) => {
      try { store.appendEvent("state_entered", event as Record<string, unknown>); } catch { /* best-effort */ }
    };
    flowEventBus.once("state_entered", onStateEntered);
    try {
      flowEventBus.emit("state_entered", {
        stateId: state_id,
        stateType: stateDef?.type ?? "unknown",
        timestamp: now,
        iterationCount: enteredBoard.iterations[state_id]?.count ?? 0,
      });
    } finally {
      flowEventBus.removeListener("state_entered", onStateEntered);
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }

  // Step 4.5: Resolve consultation prompts for the current breakpoint.
  const consultationPrompts: ConsultationPromptEntry[] = [];
  const consultationOutputs: Record<string, { section?: string; summary: string }> = {};

  if (stateDef?.consultations) {
    // Determine breakpoint: "before" for first wave (0 or null), "between" for subsequent waves
    const breakpoint: "before" | "between" = (input.wave == null || input.wave === 0) ? "before" : "between";
    const names = stateDef.consultations[breakpoint] ?? [];

    for (const name of names) {
      // Check min_waves threshold before resolving — skip consultation if
      // wave_total is known and below the fragment's minimum.
      const fragment = flow.consultations?.[name];
      if (fragment?.min_waves != null) {
        const waveTotal = enteredBoard.states[state_id]?.wave_total;
        if (waveTotal != null && waveTotal < fragment.min_waves) {
          continue;
        }
      }

      const resolved = resolveConsultationPrompt(name, flow, input.variables);
      if (resolved) {
        consultationPrompts.push({
          name,
          agent: resolved.agent,
          prompt: resolved.prompt,
          role: resolved.role,
          ...(resolved.timeout ? { timeout: resolved.timeout } : {}),
          ...(resolved.section ? { section: resolved.section } : {}),
        });
      }
    }

    // Collect completed consultation summaries from prior waves for briefing injection.
    const stateEntry = enteredBoard.states[state_id];
    if (stateEntry?.wave_results) {
      for (const [_waveKey, waveResult] of Object.entries(stateEntry.wave_results)) {
        const consultations = waveResult.consultations;
        if (!consultations) continue;
        for (const bp of ["before", "between", "after"] as const) {
          const bpMap = consultations[bp];
          if (!bpMap) continue;
          for (const [cName, cResult] of Object.entries(bpMap)) {
            if (cResult.status === "done" && cResult.summary) {
              const fragment = flow.consultations?.[cName];
              consultationOutputs[cName] = {
                section: fragment?.section,
                summary: escapeDollarBrace(cResult.summary),
              };
            }
          }
        }
      }
    }
  }

  // Step 4.6: Resolve review_scope for re-entered review states.
  let reviewScopeVars: Record<string, string> = {};
  if (enteredBoard.states[state_id]?.entries > 1) {
    const baseRef = enteredBoard.base_commit;
    if (baseRef && /^[a-f0-9]{7,40}$/.test(baseRef)) {
      try {
        const result = gitExec(["diff", "--name-only", `${baseRef}..HEAD`], process.cwd(), 5000);
        if (result.ok && result.stdout) {
          const files = result.stdout.trim().split("\n").filter(Boolean);
          reviewScopeVars.review_scope = files.length > 0
            ? `Scoped re-review. Files changed since last review:\n${files.join("\n")}`
            : "";
        } else {
          reviewScopeVars.review_scope = "";
        }
      } catch {
        reviewScopeVars.review_scope = "";
      }
    }
  }

  // Step 5: Resolve spawn prompts.
  const spawnResult = await getSpawnPrompt({
    workspace,
    state_id,
    flow,
    variables: { ...input.variables, ...reviewScopeVars },
    items: input.items,
    role: input.role,
    wave: input.wave,
    peer_count: input.peer_count,
    project_dir: input.project_dir,
    consultation_outputs: Object.keys(consultationOutputs).length > 0 ? consultationOutputs : undefined,
    _board: enteredBoard,
  });

  attachWorktreePaths(spawnResult.prompts, worktreeEntries);

  return {
    ok: true as const,
    can_enter: true,
    ...iterInfo,
    prompts: spawnResult.prompts,
    state_type: spawnResult.state_type,
    ...(spawnResult.skip_reason ? { skip_reason: spawnResult.skip_reason } : {}),
    ...(spawnResult.warnings ? { warnings: spawnResult.warnings } : {}),
    ...(spawnResult.clusters ? { clusters: spawnResult.clusters } : {}),
    ...(spawnResult.timeout_ms != null ? { timeout_ms: spawnResult.timeout_ms } : {}),
    ...(spawnResult.fanned_out ? { fanned_out: true } : {}),
    ...(consultationPrompts.length > 0 ? { consultation_prompts: consultationPrompts } : {}),
    ...(worktreeEntries ? { worktree_entries: worktreeEntries } : {}),
    board: enteredBoard,
  };
}
