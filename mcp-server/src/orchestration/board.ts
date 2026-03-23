/**
 * Board CRUD operations using atomic writes.
 * All state-mutating functions return new Board objects (immutable pattern).
 */

import { readFile, copyFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import type { Board, ConsultationResult, ResolvedFlow } from "./flow-schema.js";
import { BoardSchema } from "./flow-schema.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

const BOARD_FILE = "board.json";
const BOARD_BACKUP = "board.json.bak";

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

/**
 * Read board.json from workspace. Falls back to board.json.bak if primary is
 * invalid or missing.
 */
export async function readBoard(workspace: string): Promise<Board> {
  const primaryPath = join(workspace, BOARD_FILE);
  const backupPath = join(workspace, BOARD_BACKUP);

  // Try primary
  try {
    const data = await readFile(primaryPath, "utf-8");
    return BoardSchema.parse(JSON.parse(data));
  } catch (err: any) {
    // Fall through to backup only for missing/corrupt files
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError) && !(err instanceof z.ZodError)) {
      throw err;
    }
  }

  try {
    const data = await readFile(backupPath, "utf-8");
    return BoardSchema.parse(JSON.parse(data));
  } catch (err: any) {
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError) && !(err instanceof z.ZodError)) {
      throw err;
    }
    throw new Error(
      `Failed to read board from ${primaryPath} or ${backupPath}`,
    );
  }
}

/**
 * Write board.json atomically, keeping a .bak copy of the previous version.
 */
export async function writeBoard(
  workspace: string,
  board: Board,
): Promise<void> {
  const primaryPath = join(workspace, BOARD_FILE);
  const backupPath = join(workspace, BOARD_BACKUP);

  // Copy current board.json to .bak (ignore if it doesn't exist yet)
  try {
    await copyFile(primaryPath, backupPath);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  const updated: Board = {
    ...board,
    last_updated: new Date().toISOString(),
  };

  await atomicWriteFile(primaryPath, JSON.stringify(updated, null, 2));
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
 * The caller is responsible for sequencing this with withBoardLock + writeBoard.
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
 * The caller is responsible for sequencing this with withBoardLock + writeBoard.
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
