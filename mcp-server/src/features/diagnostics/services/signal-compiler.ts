/**
 * Signal Compiler — Wave 1 read-only implementation with Wave 3 accuracy tuning.
 *
 * Reads aggregated signal data from drift.db via DriftDbSignals,
 * scores each signal by priority, and fits the results within a
 * per-file token budget.
 *
 * Wave 3: Optionally accepts AccuracyMap to apply priority multipliers and
 * prune violation_history signals for principles with very low accuracy.
 * Path effect signals are never pruned or tuned — they are file-level, not
 * principle-level.
 *
 * Pure computation — no writes to any table, no LLM calls.
 * One function, one responsibility (simplicity-first).
 */

import type {
  DriftDbSignals,
  FileViolationHistoryRow,
  PathEffectRow,
} from "@platform/storage/drift/drift-db-signals.ts";
import { fitWithinBudget } from "@shared/lib/token-budget.ts";
import type { AccuracyMap } from "./prediction-accuracy.ts";
import { getPriorityMultiplier, shouldPrune } from "./prediction-accuracy.ts";

// ---- Types ----

/** Discriminated kind for each signal entry. */
export type SignalType = "violation_history" | "path_effect" | "correction";

/** A single learning signal for an agent context block. */
export type Signal = {
  type: SignalType;
  priority: number;
  text: string;
};

/** Compiled signals for one file path. */
export type FileSignals = {
  file_path: string;
  signals: Signal[];
};

/** Options for compileSignals. */
export type CompileSignalsOptions = {
  /** Max tokens per file for signal text (default: 500). */
  tokenBudgetPerFile?: number;
  /** Per-principle accuracy data for weight tuning and pruning. */
  accuracyData?: AccuracyMap;
};

// ---- Priority scoring ----

/**
 * Score a violation history entry for priority ranking.
 * Higher score = shown first in agent context.
 *
 * Factors:
 * - violation_count: more frequent = higher priority (capped at 10 to prevent
 *   outlier dominance)
 * - recency: violations seen in the last 7 days get a +3 recency boost
 */
export function scoreViolationHistory(row: FileViolationHistoryRow): number {
  const base = Math.min(row.violation_count, 10);
  const lastSeen = new Date(row.last_seen).getTime();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recencyBoost = lastSeen > sevenDaysAgo ? 3 : 0;
  return base + recencyBoost;
}

/**
 * Score a path effect entry for priority ranking.
 * Files with high violation_streak or many total_violations rank higher.
 *
 * Formula: streak * 2 + min(total_violations, 5)
 */
export function scorePathEffect(row: PathEffectRow): number {
  const streakScore = row.violation_streak * 2;
  const volumeScore = Math.min(row.total_violations, 5);
  return streakScore + volumeScore;
}

// ---- Signal text formatting ----

function formatViolationHistorySignal(row: FileViolationHistoryRow): string {
  return `Principle "${row.principle_id}" has been violated ${row.violation_count} time(s) in this file. Last seen: ${row.last_seen}. First seen: ${row.first_seen}.`;
}

function formatPathEffectSignal(row: PathEffectRow): string {
  const parts: string[] = [];
  parts.push(`Reviewed ${row.total_reviews} time(s) with ${row.total_violations} violation(s).`);
  if (row.violation_streak > 0) {
    parts.push(`Current violation streak: ${row.violation_streak}.`);
  }
  if (row.clean_streak > 0) {
    parts.push(`Current clean streak: ${row.clean_streak}.`);
  }
  if (row.last_violation_at) {
    parts.push(`Last violation: ${row.last_violation_at}.`);
  }
  return parts.join(" ");
}

// ---- Signal collection helpers ----

/**
 * Compute the accuracy-adjusted priority for a violation history row.
 * Returns null when the signal should be pruned (skipped entirely).
 */
function computeViolationPriority(
  row: FileViolationHistoryRow,
  accuracyData: AccuracyMap | undefined,
): number | null {
  const accuracy = accuracyData?.get(row.principle_id);
  if (accuracy && shouldPrune(accuracy)) {
    return null;
  }
  const base = scoreViolationHistory(row);
  if (accuracy) {
    return Math.round(base * getPriorityMultiplier(accuracy));
  }
  return base;
}

// ---- Main compiler function ----

/**
 * Compile learning signals for a set of file paths.
 *
 * Reads from:
 * - file_violation_history table (via DriftDbSignals)
 * - path_effects table (via DriftDbSignals)
 *
 * Produces prioritized signal text within token budget per file.
 * Read-only in Wave 1 — no writes to any table.
 *
 * @returns FileSignals[] with one entry per input file path.
 *   Files with no data produce an entry with an empty signals array.
 *   Returns an empty array when filePaths is empty.
 */
export function compileSignals(
  filePaths: string[],
  driftDbSignals: DriftDbSignals,
  options?: CompileSignalsOptions,
): FileSignals[] {
  if (filePaths.length === 0) return [];

  const budget = options?.tokenBudgetPerFile ?? 500;
  const results: FileSignals[] = [];

  for (const filePath of filePaths) {
    const candidates: Signal[] = [];

    // Collect violation history signals (with optional accuracy-based tuning/pruning)
    const violationRows = driftDbSignals.getFileViolationHistory([filePath]);
    for (const row of violationRows) {
      const priority = computeViolationPriority(row, options?.accuracyData);
      if (priority === null) continue; // Pruned: skip this principle
      candidates.push({
        priority,
        text: formatViolationHistorySignal(row),
        type: "violation_history",
      });
    }

    // Collect path effect signals
    const pathEffectRows = driftDbSignals.getPathEffects([filePath]);
    for (const row of pathEffectRows) {
      candidates.push({
        priority: scorePathEffect(row),
        text: formatPathEffectSignal(row),
        type: "path_effect",
      });
    }

    // Fit within token budget (sorted by priority DESC by fitWithinBudget)
    const fitted = fitWithinBudget(candidates, budget);

    results.push({ file_path: filePath, signals: fitted });
  }

  return results;
}
