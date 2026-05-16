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

import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import type { DriftDb } from "@platform/storage/drift/drift-db.ts";
import type { NormalizedViolation } from "@shared/lib/violation-patterns.ts";
import { findRecurringViolations } from "@shared/lib/violation-patterns.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import type {
  AgentPerformanceTrend,
  CrossRunAnalysisResult,
  FixCyclePattern,
  PlannerPatternAnalysis,
  RunSummary,
} from "../history-types.ts";

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
function computePerformanceTrends(
  summaries: RunSummary[],
  runs: FlowRunEntry[],
  limit?: number,
): AgentPerformanceTrend[] {
  const points = buildUnifiedDataPoints(summaries, runs);
  const byFlow = groupDataPointsByFlow(points);

  const result: AgentPerformanceTrend[] = [];
  for (const [flow, flowPoints] of byFlow) {
    result.push(computeFlowTrend(flow, flowPoints, limit));
  }
  return result;
}

// DataPoint type for performance trend computation
type DataPoint = { flow: string; duration_ms: number; spawns: number; started: string };

/**
 * Build unified data points from summaries (preferred) and flow run entries (fallback).
 * Deduplicates on (flow, started): summary data takes priority.
 */
function buildUnifiedDataPoints(summaries: RunSummary[], runs: FlowRunEntry[]): DataPoint[] {
  const points: DataPoint[] = [];
  const summaryKeys = new Set<string>();

  for (const summary of summaries) {
    const { flow, total_duration_ms, started_at } = summary.run_metadata;
    if (total_duration_ms === null) continue;
    const spawns = summary.step_outcomes.length;
    const started = started_at ?? summary.run_metadata.archived_at;
    summaryKeys.add(`${flow}\0${started}`);
    points.push({ duration_ms: total_duration_ms, flow, spawns, started });
  }

  for (const run of runs) {
    if (summaryKeys.has(`${run.flow}\0${run.started}`)) continue;
    points.push({
      duration_ms: run.total_duration_ms,
      flow: run.flow,
      spawns: run.total_spawns,
      started: run.started,
    });
  }

  return points;
}

/**
 * Group data points by flow name.
 */
function groupDataPointsByFlow(points: DataPoint[]): Map<string, DataPoint[]> {
  const byFlow = new Map<string, DataPoint[]>();
  for (const p of points) {
    const existing = byFlow.get(p.flow);
    if (existing === undefined) {
      byFlow.set(p.flow, [p]);
    } else {
      existing.push(p);
    }
  }
  return byFlow;
}

/**
 * Compute trend classification for a single flow's data points.
 * "improving": recent 5 avg > 10% faster than prior 5.
 * "degrading": recent 5 avg > 10% slower than prior 5.
 * "stable": within 10% or fewer than 10 total runs.
 */
function computeFlowTrend(
  flow: string,
  flowPoints: DataPoint[],
  limit?: number,
): AgentPerformanceTrend {
  flowPoints.sort((a, b) => a.started.localeCompare(b.started));

  if (limit !== undefined && limit > 0 && flowPoints.length > limit) {
    flowPoints.splice(0, flowPoints.length - limit);
  }

  const n = flowPoints.length;
  const avgDurationMs = flowPoints.reduce((sum, p) => sum + p.duration_ms, 0) / n;
  const avgSpawns = flowPoints.reduce((sum, p) => sum + p.spawns, 0) / n;
  const trend = classifyTrend(flowPoints, n);

  return { avg_duration_ms: avgDurationMs, avg_spawns: avgSpawns, flow, run_count: n, trend };
}

/**
 * Classify trend direction by comparing recent 5 vs prior 5 runs.
 */
function classifyTrend(flowPoints: DataPoint[], n: number): "improving" | "stable" | "degrading" {
  if (n < 10) return "stable";

  const prior5 = flowPoints.slice(n - 10, n - 5);
  const recent5 = flowPoints.slice(n - 5);
  const priorAvg = prior5.reduce((sum, p) => sum + p.duration_ms, 0) / 5;
  const recentAvg = recent5.reduce((sum, p) => sum + p.duration_ms, 0) / 5;

  if (priorAvg <= 0) return "stable";

  const changePct = (recentAvg - priorAvg) / priorAvg;
  if (changePct < -0.1) return "improving";
  if (changePct > 0.1) return "degrading";
  return "stable";
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
function analyzePlannerPatterns(summaries: RunSummary[]): PlannerPatternAnalysis {
  const withPlanner = summaries.filter((s) => s.planner_context !== null);

  if (withPlanner.length === 0) {
    return {
      common_assumptions: [],
      effort_accuracy: [],
      total_runs_with_planner: 0,
      value_distribution: [],
    };
  }

  const common_assumptions = computeCommonAssumptions(withPlanner);
  const effort_accuracy = computeEffortAccuracy(withPlanner);
  const value_distribution = computeValueDistribution(withPlanner);

  return {
    common_assumptions,
    effort_accuracy,
    total_runs_with_planner: withPlanner.length,
    value_distribution,
  };
}

/**
 * Count occurrences of each assumption text across summaries with planner context.
 * Returns top 10 by occurrence count.
 */
function computeCommonAssumptions(
  withPlanner: RunSummary[],
): Array<{ assumption: string; occurrence_count: number }> {
  const counts = new Map<string, number>();
  for (const summary of withPlanner) {
    for (const assumption of summary.planner_context!.assumptions) {
      const normalized = assumption.trim();
      if (normalized.length === 0) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([assumption, occurrence_count]) => ({ assumption, occurrence_count }))
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 10);
}

/**
 * Group summaries by effort_estimate and compute avg actual duration per group.
 */
function computeEffortAccuracy(
  withPlanner: RunSummary[],
): Array<{ estimate: string; actual_avg_duration_ms: number; sample_count: number }> {
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
  return [...effortGroups.entries()].map(([estimate, durations]) => ({
    actual_avg_duration_ms: durations.reduce((sum, d) => sum + d, 0) / durations.length,
    estimate,
    sample_count: durations.length,
  }));
}

/**
 * Count occurrences of each value_estimate across summaries with planner context.
 */
function computeValueDistribution(
  withPlanner: RunSummary[],
): Array<{ value: string; count: number }> {
  const valueCounts = new Map<string, number>();
  for (const summary of withPlanner) {
    const value = summary.planner_context!.value_estimate;
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  }
  return [...valueCounts.entries()].map(([value, count]) => ({ count, value }));
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
    agent_performance_trends,
    analysis_window,
    fix_cycle_patterns,
    planner_patterns,
    recurring_violations,
    total_archived_runs: summaries.length,
  };
}
