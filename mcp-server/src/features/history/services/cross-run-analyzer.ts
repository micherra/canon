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

import type { DriftDb } from "@platform/storage/drift/drift-db.ts";
import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import type {
  AgentPerformanceTrend,
  CrossRunAnalysisResult,
  FixCyclePattern,
  PlannerPatternAnalysis,
  RecurringViolation,
  RunSummary,
} from "../history-types.ts";

// ---- Internal types ----

/** Normalized violation record from any source (summary or drift.db). */
type NormalizedViolation = {
  principleId: string;
  severity: string;
  filePath: string | null;
  reviewTimestamp: string;
};

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
          principleId: violation.principle_id,
          severity: violation.severity,
          filePath: violation.file_path ?? null,
          reviewTimestamp: summary.run_metadata.completed_at ?? summary.run_metadata.archived_at,
        });
      }
    }
  }
  return result;
}

/**
 * Collect violations from drift.db ReviewEntry records.
 * Returns a flat list of NormalizedViolation records.
 */
function violationsFromReviews(reviews: ReviewEntry[]): NormalizedViolation[] {
  const result: NormalizedViolation[] = [];
  for (const review of reviews) {
    for (const violation of review.violations ?? []) {
      result.push({
        principleId: violation.principle_id,
        severity: violation.severity,
        filePath: violation.file_path ?? null,
        reviewTimestamp: review.timestamp,
      });
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

// ---- Exported pure functions ----

/**
 * Find violations that recur across multiple runs (occurrence_count >= 2).
 *
 * Combines violations from run summaries and drift.db reviews.
 * Groups by principle_id, counts occurrences, and returns entries sorted
 * by occurrence_count descending.
 *
 * @param summaryViolations - Violations extracted from run summaries (see violationsFromSummaries)
 * @param driftReviews - All ReviewEntry records from drift.db (driftDb.getReviews())
 */
export function findRecurringViolations(
  summaryViolations: NormalizedViolation[],
  driftReviews: ReviewEntry[],
): RecurringViolation[] {
  const allViolations = [...summaryViolations, ...violationsFromReviews(driftReviews)];

  // Group by principle_id
  const byPrinciple = new Map<
    string,
    { severity: string; files: Set<string>; timestamps: string[] }
  >();

  for (const v of allViolations) {
    const existing = byPrinciple.get(v.principleId);
    if (existing === undefined) {
      const files = new Set<string>();
      if (v.filePath !== null) files.add(v.filePath);
      byPrinciple.set(v.principleId, {
        severity: v.severity,
        files,
        timestamps: [v.reviewTimestamp],
      });
    } else {
      if (v.filePath !== null) existing.files.add(v.filePath);
      existing.timestamps.push(v.reviewTimestamp);
    }
  }

  // Filter to principles with >= 2 occurrences, then build result
  const result: RecurringViolation[] = [];
  for (const [principleId, data] of byPrinciple) {
    if (data.timestamps.length < 2) continue;

    const sortedTimestamps = [...data.timestamps].sort();
    result.push({
      principle_id: principleId,
      severity: data.severity,
      occurrence_count: data.timestamps.length,
      affected_files: [...data.files],
      first_seen: sortedTimestamps[0],
      last_seen: sortedTimestamps[sortedTimestamps.length - 1],
    });
  }

  // Sort by occurrence_count descending
  result.sort((a, b) => b.occurrence_count - a.occurrence_count);
  return result;
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
export function computeFixCyclePatterns(
  summaryViolations: NormalizedViolation[],
  driftReviews: ReviewEntry[],
): FixCyclePattern[] {
  // We need to analyze the timeline of reviews to detect fix/reappearance cycles.
  // Build a sorted timeline of all reviews with which principles were violated.

  // Collect all unique review timestamps and their violated principles
  type ReviewSnapshot = { timestamp: string; violatedPrinciples: Set<string> };

  const snapshots: ReviewSnapshot[] = [];

  // From drift reviews
  for (const review of driftReviews) {
    const violated = new Set<string>();
    for (const v of review.violations ?? []) {
      violated.add(v.principle_id);
    }
    snapshots.push({ timestamp: review.timestamp, violatedPrinciples: violated });
  }

  // From summary violations — group by timestamp
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

  // Sort snapshots by timestamp
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (snapshots.length < 2) return [];

  // Find recurring principle IDs first
  const recurringIds = new Set(
    findRecurringViolations(summaryViolations, driftReviews).map((v) => v.principle_id),
  );

  const result: FixCyclePattern[] = [];

  for (const principleId of recurringIds) {
    // Build the presence timeline for this principle
    // present=true when the violation appears in that snapshot
    const timeline = snapshots.map((s) => ({
      timestamp: s.timestamp,
      present: s.violatedPrinciples.has(principleId),
    }));

    // Detect fix events and reappearance events
    let fixCount = 0;
    let reappearanceCount = 0;
    const fixDurationsMs: number[] = [];

    let lastFixTimestamp: string | null = null;

    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const curr = timeline[i];

      if (prev.present && !curr.present) {
        // Fix: violation was present, now absent
        fixCount++;
        lastFixTimestamp = curr.timestamp;
      } else if (!prev.present && curr.present && lastFixTimestamp !== null) {
        // Reappearance: violation gone, now back
        reappearanceCount++;
        const fixMs =
          new Date(curr.timestamp).getTime() - new Date(lastFixTimestamp).getTime();
        if (fixMs > 0) fixDurationsMs.push(fixMs);
        lastFixTimestamp = null;
      }
    }

    if (fixCount === 0) continue;

    const avgFixDurationMs =
      fixDurationsMs.length > 0
        ? fixDurationsMs.reduce((sum, d) => sum + d, 0) / fixDurationsMs.length
        : 0;

    result.push({
      principle_id: principleId,
      avg_fix_duration_ms: avgFixDurationMs,
      fix_count: fixCount,
      recurrence_rate: fixCount > 0 ? reappearanceCount / fixCount : 0,
    });
  }

  return result;
}

/**
 * Compute agent performance trends grouped by flow name.
 *
 * Prefers step durations from run summaries when available.
 * Falls back to FlowRunEntry records for runs without summaries.
 * Deduplicates on (flow, started): when a summary and a FlowRunEntry share the
 * same (flow, started) pair, the summary entry is preferred.
 *
 * Trend classification compares recent 5 runs to previous 5:
 * - "improving": recent avg > 10% faster than prior avg
 * - "degrading": recent avg > 10% slower than prior avg
 * - "stable": within 10% or fewer than 10 total runs
 *
 * @param summaries - Run summaries with optional step_outcomes
 * @param runs - Flow run entries from drift.db
 * @param limit - Optional cap on the number of data points per flow (most recent N kept)
 */
export function computePerformanceTrends(
  summaries: RunSummary[],
  runs: FlowRunEntry[],
  limit?: number,
): AgentPerformanceTrend[] {
  // Build a unified set of (flow, duration_ms, spawns, timestamp) data points
  type DataPoint = { flow: string; duration_ms: number; spawns: number; started: string };

  const points: DataPoint[] = [];

  // Track (flow, started) pairs from summaries for deduplication.
  const summaryKeys = new Set<string>();

  // From summaries — prefer summary data
  for (const summary of summaries) {
    const { flow, total_duration_ms, started_at } = summary.run_metadata;
    if (total_duration_ms === null) continue;

    // Derive spawns from step_outcomes count
    const spawns = summary.step_outcomes.length;
    const started = started_at ?? summary.run_metadata.archived_at;

    summaryKeys.add(`${flow}\0${started}`);
    points.push({
      flow,
      duration_ms: total_duration_ms,
      spawns,
      started,
    });
  }

  // From FlowRunEntry — skip runs already covered by a summary (same flow + started).
  for (const run of runs) {
    if (summaryKeys.has(`${run.flow}\0${run.started}`)) continue;
    points.push({
      flow: run.flow,
      duration_ms: run.total_duration_ms,
      spawns: run.total_spawns,
      started: run.started,
    });
  }

  // Group by flow
  const byFlow = new Map<string, DataPoint[]>();
  for (const p of points) {
    const existing = byFlow.get(p.flow);
    if (existing === undefined) {
      byFlow.set(p.flow, [p]);
    } else {
      existing.push(p);
    }
  }

  const result: AgentPerformanceTrend[] = [];

  for (const [flow, flowPoints] of byFlow) {
    // Sort by started ASC
    flowPoints.sort((a, b) => a.started.localeCompare(b.started));

    // Apply limit: keep only the most recent N data points.
    if (limit !== undefined && limit > 0 && flowPoints.length > limit) {
      flowPoints.splice(0, flowPoints.length - limit);
    }

    const n = flowPoints.length;
    const avgDurationMs = flowPoints.reduce((sum, p) => sum + p.duration_ms, 0) / n;
    const avgSpawns = flowPoints.reduce((sum, p) => sum + p.spawns, 0) / n;

    let trend: "improving" | "stable" | "degrading" = "stable";

    if (n >= 10) {
      const prior5 = flowPoints.slice(n - 10, n - 5);
      const recent5 = flowPoints.slice(n - 5);

      const priorAvg = prior5.reduce((sum, p) => sum + p.duration_ms, 0) / 5;
      const recentAvg = recent5.reduce((sum, p) => sum + p.duration_ms, 0) / 5;

      if (priorAvg > 0) {
        const changePct = (recentAvg - priorAvg) / priorAvg;
        if (changePct < -0.1) {
          trend = "improving"; // faster
        } else if (changePct > 0.1) {
          trend = "degrading"; // slower
        }
      }
    }

    result.push({
      flow,
      avg_duration_ms: avgDurationMs,
      avg_spawns: avgSpawns,
      run_count: n,
      trend,
    });
  }

  return result;
}

/**
 * Analyze planner patterns across run summaries.
 *
 * Extracts common assumptions, effort accuracy, and value distribution
 * from summaries that have non-null planner_context.
 * Returns zero counts when no summaries have planner context.
 *
 * @param summaries - Run summaries to analyze
 */
export function analyzePlannerPatterns(summaries: RunSummary[]): PlannerPatternAnalysis {
  const withPlanner = summaries.filter((s) => s.planner_context !== null);

  if (withPlanner.length === 0) {
    return {
      total_runs_with_planner: 0,
      common_assumptions: [],
      effort_accuracy: [],
      value_distribution: [],
    };
  }

  // Common assumptions: count occurrences of each assumption text
  const assumptionCounts = new Map<string, number>();
  for (const summary of withPlanner) {
    const ctx = summary.planner_context!;
    for (const assumption of ctx.assumptions) {
      const normalized = assumption.trim();
      if (normalized.length === 0) continue;
      assumptionCounts.set(normalized, (assumptionCounts.get(normalized) ?? 0) + 1);
    }
  }

  const common_assumptions = [...assumptionCounts.entries()]
    .map(([assumption, occurrence_count]) => ({ assumption, occurrence_count }))
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 10);

  // Effort accuracy: group by effort_estimate, compute avg actual duration
  const effortGroups = new Map<string, number[]>();
  for (const summary of withPlanner) {
    const estimate = summary.planner_context!.effort_estimate;
    const duration = summary.run_metadata.total_duration_ms;
    if (duration === null) continue;

    const existing = effortGroups.get(estimate);
    if (existing === undefined) {
      effortGroups.set(estimate, [duration]);
    } else {
      existing.push(duration);
    }
  }

  const effort_accuracy = [...effortGroups.entries()].map(([estimate, durations]) => ({
    estimate,
    actual_avg_duration_ms: durations.reduce((sum, d) => sum + d, 0) / durations.length,
    sample_count: durations.length,
  }));

  // Value distribution: count each value_estimate
  const valueCounts = new Map<string, number>();
  for (const summary of withPlanner) {
    const value = summary.planner_context!.value_estimate;
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  }

  const value_distribution = [...valueCounts.entries()].map(([value, count]) => ({
    value,
    count,
  }));

  return {
    total_runs_with_planner: withPlanner.length,
    common_assumptions,
    effort_accuracy,
    value_distribution,
  };
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

  // Apply since filter to flow runs
  if (since !== undefined) {
    allFlowRuns = allFlowRuns.filter((r) => r.started >= since);
  }

  // Collect violations from summaries
  const summaryViolations = violationsFromSummaries(summaries);

  // Run sub-analyses
  const recurring_violations = findRecurringViolations(summaryViolations, allReviews);
  const fix_cycle_patterns = computeFixCyclePatterns(summaryViolations, allReviews);
  const agent_performance_trends = computePerformanceTrends(summaries, allFlowRuns, limit);
  const planner_patterns = analyzePlannerPatterns(summaries);

  // Compute analysis window from all available timestamps
  const allTimestamps: (string | null | undefined)[] = [
    ...allReviews.map((r) => r.timestamp),
    ...allFlowRuns.map((r) => r.started),
    ...allFlowRuns.map((r) => r.completed),
    ...summaries.map((s) => s.run_metadata.started_at),
    ...summaries.map((s) => s.run_metadata.completed_at),
    ...summaries.map((s) => s.run_metadata.archived_at),
  ];

  const timeRange = computeTimeRange(allTimestamps);
  const analysis_window = timeRange ?? {
    from: new Date().toISOString(),
    to: new Date().toISOString(),
  };

  return {
    recurring_violations,
    fix_cycle_patterns,
    agent_performance_trends,
    planner_patterns,
    total_archived_runs: summaries.length,
    analysis_window,
  };
}
