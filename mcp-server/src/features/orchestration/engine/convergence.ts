/**
 * Pure functions for convergence checking.
 */

import type { CannotFixItem } from "@domains/flows/board-state-schemas.ts";

/**
 * Filter out items that match any entry in the cannotFixList.
 */
export function filterCannotFix(
  items: CannotFixItem[],
  cannotFixList: CannotFixItem[],
): CannotFixItem[] {
  return items.filter(
    (item) =>
      !cannotFixList.some(
        (entry) => entry.principle_id === item.principle_id && entry.file_path === item.file_path,
      ),
  );
}
