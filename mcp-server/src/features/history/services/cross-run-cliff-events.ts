/**
 * Cliff events dimension computation — pure functions for analyzing cliff_detected trends.
 *
 * Extracted as a sibling-split from cross-run-analyzer.ts (the same pattern as
 * cross-run-craft-drift.ts) to keep each file under 600 lines.
 * All functions are pure — no I/O. Caller preloads CliffEventRow[] from the DAO.
 *
 * bounded-context-boundaries: imports only from @shared/*, @platform/* types,
 * and ../history-types.ts (directory invariant: "All cross-run-* functions are pure").
 *
 * Sparse-data contract (AC4):
 * - 0 rows   → status "no_data", confidence tier "insufficient"
 * - 1–4 rows → status "observed", tier "insufficient" (sample_size < 5)
 * - 5+ rows  → status "observed", tier per deriveTier(score, n)
 *
 * No rate fields are exposed — counts only. Fabricated rates are structurally impossible.
 */

import type {
  CliffEventRow,
  CliffRecoveryOutcome,
} from "@platform/storage/drift/cliff-events-dao.ts";
import { CLIFF_RECOVERY_OUTCOMES } from "@platform/storage/drift/cliff-events-dao.ts";
import { computeConfidenceAnnotation } from "@shared/lib/confidence.ts";
import type { CliffCountBucket, CliffEventsDimension } from "../history-types.ts";

// ---- Helpers ----

/**
 * Bucket rows by a string key extracted from each row.
 * null key values are mapped to "unknown".
 * Output is sorted by count desc, then key asc (deterministic).
 *
 * consistent-abstraction-levels: one helper for the three groupings.
 */
function bucketBy(
  rows: CliffEventRow[],
  keyFn: (row: CliffEventRow) => string | null,
): CliffCountBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row) ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const buckets: CliffCountBucket[] = [];
  for (const [key, count] of counts) {
    buckets.push({ count, key });
  }

  // Sort: count desc, then key asc for deterministic output
  buckets.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.key.localeCompare(b.key);
  });

  return buckets;
}

// ---- Public API ----

/**
 * Compute the cliff_events dimension from preloaded drift.db rows.
 *
 * Pure. Empty input → status "no_data" with zero-confidence annotation.
 * Never throws — define-errors-out-of-existence.
 *
 * @param rows - CliffEventRow records from CliffEventsDao.getAll()
 * @returns CliffEventsDimension with confidence annotation from the shared engine
 */
export function computeCliffEventsDimension(rows: CliffEventRow[]): CliffEventsDimension {
  // Initialize the all-four-keys recovery_outcomes record (define-errors-out-of-existence)
  const emptyOutcomes: Record<CliffRecoveryOutcome, number> = {
    abandoned: 0,
    recovered: 0,
    unknown: 0,
    unresolved: 0,
  };

  if (rows.length === 0) {
    return {
      by_agent_type: [],
      by_source: [],
      by_step_id: [],
      confidence: computeConfidenceAnnotation([]),
      recovery_outcomes: emptyOutcomes,
      status: "no_data",
      total_cliffs: 0,
      workspaces_affected: 0,
    };
  }

  // Aggregations
  const workspacesAffected = new Set(rows.map((r) => r.workspace_slug)).size;

  const by_agent_type = bucketBy(rows, (r) => r.agent_type);
  const by_step_id = bucketBy(rows, (r) => r.step_id);
  const by_source = bucketBy(rows, (r) => r.source);

  // Recovery outcomes — always all four keys (CLIFF_RECOVERY_OUTCOMES const)
  const recovery_outcomes = { ...emptyOutcomes };
  for (const row of rows) {
    // Only known outcomes are counted; DAO guarantees CliffRecoveryOutcome type
    recovery_outcomes[row.recovery_outcome] += 1;
  }

  // Confidence — shared engine only, no parallel implementation (decision D5)
  const confidence = computeConfidenceAnnotation([
    {
      detail: `${rows.length} cliff events across ${workspacesAffected} workspaces`,
      sample_size: rows.length,
      signal: "cliff_event_sample",
      value: 1, // direct observations, not inferences
      weight: 1,
    },
  ]);

  return {
    by_agent_type,
    by_source,
    by_step_id,
    confidence,
    recovery_outcomes,
    status: "observed",
    total_cliffs: rows.length,
    workspaces_affected: workspacesAffected,
  };
}

// Re-export CLIFF_RECOVERY_OUTCOMES for consumers that initialize default shapes
export { CLIFF_RECOVERY_OUTCOMES };
