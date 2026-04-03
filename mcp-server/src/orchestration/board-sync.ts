/**
 * board-sync — Shared utility for syncing a Board object back to ExecutionStore.
 *
 * Extracted from report-result.ts so that drive_flow can also call it without
 * duplicating logic. See ADR dd-009-01 (composition over inline).
 */

import { getExecutionStore } from './execution-store.ts';
import type { Board } from './flow-schema.ts';

/**
 * Sync a Board object back to the ExecutionStore after mutation.
 * Updates execution-level fields, states, and iterations.
 */
export function syncBoardToStore(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
): void {
  store.updateExecution({
    current_state: board.current_state,
    blocked: board.blocked,
    concerns: board.concerns,
    skipped: board.skipped,
    metadata: board.metadata,
    last_updated: board.last_updated,
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, { ...stateEntry, status: stateEntry.status, entries: stateEntry.entries });
  }
  for (const [stateId, iterEntry] of Object.entries(board.iterations)) {
    store.upsertIteration(stateId, {
      count: iterEntry.count,
      max: iterEntry.max,
      history: iterEntry.history,
      cannot_fix: iterEntry.cannot_fix,
    });
  }
}
