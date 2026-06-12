/**
 * Pitfall Enrichment Service — Feed-forward pitfall context for agent prompts.
 *
 * Queries drift.db for historical violation patterns and error→fix pairs,
 * formats them into a structured markdown section for agent context injection.
 *
 * Pure functions: no side effects, no DB initialization, no LLM calls.
 * Accepts DriftDbSignals as a parameter (dependency injection).
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty arrays produce empty string (no error states)
 * - simplicity-first: three small, focused functions — query drift, query errors, format
 * - no-llm-calls-in-mcp-tools: all computation is deterministic
 */

import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type {
  DriftDbSignals,
  ErrorFixRow,
  FileViolationHistoryRow,
} from "@platform/storage/drift/drift-db-signals.ts";

// ---- Types ----

/**
 * A condensed pitfall derived from file_violation_history.
 * Represents a principle that has been repeatedly violated in a file.
 */
export type DriftPitfall = {
  file_path: string;
  principle_id: string;
  violation_count: number;
  last_seen: string;
};

/**
 * A condensed pitfall derived from the error_fixes table.
 * Represents a known error→fix pair observed in a file.
 */
export type ErrorFixPitfall = {
  file_path: string;
  principle_id: string;
  error_pattern: string;
  fix_pattern: string;
  occurrences: number;
};

// ---- Confidence threshold ----

/** Minimum violation count to surface a drift pitfall (noise filter). */
const MIN_VIOLATION_COUNT = 2;

/** Maximum number of pitfalls to surface per category. */
const MAX_PITFALLS = 5;

// ---- Query functions ----

/**
 * Query drift signal pitfalls from file_violation_history.
 *
 * Filters out low-confidence entries (violation_count < 2),
 * sorts by violation_count DESC with file_path ASC for ties,
 * and caps at 5 entries.
 *
 * Returns empty array when filePaths is empty or no qualifying rows exist.
 */
export function queryDriftSignalPitfalls(
  filePaths: string[],
  driftDbSignals: DriftDbSignals,
): DriftPitfall[] {
  if (filePaths.length === 0) return [];

  const rows: FileViolationHistoryRow[] = driftDbSignals.getFileViolationHistory(filePaths);

  const filtered = rows.filter((row) => row.violation_count >= MIN_VIOLATION_COUNT);

  // Sort by violation_count DESC, then file_path ASC for deterministic ties
  filtered.sort((a, b) => {
    const countDiff = b.violation_count - a.violation_count;
    if (countDiff !== 0) return countDiff;
    return a.file_path.localeCompare(b.file_path);
  });

  return filtered.slice(0, MAX_PITFALLS).map((row) => ({
    file_path: row.file_path,
    last_seen: row.last_seen,
    principle_id: row.principle_id,
    violation_count: row.violation_count,
  }));
}

/**
 * Query error→fix pitfalls from the error_fixes table.
 *
 * Sorts by occurrences DESC with file_path ASC for ties,
 * and caps at 5 entries.
 *
 * Returns empty array when filePaths is empty or no rows exist.
 */
export function queryErrorFixPitfalls(
  filePaths: string[],
  driftDbSignals: DriftDbSignals,
): ErrorFixPitfall[] {
  if (filePaths.length === 0) return [];

  const rows: ErrorFixRow[] = driftDbSignals.getErrorFixes(filePaths);

  // Sort by occurrences DESC, then file_path ASC for deterministic ties
  const sorted = [...rows].sort((a, b) => {
    const occDiff = b.occurrences - a.occurrences;
    if (occDiff !== 0) return occDiff;
    return a.file_path.localeCompare(b.file_path);
  });

  return sorted.slice(0, MAX_PITFALLS).map((row) => ({
    error_pattern: row.error_pattern,
    file_path: row.file_path,
    fix_pattern: row.fix_pattern,
    occurrences: row.occurrences,
    principle_id: row.principle_id,
  }));
}

// ---- Count function ----

/**
 * Count total pitfalls from both drift and error-fix arrays.
 *
 * Returns the sum of driftPitfalls.length and errorFixPitfalls.length.
 * Avoids coupling the count to any markdown format.
 */
export function countPitfalls(
  driftPitfalls: DriftPitfall[],
  errorFixPitfalls: ErrorFixPitfall[],
): number {
  return driftPitfalls.length + errorFixPitfalls.length;
}

// ---- Formatting function ----

/**
 * Format drift and error-fix pitfalls into a structured markdown section.
 *
 * Returns empty string when both arrays are empty (define-errors-out-of-existence).
 * Sections are omitted when their respective arrays are empty.
 *
 * Output format:
 * ```
 * ## Known Pitfalls
 *
 * The following area-specific pitfalls have been observed in prior builds. Avoid these patterns:
 *
 * ### Drift Signals (violation history)
 *
 * - **{file_path}** — Principle `{principle_id}` violated {N} times (last: {date})
 *
 * ### Prior Error→Fix Pairs
 *
 * - **{file_path}** — {error_pattern}. Fix: {fix_pattern} (seen {N} times)
 * ```
 */
/**
 * Build pitfalls section by querying drift.db for historical violations and error-fix pairs.
 * Fail-open: returns empty section and zero count on any error so enrichment never blocks spawn.
 */
export function buildPitfallsSection(
  filePaths: string[],
  projectDir: string,
): { section: string; count: number } {
  if (filePaths.length === 0) return { count: 0, section: "" };
  try {
    const driftDbSignals = getDriftDb(projectDir).getSignals();
    const driftPitfalls = queryDriftSignalPitfalls(filePaths, driftDbSignals);
    const errorFixPitfalls = queryErrorFixPitfalls(filePaths, driftDbSignals);
    return {
      count: countPitfalls(driftPitfalls, errorFixPitfalls),
      section: formatPitfallsSection(driftPitfalls, errorFixPitfalls),
    };
  } catch (err) {
    console.warn(
      "[pitfall-enrichment] buildPitfallsSection failed:",
      err instanceof Error ? err.message : err,
    );
    return { count: 0, section: "" };
  }
}

export function formatPitfallsSection(
  driftPitfalls: DriftPitfall[],
  errorFixPitfalls: ErrorFixPitfall[],
): string {
  if (driftPitfalls.length === 0 && errorFixPitfalls.length === 0) return "";

  const lines: string[] = [
    "## Known Pitfalls",
    "",
    "The following area-specific pitfalls have been observed in prior builds. Avoid these patterns:",
  ];

  if (driftPitfalls.length > 0) {
    lines.push("");
    lines.push("### Drift Signals (violation history)");
    lines.push("");
    for (const pitfall of driftPitfalls) {
      lines.push(
        `- **${pitfall.file_path}** — Principle \`${pitfall.principle_id}\` violated ${pitfall.violation_count} times (last: ${pitfall.last_seen})`,
      );
    }
  }

  if (errorFixPitfalls.length > 0) {
    lines.push("");
    lines.push("### Prior Error→Fix Pairs");
    lines.push("");
    for (const pitfall of errorFixPitfalls) {
      lines.push(
        `- **${pitfall.file_path}** — ${pitfall.error_pattern}. Fix: ${pitfall.fix_pattern} (seen ${pitfall.occurrences} times)`,
      );
    }
  }

  return lines.join("\n");
}
