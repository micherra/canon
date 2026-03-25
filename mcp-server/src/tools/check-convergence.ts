/**
 * MCP tool wrapper for convergence checking.
 * Determines whether a state can be re-entered based on iteration limits
 * and surfaces cannot-fix items and history.
 */

import { readBoard } from "../orchestration/board.ts";
import { canEnterState } from "../orchestration/convergence.ts";
import type { CannotFixItem, HistoryEntry } from "../orchestration/flow-schema.ts";

interface CheckConvergenceInput {
  workspace: string;
  state_id: string;
}

interface CheckConvergenceResult {
  can_enter: boolean;
  iteration_count: number;
  max_iterations: number;
  cannot_fix_items: CannotFixItem[];
  history: HistoryEntry[];
  reason?: string;
}

export async function checkConvergence(
  input: CheckConvergenceInput,
): Promise<CheckConvergenceResult> {
  const board = await readBoard(input.workspace);

  const { allowed, reason } = canEnterState(board, input.state_id);

  // Extract iteration data, defaulting to safe values if not tracked
  const iteration = board.iterations[input.state_id];

  const iteration_count = iteration?.count ?? 0;
  const max_iterations = iteration?.max ?? 0;
  const cannot_fix_items: CannotFixItem[] = iteration?.cannot_fix ?? [];
  const history: HistoryEntry[] = iteration?.history ?? [];

  return {
    can_enter: allowed,
    iteration_count,
    max_iterations,
    cannot_fix_items,
    history,
    reason,
  };
}
