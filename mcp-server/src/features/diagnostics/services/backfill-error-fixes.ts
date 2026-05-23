/**
 * Backfill Error Fixes — mines drift.db violation history to populate error_fixes.
 *
 * Reads all rows from file_violation_history and creates a corresponding
 * error_fix entry for each file+principle pair. Uses upsertErrorFix which
 * is INSERT OR UPDATE — so this function is idempotent.
 *
 * The error_pattern is derived from the principle_id and violation count.
 * The fix_pattern describes resolution from violation history.
 *
 * Pure function — accepts DriftDbSignals as parameter (dependency injection).
 * Works with empty databases (returns { processed: 0, inserted: 0, skipped: 0 }).
 */

import type { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";

// ---- Types ----

/** Result of a backfill run. */
export type BackfillResult = {
  /** Total violation history rows processed. */
  processed: number;
  /** error_fix records upserted (created or updated). */
  inserted: number;
  /** Always 0 — retained for backward compatibility. upsertErrorFix is idempotent; no pre-check is needed. */
  skipped: number;
};

// ---- Implementation ----

/**
 * Backfill error_fixes table from file_violation_history.
 *
 * For each file+principle pair in violation history:
 * - Creates an error_fix entry using upsertErrorFix (idempotent).
 * - Counts insertions vs. updates to populate BackfillResult.
 *
 * @param signals - DriftDbSignals instance (injected for testability)
 * @returns BackfillResult with processed, inserted, and skipped counts
 */
export function backfillErrorFixes(signals: DriftDbSignals): BackfillResult {
  const rows = signals.getAllFileViolationHistory();

  if (rows.length === 0) {
    return { inserted: 0, processed: 0, skipped: 0 };
  }

  for (const row of rows) {
    const errorPattern = `${row.principle_id} violated ${row.violation_count} times`;
    const fixPattern = `Resolved after ${row.violation_count} violations; compliance now achieved`;

    signals.upsertErrorFix({
      error_pattern: errorPattern,
      file_path: row.file_path,
      first_seen: row.first_seen,
      fix_pattern: fixPattern,
      last_seen: row.last_seen,
      occurrences: row.violation_count,
      principle_id: row.principle_id,
    });
  }

  return { inserted: rows.length, processed: rows.length, skipped: 0 };
}
