/**
 * Combined tool: check_convergence + skip_when evaluation + update_board(enter_state) + get_spawn_prompt
 * in a single round-trip. Reduces the orchestrator's per-state loop from 4 MCP calls to 2.
 *
 * Key behavior:
 * 1. Read board once.
 * 2. Check convergence (iteration limits) — if can't enter, return early with can_enter:false.
 * 3. Evaluate skip_when BEFORE entering state — if skip, return skip_reason without mutating board.
 * 4. Enter state via enterState + writeBoard (inside withBoardLock).
 * 5. Resolve spawn prompts (reusing getSpawnPrompt logic, passing already-read board).
 * 6. Return combined result.
 */

import { readBoard, writeBoard, enterState } from "../orchestration/board.ts";
import { canEnterState } from "../orchestration/convergence.ts";
import { withBoardLock } from "../orchestration/workspace.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { getSpawnPrompt } from "./get-spawn-prompt.ts";
import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { createJsonlLogger } from "../orchestration/events.ts";
import type { ResolvedFlow, Board, CannotFixItem, HistoryEntry } from "../orchestration/flow-schema.ts";
import type { TaskItem, SpawnPromptEntry } from "./get-spawn-prompt.ts";
import type { FileCluster } from "../orchestration/diff-cluster.ts";
import type { OverlayDefinition } from "../orchestration/overlays.ts";

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
  overlays?: string[];
  wave?: number;
  peer_count?: number;
  project_dir?: string;
  /** Pre-loaded overlays — avoids re-reading from disk if caller already has them. */
  loaded_overlays?: OverlayDefinition[];
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

  // Consultation prompts to spawn (only when state has consultations at the current breakpoint)
  consultation_prompts?: ConsultationPromptEntry[];

  // Updated board (only when state was entered)
  board?: Board;
}

export async function enterAndPrepareState(
  input: EnterAndPrepareStateInput,
): Promise<EnterAndPrepareStateResult> {
  const { workspace, state_id, flow } = input;

  // Step 1: Read board once for all subsequent operations.
  const board = await readBoard(workspace);

  // Step 2: Check convergence — bail early if max iterations reached.
  const { allowed, reason } = canEnterState(board, state_id);
  const iteration = board.iterations[state_id];
  const iteration_count = iteration?.count ?? 0;
  const max_iterations = iteration?.max ?? 0;
  const cannot_fix_items: CannotFixItem[] = iteration?.cannot_fix ?? [];
  const history: HistoryEntry[] = iteration?.history ?? [];

  if (!allowed) {
    return {
      can_enter: false,
      iteration_count,
      max_iterations,
      cannot_fix_items,
      history,
      convergence_reason: reason,
      prompts: [],
      state_type: flow.states[state_id]?.type ?? "unknown",
    };
  }

  // Step 3: Evaluate skip_when BEFORE entering state.
  // This is the key optimization: we skip evaluation here so the orchestrator
  // never needs to enter a state only to immediately skip it.
  const stateDef = flow.states[state_id];
  if (stateDef?.skip_when) {
    const skipResult = await evaluateSkipWhen(stateDef.skip_when, workspace, board);
    if (skipResult.skip) {
      const skipReason = `Skipping ${state_id}: ${stateDef.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`;
      return {
        can_enter: true,
        iteration_count,
        max_iterations,
        cannot_fix_items,
        history,
        prompts: [],
        state_type: stateDef.type,
        skip_reason: skipReason,
      };
    }
  }

  // Step 4: Enter the state inside a board lock.
  // We use withBoardLock to guard the enter+write sequence.
  // We use the board already read above rather than re-reading inside the lock.
  // The orchestrator is a single-process state machine so concurrent board mutations
  // for the same state are not expected; the lock prevents file-level corruption.
  let enteredBoard: Board = board;
  await withBoardLock(workspace, async () => {
    enteredBoard = enterState(board, state_id);
    await writeBoard(workspace, enteredBoard);

    // Emit events (best-effort)
    const log = createJsonlLogger(workspace);
    const onBoardUpdated = (event: import("../orchestration/events.js").FlowEventMap["board_updated"]) => {
      log("board_updated", event).catch(() => {});
    };
    flowEventBus.once("board_updated", onBoardUpdated);
    try {
      flowEventBus.emit("board_updated", {
        action: "enter_state",
        stateId: state_id,
        timestamp: new Date().toISOString(),
      });
      const onStateEntered = (event: import("../orchestration/events.js").FlowEventMap["state_entered"]) => {
        log("state_entered", event).catch(() => {});
      };
      flowEventBus.once("state_entered", onStateEntered);
      try {
        flowEventBus.emit("state_entered", {
          stateId: state_id,
          stateType: stateDef?.type ?? "unknown",
          timestamp: new Date().toISOString(),
          iterationCount: enteredBoard.iterations[state_id]?.count ?? 0,
        });
      } finally {
        flowEventBus.removeListener("state_entered", onStateEntered);
      }
    } finally {
      flowEventBus.removeListener("board_updated", onBoardUpdated);
    }
  });

  // Step 4.5: Resolve consultation prompts for the current breakpoint.
  const consultationPrompts: ConsultationPromptEntry[] = [];
  const consultationOutputs: Record<string, { section?: string; summary: string }> = {};

  if (stateDef?.consultations) {
    // Determine breakpoint: "before" for first wave (0 or null), "between" for subsequent waves
    const breakpoint: "before" | "between" = (input.wave == null || input.wave === 0) ? "before" : "between";
    const names = stateDef.consultations[breakpoint] ?? [];

    for (const name of names) {
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
    // All summaries pass through escapeDollarBrace before entering the prompt pipeline
    // (trust boundary: agent output → prompt assembly).
    const stateEntry = enteredBoard.states[state_id];
    if (stateEntry?.wave_results) {
      for (const [_waveKey, waveResult] of Object.entries(stateEntry.wave_results)) {
        const consultations = waveResult.consultations;
        if (!consultations) continue;
        for (const bp of ["before", "between"] as const) {
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

  // Step 5: Resolve spawn prompts. Pass the entered board so getSpawnPrompt
  // reuses the already-read board instead of calling readBoard again.
  const spawnResult = await getSpawnPrompt({
    workspace,
    state_id,
    flow,
    variables: input.variables,
    items: input.items,
    role: input.role,
    overlays: input.overlays,
    wave: input.wave,
    peer_count: input.peer_count,
    project_dir: input.project_dir,
    loaded_overlays: input.loaded_overlays,
    consultation_outputs: Object.keys(consultationOutputs).length > 0 ? consultationOutputs : undefined,
    _board: enteredBoard,
  });

  return {
    can_enter: true,
    iteration_count,
    max_iterations,
    cannot_fix_items,
    history,
    prompts: spawnResult.prompts,
    state_type: spawnResult.state_type,
    ...(spawnResult.skip_reason ? { skip_reason: spawnResult.skip_reason } : {}),
    ...(spawnResult.warnings ? { warnings: spawnResult.warnings } : {}),
    ...(spawnResult.clusters ? { clusters: spawnResult.clusters } : {}),
    ...(spawnResult.timeout_ms != null ? { timeout_ms: spawnResult.timeout_ms } : {}),
    ...(consultationPrompts.length > 0 ? { consultation_prompts: consultationPrompts } : {}),
    board: enteredBoard,
  };
}
