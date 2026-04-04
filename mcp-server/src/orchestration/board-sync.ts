/**
 * board-sync — Shared utility for syncing a Board object back to ExecutionStore.
 *
 * Extracted from report-result.ts so that drive_flow can also call it without
 * duplicating logic. See ADR-009a (composition over inline).
 */

import type { getExecutionStore } from "./execution-store.ts";
import type { Board } from "./flow-schema.ts";

/**
 * Sync a Board object back to the ExecutionStore after mutation.
 * Updates execution-level fields, states, and iterations.
 */
export function syncBoardToStore(store: ReturnType<typeof getExecutionStore>, board: Board): void {
  store.updateExecution({
    blocked: board.blocked,
    concerns: board.concerns,
    current_state: board.current_state,
    last_updated: board.last_updated,
    metadata: board.metadata,
    skipped: board.skipped,
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, {
      ...stateEntry,
      entries: stateEntry.entries,
      status: stateEntry.status,
    });
  }
  for (const [stateId, iterEntry] of Object.entries(board.iterations)) {
    store.upsertIteration(stateId, {
      cannot_fix: iterEntry.cannot_fix,
      count: iterEntry.count,
      history: iterEntry.history,
      max: iterEntry.max,
    });
  }
}
