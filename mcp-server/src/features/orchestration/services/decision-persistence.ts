/**
 * decision-persistence — fail-open mirror of a workspace's decision events
 * into the durable project-level drift.db `orchestrator_decisions` table.
 *
 * Called by the janitor immediately BEFORE `rmSync` deletes a workspace's
 * orchestration.db — the sole destruction boundary (ADR-0038; finalize is
 * copy-only, ADR-0016). Deliberately fail-open: a persist failure must never
 * block a reap (janitor is best-effort housekeeping) — but it must be
 * observable (console.warn), never a silent swallow (observable-best-effort;
 * the top-live-violation principle in scope for this build).
 *
 * The `fail-closed-by-default` authoritative `log_decision` write
 * (decisions-ledger.ts) is untouched — this is a separate, deliberately
 * fail-open seam.
 */

import type { DriftDb } from "@platform/storage/drift/drift-db.ts";
import { readDecisionEvents } from "@shared/lib/decision-event-reader.ts";

/**
 * Read a workspace's `orchestrator_decision` events from its (soon-to-be-deleted)
 * orchestration.db and persist them into the durable `orchestrator_decisions`
 * table, keyed by slug.
 *
 * Fail-open: any error (read or persist) is caught and reported via
 * `console.warn`, never rethrown — a persist failure must not block the
 * janitor's subsequent `rmSync`. `readDecisionEvents` itself never throws
 * (it degrades to `[]`); the try/catch here exists for the DAO persist call.
 */
export function tryPersistDecisionsBeforeReap(
  orchestrationDbPath: string,
  slug: string,
  drift: DriftDb,
): void {
  try {
    const records = readDecisionEvents(orchestrationDbPath);
    if (records.length > 0) {
      drift.getOrchestratorDecisions().persistMany(slug, records);
    }
  } catch (err: unknown) {
    console.warn(
      `[canon] janitor: decision persist failed for ${slug}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
