/**
 * Board pure mutation helpers.
 * All state-mutating functions return new Board objects (immutable pattern).
 *
 * File I/O (readBoard, writeBoard) has been removed — use ExecutionStore (SQLite).
 */

import type { Board } from "@domains/flows/board-state-schemas.ts";

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
