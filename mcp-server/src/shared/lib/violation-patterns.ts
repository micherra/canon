/**
 * violation-patterns — pure functions for normalizing and grouping violations.
 *
 * Extracted from cross-run-analyzer.ts so the Signal Compiler can reuse the
 * same logic without creating a shared→features import (which would violate the
 * shared kernel invariant).
 *
 * All functions are pure: no I/O, no DB access.
 */

import type { ReviewEntry } from "@shared/schema.ts";

// ---- Exported types ----

/** Normalized violation record from any source (summary or drift.db). */
export type NormalizedViolation = {
  principleId: string;
  severity: string;
  filePath: string | null;
  reviewTimestamp: string;
};

/**
 * A violation that recurs across multiple runs.
 * Structurally identical to RecurringViolation in history-types.ts.
 * TypeScript structural typing ensures compatibility across the boundary.
 */
export type RecurringViolation = {
  principle_id: string;
  severity: string;
  occurrence_count: number;
  affected_files: string[];
  first_seen: string;
  last_seen: string;
};

// ---- Exported functions ----

/**
 * Collect violations from drift.db ReviewEntry records.
 * Returns a flat list of NormalizedViolation records.
 */
export function violationsFromReviews(reviews: ReviewEntry[]): NormalizedViolation[] {
  const result: NormalizedViolation[] = [];
  for (const review of reviews) {
    for (const violation of review.violations ?? []) {
      result.push({
        filePath: violation.file_path ?? null,
        principleId: violation.principle_id,
        reviewTimestamp: review.timestamp,
        severity: violation.severity,
      });
    }
  }
  return result;
}

/**
 * Group a flat list of NormalizedViolation records by principleId.
 */
export function groupViolationsByPrinciple(
  violations: NormalizedViolation[],
): Map<string, { severity: string; files: Set<string>; timestamps: string[] }> {
  const byPrinciple = new Map<
    string,
    { severity: string; files: Set<string>; timestamps: string[] }
  >();

  for (const v of violations) {
    const existing = byPrinciple.get(v.principleId);
    if (existing === undefined) {
      const files = new Set<string>();
      if (v.filePath !== null) files.add(v.filePath);
      byPrinciple.set(v.principleId, {
        files,
        severity: v.severity,
        timestamps: [v.reviewTimestamp],
      });
    } else {
      if (v.filePath !== null) existing.files.add(v.filePath);
      existing.timestamps.push(v.reviewTimestamp);
    }
  }

  return byPrinciple;
}

/**
 * Convert grouped violation data into RecurringViolation results,
 * filtering to principles with >= 2 occurrences, sorted by count DESC.
 */
export function buildRecurringViolationResults(
  byPrinciple: Map<string, { severity: string; files: Set<string>; timestamps: string[] }>,
): RecurringViolation[] {
  const result: RecurringViolation[] = [];
  for (const [principleId, data] of byPrinciple) {
    if (data.timestamps.length < 2) continue;
    const sortedTimestamps = [...data.timestamps].sort();
    result.push({
      affected_files: [...data.files],
      first_seen: sortedTimestamps[0],
      last_seen: sortedTimestamps[sortedTimestamps.length - 1],
      occurrence_count: data.timestamps.length,
      principle_id: principleId,
      severity: data.severity,
    });
  }
  result.sort((a, b) => b.occurrence_count - a.occurrence_count);
  return result;
}

/**
 * Find violations that recur across multiple runs (occurrence_count >= 2).
 *
 * Combines violations from run summaries (already normalized as NormalizedViolation[])
 * and drift.db reviews. Groups by principle_id, counts occurrences, and returns entries
 * sorted by occurrence_count descending.
 *
 * @param summaryViolations - Pre-normalized violations from run summaries
 * @param driftReviews - ReviewEntry records from drift.db
 */
export function findRecurringViolations(
  summaryViolations: NormalizedViolation[],
  driftReviews: ReviewEntry[],
): RecurringViolation[] {
  const allViolations = [...summaryViolations, ...violationsFromReviews(driftReviews)];
  const byPrinciple = groupViolationsByPrinciple(allViolations);
  return buildRecurringViolationResults(byPrinciple);
}

/**
 * Group violations by file path, counting per-principle occurrences per file.
 *
 * Used by the Signal Compiler to surface per-file violation history as context signals.
 * Violations with null filePath are skipped.
 *
 * @param violations - Flat list of NormalizedViolation records
 * @returns Map from file path to array of {principleId, severity, count}
 */
export function groupViolationsByFile(
  violations: NormalizedViolation[],
): Map<string, Array<{ principleId: string; severity: string; count: number }>> {
  // Intermediate: file -> principleId -> { severity, count }
  const intermediate = new Map<string, Map<string, { severity: string; count: number }>>();

  for (const v of violations) {
    if (v.filePath === null) continue;
    const byPrinciple = intermediate.get(v.filePath);
    if (byPrinciple === undefined) {
      intermediate.set(v.filePath, new Map([[v.principleId, { count: 1, severity: v.severity }]]));
    } else {
      const existing = byPrinciple.get(v.principleId);
      if (existing === undefined) {
        byPrinciple.set(v.principleId, { count: 1, severity: v.severity });
      } else {
        existing.count += 1;
      }
    }
  }

  // Convert to output shape
  const result = new Map<string, Array<{ principleId: string; severity: string; count: number }>>();
  for (const [filePath, byPrinciple] of intermediate) {
    result.set(
      filePath,
      [...byPrinciple.entries()].map(([principleId, { severity, count }]) => ({
        count,
        principleId,
        severity,
      })),
    );
  }
  return result;
}
