/**
 * Board pure mutation helpers.
 * All state-mutating functions return new Board objects (immutable pattern).
 *
 * File I/O functions (readBoard, writeBoard) have been migrated to ExecutionStore
 * (SQLite). Only pure mutation helpers remain in this file.
 */

import type { Board, ConsultationResult, ResolvedFlow } from "./flow-schema.ts";

/**
 * Create a new Board from a resolved flow.
 */
export function initBoard(
  flow: ResolvedFlow,
  task: string,
  baseCommit: string,
): Board {
  const now = new Date().toISOString();

  const states: Board["states"] = {};
  const iterations: Board["iterations"] = {};

  for (const [key, stateDef] of Object.entries(flow.states)) {
    states[key] = { status: "pending", entries: 0 };

    if (stateDef.max_iterations !== undefined) {
      iterations[key] = {
        count: 0,
        max: stateDef.max_iterations,
        history: [],
        cannot_fix: [],
      };
    }
  }

  return {
    flow: flow.name,
    task,
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: baseCommit,
    started: now,
    last_updated: now,
    states,
    iterations,
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// Deprecated stubs — migrated to ExecutionStore
// These exports are kept for backward compatibility during wave migration.
// ---------------------------------------------------------------------------

/** @deprecated Migrated to ExecutionStore (SQLite). Use getExecutionStore(workspace).getBoard() */
export async function readBoard(_workspace: string): Promise<Board> {
  throw new Error("readBoard is deprecated: use getExecutionStore(workspace).getBoard() instead");
}

/** @deprecated Migrated to ExecutionStore (SQLite). Use getExecutionStore(workspace).upsertState() etc. */
export async function writeBoard(_workspace: string, _board: Board): Promise<void> {
  throw new Error("writeBoard is deprecated: use ExecutionStore methods instead");
}

/**
 * Enter a state — sets status to in_progress, increments entries, and
 * optionally increments iteration count.
 */
export function enterState(board: Board, stateId: string): Board {
  const now = new Date().toISOString();
  const prev = board.states[stateId];

  const newStates = {
    ...board.states,
    [stateId]: {
      ...prev,
      status: "in_progress" as const,
      entries: (prev?.entries ?? 0) + 1,
      entered_at: now,
    },
  };

  let newIterations = board.iterations;
  if (board.iterations[stateId]) {
    const iter = board.iterations[stateId];
    newIterations = {
      ...board.iterations,
      [stateId]: {
        ...iter,
        count: iter.count + 1,
      },
    };
  }

  return {
    ...board,
    current_state: stateId,
    states: newStates,
    iterations: newIterations,
    last_updated: now,
  };
}

/**
 * Complete a state — sets status to done, records result and optional artifacts.
 */
export function completeState(
  board: Board,
  stateId: string,
  result: string,
  artifacts?: string[],
): Board {
  const now = new Date().toISOString();
  const prev = board.states[stateId];

  const updated: Board["states"][string] = {
    ...prev,
    status: "done" as const,
    result,
    completed_at: now,
  };

  if (artifacts) {
    updated.artifacts = artifacts;
  }

  return {
    ...board,
    states: {
      ...board.states,
      [stateId]: updated,
    },
    last_updated: now,
  };
}

/**
 * Mark a state as blocked.
 */
export function setBlocked(
  board: Board,
  stateId: string,
  reason: string,
): Board {
  const now = new Date().toISOString();

  return {
    ...board,
    blocked: { state: stateId, reason, since: now },
    states: {
      ...board.states,
      [stateId]: {
        ...board.states[stateId],
        status: "blocked" as const,
      },
    },
    last_updated: now,
  };
}

/**
 * Record a consultation result into the board. Pure — returns a new Board.
 */
export function recordConsultationResult(
  board: Board,
  stateId: string,
  waveKey: string,
  breakpoint: "before" | "between" | "after",
  name: string,
  result: ConsultationResult,
): Board {
  const stateEntry = board.states[stateId] ?? { status: "pending" as const, entries: 0 };
  const waveResult = stateEntry.wave_results?.[waveKey] ?? { tasks: [], status: "in_progress" };
  const consultations = waveResult.consultations ?? {};
  const breakpointMap = consultations[breakpoint] ?? {};

  const newWaveResult = {
    ...waveResult,
    consultations: {
      ...consultations,
      [breakpoint]: {
        ...breakpointMap,
        [name]: result,
      },
    },
  };

  return {
    ...board,
    states: {
      ...board.states,
      [stateId]: {
        ...stateEntry,
        wave_results: {
          ...stateEntry.wave_results,
          [waveKey]: newWaveResult,
        },
      },
    },
  };
}

/**
 * Record a gate result (gate name + output) into the board. Pure — returns a new Board.
 */
export function recordGateResult(
  board: Board,
  stateId: string,
  waveKey: string,
  gate: string,
  gateOutput: string,
): Board {
  const stateEntry = board.states[stateId] ?? { status: "pending" as const, entries: 0 };
  const waveResult = stateEntry.wave_results?.[waveKey] ?? { tasks: [], status: "in_progress" };

  const newWaveResult = {
    ...waveResult,
    gate,
    gate_output: gateOutput,
  };

  return {
    ...board,
    states: {
      ...board.states,
      [stateId]: {
        ...stateEntry,
        wave_results: {
          ...stateEntry.wave_results,
          [waveKey]: newWaveResult,
        },
      },
    },
  };
}
