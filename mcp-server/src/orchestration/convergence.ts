/**
 * Pure functions for convergence checking.
 */

import type { Board, CannotFixItem } from "./flow-schema.ts";

/**
 * Check if a state can be entered based on iteration limits.
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
 * Filter out items that match any entry in the cannotFixList.
 */
export function filterCannotFix(
  items: CannotFixItem[],
  cannotFixList: CannotFixItem[],
): CannotFixItem[] {
  return items.filter((item) =>
    !cannotFixList.some(
      (entry) =>
        entry.principle_id === item.principle_id &&
        entry.file_path === item.file_path,
    ),
  );
}
