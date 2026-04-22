/**
 * board-sync — Shared utility for syncing a Board object back to ExecutionStore.
 *
 * Extracted from report-result.ts so that drive_flow can also call it without
 * duplicating logic. See ADR-009a (composition over inline).
 */

import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
/**
 * Result type for syncBoardToStore.
 *
 * errors-are-values: version conflicts return ok:false — never throw.
 */
export type SyncResult =
  | { ok: true; newVersion: number }
  | { ok: false; error: "version_conflict"; currentVersion: number };

/**
 * Sync a Board object back to the ExecutionStore after mutation.
 *
 * Wraps all writes in a single store.transaction() for atomicity.
 * Uses optimistic locking via updateExecutionVersioned — if expectedVersion
 * is stale, returns { ok: false, error: "version_conflict" } without writing.
 *
 * explicit-transaction-boundaries: all writes are inside one transaction.
 * errors-are-values: version conflict returned as typed result, never thrown.
 * fail-closed-by-default: stale writes are rejected, not silently applied.
 *
 * @param store       The ExecutionStore for this workspace.
 * @param board       The Board object to persist.
 * @param expectedVersion  If provided, only write when store version matches.
 *                        If omitted, reads the current version (read-then-write).
 */
export function syncBoardToStore(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  expectedVersion?: number,
): SyncResult {
  const version = expectedVersion ?? store.getVersion();

  return store.transaction((): SyncResult => {
    const versionResult = store.updateExecutionVersioned(
      {
        blocked: board.blocked,
        concerns: board.concerns,
        current_state: board.current_state,
        last_updated: board.last_updated,
        metadata: board.metadata,
        skipped: board.skipped,
      },
      version,
    );

    if (!versionResult.updated) {
      return {
        currentVersion: versionResult.currentVersion,
        error: "version_conflict" as const,
        ok: false as const,
      };
    }

    for (const [stateId, stateEntry] of Object.entries(board.states ?? {})) {
      store.upsertState(stateId, {
        ...stateEntry,
        entries: stateEntry.entries,
        status: stateEntry.status,
      });
    }
    for (const [stateId, iterEntry] of Object.entries(board.iterations ?? {})) {
      store.upsertIteration(stateId, {
        cannot_fix: iterEntry.cannot_fix,
        count: iterEntry.count,
        history: iterEntry.history,
        max: iterEntry.max,
      });
    }

    return { newVersion: versionResult.newVersion, ok: true as const };
  });
}
