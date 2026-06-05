/**
 * Cross-run analyzer — pure computation service for learner meta-analysis.
 *
 * Analyzes data from run summaries and drift.db to produce cross-run patterns:
 * recurring violations, fix cycle patterns, agent performance trends,
 * and planner pattern analysis.
 *
 * bounded-context-boundaries: imports only from shared kernel types and the
 * history-types bounded context. No cross-feature imports.
 */

import type { CraftProfileRow } from "@platform/storage/drift/craft-profile-dao.ts";
import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import type { DriftDb } from "@platform/storage/drift/drift-db.ts";
import type { NormalizedViolation } from "@shared/lib/violation-patterns.ts";
import { findRecurringViolations } from "@shared/lib/violation-patterns.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import type {
  CrossRunAnalysisResult,
  FixCyclePattern,
  RecurringViolation,
  RunSummary,
} from "../history-types.ts";
import { computeCraftDrift } from "./cross-run-craft-drift.ts";
import { analyzePlannerPatterns, computePerformanceTrends } from "./cross-run-patterns.ts";
import { computeOutcomeWeight, type OutcomeSignals } from "./judge-weight.ts";

// ---- Helpers ----

/**
 * Collect violations from run summaries' review_results arrays.
 * Returns a flat list of NormalizedViolation records.
 */
function violationsFromSummaries(summaries: RunSummary[]): NormalizedViolation[] {
  const result: NormalizedViolation[] = [];
  for (const summary of summaries) {
    for (const reviewResult of summary.review_results) {
      for (const violation of reviewResult.violations) {
        result.push({
          filePath: violation.file_path ?? null,
          principleId: violation.principle_id,
          reviewTimestamp: summary.run_metadata.completed_at ?? summary.run_metadata.archived_at,
          severity: violation.severity,
        });
      }
    }
  }
  return result;
}

/**
 * Compute the earliest and latest timestamps across a set of ISO-8601 strings.
 * Returns null when the array is empty.
 */
function computeTimeRange(
  timestamps: (string | null | undefined)[],
): { from: string; to: string } | null {
  const valid = timestamps.filter((t): t is string => typeof t === "string" && t.length > 0);
  if (valid.length === 0) return null;
  valid.sort();
  return { from: valid[0], to: valid[valid.length - 1] };
}

// Internal snapshot type for fix cycle analysis
type ReviewSnapshot = { timestamp: string; violatedPrinciples: Set<string> };

/**
 * Build a sorted timeline of review snapshots (timestamp → set of violated principle IDs).
 * Merges drift reviews and summary violations.
 */
function buildReviewSnapshots(
  summaryViolations: NormalizedViolation[],
  driftReviews: ReviewEntry[],
): ReviewSnapshot[] {
  const snapshots: ReviewSnapshot[] = [];

  for (const review of driftReviews) {
    const violated = new Set<string>();
    for (const v of review.violations ?? []) {
      violated.add(v.principle_id);
    }
    snapshots.push({ timestamp: review.timestamp, violatedPrinciples: violated });
  }

  const summaryByTimestamp = new Map<string, Set<string>>();
  for (const v of summaryViolations) {
    const existing = summaryByTimestamp.get(v.reviewTimestamp);
    if (existing === undefined) {
      summaryByTimestamp.set(v.reviewTimestamp, new Set([v.principleId]));
    } else {
      existing.add(v.principleId);
    }
  }
  for (const [timestamp, principles] of summaryByTimestamp) {
    snapshots.push({ timestamp, violatedPrinciples: principles });
  }

  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return snapshots;
}

/**
 * Compute a FixCyclePattern for a single principleId across a sorted snapshot timeline.
 * Returns null when no fixes were detected.
 */
function computeFixCycleForPrinciple(
  principleId: string,
  snapshots: ReviewSnapshot[],
): FixCyclePattern | null {
  const timeline = snapshots.map((s) => ({
    present: s.violatedPrinciples.has(principleId),
    timestamp: s.timestamp,
  }));

  let fixCount = 0;
  let reappearanceCount = 0;
  const fixDurationsMs: number[] = [];
  let lastFixTimestamp: string | null = null;

  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1];
    const curr = timeline[i];

    if (prev.present && !curr.present) {
      fixCount++;
      lastFixTimestamp = curr.timestamp;
    } else if (!prev.present && curr.present && lastFixTimestamp !== null) {
      reappearanceCount++;
      const fixMs = new Date(curr.timestamp).getTime() - new Date(lastFixTimestamp).getTime();
      if (fixMs > 0) fixDurationsMs.push(fixMs);
      lastFixTimestamp = null;
    }
  }

  if (fixCount === 0) return null;

  const avgFixDurationMs =
    fixDurationsMs.length > 0
      ? fixDurationsMs.reduce((sum, d) => sum + d, 0) / fixDurationsMs.length
      : 0;

  return {
    avg_fix_duration_ms: avgFixDurationMs,
    fix_count: fixCount,
    principle_id: principleId,
    recurrence_rate: reappearanceCount / fixCount,
  };
}

/**
 * Compute fix cycle patterns for recurring violations.
 *
 * For each recurring principle_id, finds sequences where the violation appears,
 * disappears (fixed), and reappears. Computes recurrence_rate and avg_fix_duration_ms.
 *
 * A "fix" is detected when the violation is absent from a review that follows one
 * where it was present. A "reappearance" is when it shows up again after a fix.
 *
 * @param summaryViolations - Violations from run summaries
 * @param driftReviews - All ReviewEntry records from drift.db
 */
function computeFixCyclePatterns(
  summaryViolations: NormalizedViolation[],
  driftReviews: ReviewEntry[],
): FixCyclePattern[] {
  const snapshots = buildReviewSnapshots(summaryViolations, driftReviews);
  if (snapshots.length < 2) return [];

  const recurringIds = new Set(
    findRecurringViolations(summaryViolations, driftReviews).map((v) => v.principle_id),
  );

  const result: FixCyclePattern[] = [];

  for (const principleId of recurringIds) {
    const pattern = computeFixCycleForPrinciple(principleId, snapshots);
    if (pattern !== null) result.push(pattern);
  }

  return result;
}

// ---- Outcome weighting helpers ----

/**
 * Map a RunSummary (and optional matching FlowRunEntry) to OutcomeSignals for
 * a specific principle_id.
 *
 * Pure — operates only on already-loaded data, no I/O.
 * - review_verdict: from the review_result that contains a violation for
 *   principleId. If multiple reviews hold the violation, we pick the one with
 *   the worst verdict (BLOCKING > WARNING > CLEAN/approve) — deterministic and
 *   conservative (avoids rewarding quality from the wrong review). Falls back to
 *   the first review when principleId is absent from all reviews (e.g. drift-only
 *   violations passed through without a matching summary).
 * - test_pass_rate: derived from matchingRun.total_test_results when present.
 * - fix_iterations: total retries across all states from
 *   matchingRun.state_iterations (sum of values). Absent when no matchingRun.
 *
 * @param summary - RunSummary for the build instance.
 * @param principleId - The principle whose violation we are weighting.
 * @param matchingRun - Optional FlowRunEntry for the same build (same flow+started key).
 */
export function summaryToOutcomeSignals(
  summary: RunSummary,
  principleId: string,
  matchingRun?: FlowRunEntry,
): OutcomeSignals {
  // review_verdict: find the review_result that contains this principleId.
  // If multiple reviews contain it, pick the worst (most penalizing) verdict.
  // Verdict severity order (worst first): blocking > warning > clean/approve/other.
  const VERDICT_SEVERITY: Record<string, number> = {
    approve: 1,
    blocking: 3,
    clean: 1,
    warning: 2,
  };
  const verdictSeverity = (v: string): number => VERDICT_SEVERITY[v.toLowerCase().trim()] ?? 0;

  let review_verdict: string | undefined;
  const matchingReviews = summary.review_results.filter((r) =>
    r.violations.some((v) => v.principle_id === principleId),
  );
  if (matchingReviews.length > 0) {
    // Pick the worst verdict among reviews that hold this violation
    review_verdict = matchingReviews.reduce((worst, r) =>
      verdictSeverity(r.verdict) > verdictSeverity(worst.verdict) ? r : worst,
    ).verdict;
  } else {
    // Fallback: no review contains this principleId — use first review if available
    review_verdict = summary.review_results[0]?.verdict;
  }

  // test_pass_rate: from FlowRunEntry.total_test_results
  let test_pass_rate: number | undefined;
  if (matchingRun?.total_test_results !== undefined) {
    const { failed, passed, skipped } = matchingRun.total_test_results;
    const total = passed + failed + skipped;
    test_pass_rate = total > 0 ? passed / total : undefined;
  }

  // fix_iterations: total retries across all states from state_iterations.
  // state_iterations is a Record<string, number> where each value is the
  // number of extra iterations for that state (0 = ran once, 1 = retried once).
  // We sum all values to get total rework across the build.
  let fix_iterations: number | undefined;
  if (matchingRun?.state_iterations !== undefined) {
    const total = Object.values(matchingRun.state_iterations).reduce((sum, n) => sum + n, 0);
    fix_iterations = total > 0 ? total : undefined;
  }

  return { fix_iterations, review_verdict, test_pass_rate };
}

/**
 * Compute the sum of outcome weights across a set of OutcomeSignals observations.
 * Σ computeOutcomeWeight(obs) for each observation.
 *
 * Pure — no I/O. Empty array → 0.
 */
export function weightedInstanceCount(observations: OutcomeSignals[]): number {
  return observations.reduce((sum, obs) => sum + computeOutcomeWeight(obs), 0);
}

/**
 * Build a lookup from (flow + started) key → FlowRunEntry for dedup-free join.
 * Used to enrich summary observations with FlowRunEntry test results.
 */
function buildRunLookup(runs: FlowRunEntry[]): Map<string, FlowRunEntry> {
  const lookup = new Map<string, FlowRunEntry>();
  for (const run of runs) {
    lookup.set(`${run.flow}\0${run.started}`, run);
  }
  return lookup;
}

/**
 * Register a summary under each principle_id it violates (deduplicates by identity).
 */
function indexSummaryByPrinciples(
  index: Map<string, RunSummary[]>,
  summary: RunSummary,
  principleIds: string[],
): void {
  for (const pid of principleIds) {
    const existing = index.get(pid);
    if (existing === undefined) {
      index.set(pid, [summary]);
    } else if (!existing.includes(summary)) {
      existing.push(summary);
    }
  }
}

/**
 * Build an index from principle_id → unique RunSummary entries that contain
 * a review result violation for that principle.
 */
function buildPrincipleToSummaries(summaries: RunSummary[]): Map<string, RunSummary[]> {
  const index = new Map<string, RunSummary[]>();
  for (const summary of summaries) {
    const pids = summary.review_results.flatMap((r) => r.violations.map((v) => v.principle_id));
    indexSummaryByPrinciples(index, summary, pids);
  }
  return index;
}

/**
 * Compute the weighted_instance_count for a single violation given its matching summaries.
 * Passes principleId to summaryToOutcomeSignals so it picks the correct review_result.
 */
function computeWeightedCount(
  v: RecurringViolation,
  matchingSummaries: RunSummary[],
  runLookup: Map<string, FlowRunEntry>,
): number {
  if (matchingSummaries.length === 0) {
    return v.occurrence_count * 1.0;
  }
  const observations: OutcomeSignals[] = matchingSummaries.map((s) => {
    const key = `${s.run_metadata.flow}\0${s.run_metadata.started_at ?? s.run_metadata.archived_at}`;
    return summaryToOutcomeSignals(s, v.principle_id, runLookup.get(key));
  });
  const uncoveredCount = v.occurrence_count - matchingSummaries.length;
  for (let i = 0; i < uncoveredCount; i++) {
    observations.push({});
  }
  return weightedInstanceCount(observations);
}

/**
 * Enrich recurring violations with weighted_instance_count.
 *
 * For each recurring violation, collects all summaries that contain a matching
 * review result for the principle_id, maps each to OutcomeSignals, and sums
 * computeOutcomeWeight. Drift-only violations (no matching summary) default
 * to neutral-weight per raw count (Σ 1.0 per occurrence).
 *
 * Neutral fallback preserves backward-compatibility: patterns with no summary
 * data get weighted_instance_count === occurrence_count (same as raw count).
 */
function enrichWithWeightedCounts(
  violations: RecurringViolation[],
  summaries: RunSummary[],
  runLookup: Map<string, FlowRunEntry>,
): RecurringViolation[] {
  const principleToSummaries = buildPrincipleToSummaries(summaries);
  return violations.map((v) => {
    const matchingSummaries = principleToSummaries.get(v.principle_id) ?? [];
    return { ...v, weighted_instance_count: computeWeightedCount(v, matchingSummaries, runLookup) };
  });
}

// ---- Analysis input loading helpers ----

/**
 * Load craft profiles from drift.db, applying optional filters.
 * Degrades gracefully when the craft-profile store is unavailable.
 */
function loadCraftProfiles(
  driftDb: DriftDb,
  options: { since?: string; limit?: number },
): CraftProfileRow[] {
  const { since, limit } = options;
  let craftProfiles: CraftProfileRow[] = [];
  try {
    if (typeof (driftDb as { getCraftProfiles?: unknown }).getCraftProfiles === "function") {
      craftProfiles = (
        driftDb as unknown as {
          getCraftProfiles(): { getRecentProfiles(n: number): CraftProfileRow[] };
        }
      )
        .getCraftProfiles()
        .getRecentProfiles(limit ?? 200);
    }
  } catch {
    // craft-profile store unavailable — craft_drift will be the empty result
  }
  if (since !== undefined) {
    craftProfiles = craftProfiles.filter((p) => p.created_at >= since);
  }
  return craftProfiles;
}

/**
 * Compute the analysis window from all available timestamps in the data set.
 * Falls back to the current instant when no timestamps are present.
 */
function computeAnalysisWindow(
  allReviews: ReviewEntry[],
  allFlowRuns: FlowRunEntry[],
  summaries: RunSummary[],
): { from: string; to: string } {
  const allTimestamps: (string | null | undefined)[] = [
    ...allReviews.map((r) => r.timestamp),
    ...allFlowRuns.map((r) => r.started),
    ...allFlowRuns.map((r) => r.completed),
    ...summaries.map((s) => s.run_metadata.started_at),
    ...summaries.map((s) => s.run_metadata.completed_at),
    ...summaries.map((s) => s.run_metadata.archived_at),
  ];
  return (
    computeTimeRange(allTimestamps) ?? {
      from: new Date().toISOString(),
      to: new Date().toISOString(),
    }
  );
}

/**
 * Analyze cross-run patterns by integrating all sub-analyses.
 *
 * This is the primary entry point for the learner agent's meta-analysis.
 * It combines recurring violations, fix cycle patterns, agent performance
 * trends, and planner patterns into a single CrossRunAnalysisResult.
 *
 * @param driftDb - DriftDb instance for accessing reviews and flow runs
 * @param summaries - Run summaries from the history archive
 * @param options - Optional filter: `limit` caps performance trend data points,
 *                  `since` filters flow runs to those started after the given ISO timestamp
 */
export function analyzeCrossRunPatterns(
  driftDb: DriftDb,
  summaries: RunSummary[],
  options?: { limit?: number; since?: string },
): CrossRunAnalysisResult {
  const { since, limit } = options ?? {};

  // Get data from drift.db
  const allReviews = driftDb.getReviews();
  let allFlowRuns = driftDb.getAllFlowRuns();
  if (since !== undefined) {
    allFlowRuns = allFlowRuns.filter((r) => r.started >= since);
  }

  // Load craft profiles (degraded gracefully when store unavailable)
  const craftProfiles = loadCraftProfiles(driftDb, { limit, since });

  // Collect violations from summaries
  const summaryViolations = violationsFromSummaries(summaries);

  // Run sub-analyses
  const rawRecurringViolations = findRecurringViolations(summaryViolations, allReviews);
  const runLookup = buildRunLookup(allFlowRuns);
  const recurring_violations = enrichWithWeightedCounts(
    rawRecurringViolations,
    summaries,
    runLookup,
  );

  const fix_cycle_patterns = computeFixCyclePatterns(summaryViolations, allReviews);
  const agent_performance_trends = computePerformanceTrends(summaries, allFlowRuns, limit);
  const planner_patterns = analyzePlannerPatterns(summaries);
  const craft_drift = computeCraftDrift(craftProfiles);
  const analysis_window = computeAnalysisWindow(allReviews, allFlowRuns, summaries);

  return {
    agent_performance_trends,
    analysis_window,
    craft_drift,
    fix_cycle_patterns,
    planner_patterns,
    recurring_violations,
    total_archived_runs: summaries.length,
  };
}
