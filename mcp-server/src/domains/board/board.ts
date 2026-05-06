/**
 * Board pure mutation helpers.
 * All state-mutating functions return new Board objects (immutable pattern).
 *
 * File I/O (readBoard, writeBoard) has been removed — use ExecutionStore (SQLite).
 */

import type {
  Board,
  CannotFixItem,
  ConcernEntry,
  ConsultationResult,
} from "@domains/flows/board-state-schemas.ts";

/**
 * Discriminated union result type for Board operations with preconditions.
 * Honors errors-are-values: precondition violations are returned, not thrown.
 */
export type BoardResult = { ok: true; board: Board } | { ok: false; reason: string };

/**
 * Create a Board for a workspace. States and iterations start empty;
 * the orchestrator manages step progression via the journal, not the board state machine.
 */
export function initBoard(flowName: string, task: string, baseCommit: string): Board {
  const now = new Date().toISOString();
  return {
    base_commit: baseCommit,
    blocked: null,
    concerns: [],
    current_state: "init",
    entry: "init",
    flow: flowName,
    iterations: {},
    last_updated: now,
    skipped: [],
    started: now,
    states: {},
    task,
  };
}

/**
 * Enter a state — sets status to in_progress, increments entries, and
 * optionally increments iteration count.
 *
 * Precondition: state must not already be "done".
 * Returns BoardResult — callers must check result.ok before using result.board.
 */
export function enterState(board: Board, stateId: string): BoardResult {
  const now = new Date().toISOString();
  const prev = board.states[stateId];

  if (prev?.status === "done") {
    return { ok: false, reason: `State '${stateId}' is already done` };
  }

  const newStates = {
    ...board.states,
    [stateId]: {
      ...prev,
      entered_at: now,
      entries: (prev?.entries ?? 0) + 1,
      status: "in_progress" as const,
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
    board: {
      ...board,
      current_state: stateId,
      iterations: newIterations,
      last_updated: now,
      states: newStates,
    },
    ok: true,
  };
}

/**
 * Complete a state — sets status to done, records result and optional artifacts.
 *
 * Precondition: state must currently be "in_progress".
 * Returns BoardResult — callers must check result.ok before using result.board.
 */
export function completeState(
  board: Board,
  stateId: string,
  result: string,
  artifacts?: string[],
): BoardResult {
  const now = new Date().toISOString();
  const prev = board.states[stateId];

  if (prev?.status !== "in_progress") {
    return {
      ok: false,
      reason: `State '${stateId}' is not in_progress (current: ${prev?.status ?? "unknown"})`,
    };
  }

  const updated: Board["states"][string] = {
    ...prev,
    completed_at: now,
    result,
    status: "done" as const,
  };

  if (artifacts) {
    updated.artifacts = artifacts;
  }

  return {
    board: {
      ...board,
      last_updated: now,
      states: {
        ...board.states,
        [stateId]: updated,
      },
    },
    ok: true,
  };
}

/**
 * Mark a state as blocked.
 */
export function setBlocked(board: Board, stateId: string, reason: string): Board {
  const now = new Date().toISOString();

  return {
    ...board,
    blocked: { reason, since: now, state: stateId },
    last_updated: now,
    states: {
      ...board.states,
      [stateId]: {
        ...board.states[stateId],
        status: "blocked" as const,
      },
    },
  };
}

export type RecordConsultationOpts = {
  waveKey: string;
  breakpoint: "before" | "between" | "after";
  name: string;
  result: ConsultationResult;
};

/**
 * Record a consultation result into the board. Pure — returns a new Board.
 */
export function recordConsultationResult(
  board: Board,
  stateId: string,
  opts: RecordConsultationOpts,
): Board {
  const { waveKey, breakpoint, name, result } = opts;
  const stateEntry = board.states[stateId] ?? { entries: 0, status: "pending" as const };
  const waveResult = stateEntry.wave_results?.[waveKey] ?? { status: "in_progress", tasks: [] };
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

export type RecordGateOpts = {
  waveKey: string;
  gate: string;
  gateOutput: string;
};

/**
 * Record a gate result (gate name + output) into the board. Pure — returns a new Board.
 */
export function recordGateResult(board: Board, stateId: string, opts: RecordGateOpts): Board {
  const { waveKey, gate, gateOutput } = opts;
  const stateEntry = board.states[stateId] ?? { entries: 0, status: "pending" as const };
  const waveResult = stateEntry.wave_results?.[waveKey] ?? { status: "in_progress", tasks: [] };

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

/**
 * Check if a state can be entered based on iteration limits.
 * Moved from convergence.ts — belongs in the Board aggregate.
 */
export function canEnterState(
  board: Board,
  stateId: string,
): { allowed: boolean; reason?: string } {
  const iteration = board.iterations[stateId];
  if (!iteration) {
    return { allowed: true };
  }
  if (iteration.count >= iteration.max) {
    return {
      allowed: false,
      reason: `Max iterations (${iteration.max}) reached for state '${stateId}'`,
    };
  }
  return { allowed: true };
}

/**
 * Append a concern entry to board.concerns. Pure — returns a new Board.
 */
export function appendConcern(
  board: Board,
  stateId: string,
  agent: string,
  concernText: string,
): Board {
  const entry: ConcernEntry = {
    agent,
    message: concernText,
    state_id: stateId,
    timestamp: new Date().toISOString(),
  };
  return {
    ...board,
    concerns: [...board.concerns, entry],
  };
}

/**
 * Accumulate cannot_fix items into the board's iteration for a state.
 * Creates a cross-product of principleIds × filePaths, deduplicates against
 * existing items, and returns a new Board.
 */
export function accumulateCannotFix(
  board: Board,
  stateId: string,
  principleIds: string[],
  filePaths: string[],
): Board {
  if (!board.iterations[stateId]) return board;

  const iteration = board.iterations[stateId];
  const newItems: CannotFixItem[] = [];
  for (const principleId of principleIds) {
    for (const filePath of filePaths) {
      newItems.push({ file_path: filePath, principle_id: principleId });
    }
  }
  if (newItems.length === 0) return board;

  const existing = iteration.cannot_fix ?? [];
  const deduped = newItems.filter(
    (item) =>
      !existing.some((e) => e.principle_id === item.principle_id && e.file_path === item.file_path),
  );
  if (deduped.length === 0) return board;

  return {
    ...board,
    iterations: {
      ...board.iterations,
      [stateId]: { ...iteration, cannot_fix: [...existing, ...deduped] },
    },
  };
}
