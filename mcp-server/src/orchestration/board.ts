/**
 * Board pure mutation helpers.
 * All state-mutating functions return new Board objects (immutable pattern).
 *
 * File I/O (readBoard, writeBoard) has been removed — use ExecutionStore (SQLite).
 */

import type { Board, ConsultationResult, ResolvedFlow } from "./flow-schema.ts";

/**
 * Create a new Board from a resolved flow.
 */
export function initBoard(flow: ResolvedFlow, task: string, baseCommit: string): Board {
  const now = new Date().toISOString();

  const states: Board["states"] = {};
  const iterations: Board["iterations"] = {};

  for (const [key, stateDef] of Object.entries(flow.states)) {
    states[key] = { entries: 0, status: "pending" };

    // max_revisions (ADR-017) takes precedence over max_iterations for revision budget
    const maxIter = stateDef.max_revisions ?? stateDef.max_iterations;
    if (maxIter !== undefined) {
      iterations[key] = {
        cannot_fix: [],
        count: 0,
        history: [],
        max: maxIter,
      };
    } else if (stateDef.approval_gate === true && stateDef.type !== "terminal") {
      // Default revision budget for explicitly gated states without explicit limit
      iterations[key] = {
        cannot_fix: [],
        count: 0,
        history: [],
        max: 3,
      };
    }
  }

  return {
    base_commit: baseCommit,
    blocked: null,
    concerns: [],
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    iterations,
    last_updated: now,
    skipped: [],
    started: now,
    states,
    task,
  };
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
    ...board,
    current_state: stateId,
    iterations: newIterations,
    last_updated: now,
    states: newStates,
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
    completed_at: now,
    result,
    status: "done" as const,
  };

  if (artifacts) {
    updated.artifacts = artifacts;
  }

  return {
    ...board,
    last_updated: now,
    states: {
      ...board.states,
      [stateId]: updated,
    },
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
