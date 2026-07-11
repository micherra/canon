/**
 * Cross-run pattern helpers — performance trends and planner pattern analysis.
 *
 * Extracted from cross-run-analyzer.ts to keep each file under 600 lines.
 * All functions are pure (no I/O).
 *
 * bounded-context-boundaries: imports only from shared kernel types and the
 * history-types bounded context. No cross-feature imports.
 */

import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import type {
  AgentPerformanceTrend,
  CacheEfficiencyByAgent,
  PlannerPatternAnalysis,
  RunSummary,
} from "../history-types.ts";

// DataPoint type for performance trend computation
type DataPoint = {
  flow: string;
  duration_ms: number;
  spawns: number;
  started: string;
  // Recorded per-step counters (record_agent_metrics), summed across a summary's
  // step_outcomes. Undefined when no step_outcome carried that counter — the
  // FlowRunEntry-fallback points below never carry these fields.
  tool_calls?: number;
  turns?: number;
  orientation_calls?: number;
};

/**
 * Sum a single counter key across a step's staged metrics — every
 * metrics.stage_metrics[stage][key] value (the #473 staged path via
 * record_agent_metrics' `stage` param). Returns undefined when no stage
 * carried that key as a number.
 */
function sumStagedCounter(
  stageMetrics:
    | NonNullable<RunSummary["step_outcomes"][number]["metrics"]>["stage_metrics"]
    | undefined,
  key: "tool_calls" | "turns" | "orientation_calls",
): number | undefined {
  if (typeof stageMetrics !== "object" || stageMetrics === null) return undefined;
  let sum: number | undefined;
  for (const stageCounters of Object.values(stageMetrics)) {
    const stageValue = stageCounters[key];
    if (typeof stageValue === "number") {
      sum = (sum ?? 0) + stageValue;
    }
  }
  return sum;
}

/**
 * Sum a single recorded counter key across a summary's step_outcomes.metrics.
 * Reads both the top-level counter (metrics[key]) and, when present, every
 * staged counter (see sumStagedCounter) so a run recorded entirely through the
 * staged path still contributes. Returns undefined when no step_outcome carries
 * that key as a number anywhere — a summary with zero recorded metrics must not
 * report a misleading summed 0.
 */
function sumRecordedCounter(
  stepOutcomes: RunSummary["step_outcomes"],
  key: "tool_calls" | "turns" | "orientation_calls",
): number | undefined {
  let sum: number | undefined;
  for (const step of stepOutcomes) {
    const value = step.metrics?.[key];
    if (typeof value === "number") {
      sum = (sum ?? 0) + value;
    }

    const stagedSum = sumStagedCounter(step.metrics?.stage_metrics, key);
    if (stagedSum !== undefined) {
      sum = (sum ?? 0) + stagedSum;
    }
  }
  return sum;
}

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
    points.push({
      duration_ms: total_duration_ms,
      flow,
      orientation_calls: sumRecordedCounter(summary.step_outcomes, "orientation_calls"),
      spawns,
      started,
      tool_calls: sumRecordedCounter(summary.step_outcomes, "tool_calls"),
      turns: sumRecordedCounter(summary.step_outcomes, "turns"),
    });
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
 * Average a recorded counter over only the points that carried it.
 * Returns undefined when no point in the window carried the counter — never
 * emits NaN (empty-average) or a misleading 0 (points that never reported it).
 */
function averageRecordedCounter(
  flowPoints: DataPoint[],
  key: "tool_calls" | "turns" | "orientation_calls",
): number | undefined {
  const values = flowPoints.map((p) => p[key]).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return undefined;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
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

  const avgToolCalls = averageRecordedCounter(flowPoints, "tool_calls");
  const avgTurns = averageRecordedCounter(flowPoints, "turns");
  const avgOrientationCalls = averageRecordedCounter(flowPoints, "orientation_calls");

  return {
    avg_duration_ms: avgDurationMs,
    avg_spawns: avgSpawns,
    flow,
    run_count: n,
    trend,
    ...(avgToolCalls !== undefined ? { avg_tool_calls: avgToolCalls } : {}),
    ...(avgTurns !== undefined ? { avg_turns: avgTurns } : {}),
    ...(avgOrientationCalls !== undefined ? { avg_orientation_calls: avgOrientationCalls } : {}),
  };
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
  const points = buildUnifiedDataPoints(summaries, runs);
  const byFlow = groupDataPointsByFlow(points);

  const result: AgentPerformanceTrend[] = [];
  for (const [flow, flowPoints] of byFlow) {
    result.push(computeFlowTrend(flow, flowPoints, limit));
  }
  return result;
}

// Per-agent cache accumulator used only inside computeCacheEfficiencyByAgent.
type CacheAccumulator = {
  ratios: number[];
  totalReadTokens: number;
  totalCreationTokens: number;
  sampleCount: number;
};

/**
 * Fold a single step's cache metrics into its agent_type's accumulator.
 * Guards every numeric read with typeof === "number" — metrics values are
 * loosely typed and a stringified/nested metric must not poison a sum/mean.
 */
function accumulateStepCacheMetrics(
  acc: CacheAccumulator,
  metrics: RunSummary["step_outcomes"][number]["metrics"],
): void {
  const ratio = metrics?.cache_hit_ratio;
  const readTokens = metrics?.cache_read_tokens;
  const creationTokens = metrics?.cache_creation_tokens;

  let sampled = false;
  if (typeof ratio === "number") {
    acc.ratios.push(ratio);
    sampled = true;
  }
  if (typeof readTokens === "number") {
    acc.totalReadTokens += readTokens;
    sampled = true;
  }
  if (typeof creationTokens === "number") {
    acc.totalCreationTokens += creationTokens;
    sampled = true;
  }
  if (sampled) acc.sampleCount++;
}

/**
 * Group step_outcomes across all summaries into per-agent-type cache
 * accumulators (empty agent_type bucketed as "unknown", matching the
 * CliffEventsDimension convention).
 */
function buildCacheAccumulatorsByAgent(summaries: RunSummary[]): Map<string, CacheAccumulator> {
  const byAgent = new Map<string, CacheAccumulator>();
  for (const summary of summaries) {
    for (const step of summary.step_outcomes) {
      const agentType = step.agent_type === "" ? "unknown" : step.agent_type;
      let acc = byAgent.get(agentType);
      if (acc === undefined) {
        acc = { ratios: [], sampleCount: 0, totalCreationTokens: 0, totalReadTokens: 0 };
        byAgent.set(agentType, acc);
      }
      accumulateStepCacheMetrics(acc, step.metrics);
    }
  }
  return byAgent;
}

/**
 * Finalize a single agent_type's accumulator into a CacheEfficiencyByAgent
 * row. mean_cache_hit_ratio is omitted (never NaN/0) when no step carried a
 * ratio — matches the spread-conditional omit idiom used throughout this file.
 */
function finalizeCacheRow(agent_type: string, acc: CacheAccumulator): CacheEfficiencyByAgent {
  const meanRatio =
    acc.ratios.length > 0
      ? acc.ratios.reduce((sum, r) => sum + r, 0) / acc.ratios.length
      : undefined;
  return {
    agent_type,
    sample_count: acc.sampleCount,
    total_cache_creation_tokens: acc.totalCreationTokens,
    total_cache_read_tokens: acc.totalReadTokens,
    ...(meanRatio !== undefined ? { mean_cache_hit_ratio: meanRatio } : {}),
  };
}

/**
 * Compute a per-agent-type cache-efficiency rollup over already-archived
 * step_outcomes.metrics. Pure — no I/O.
 *
 * An agent_type with zero sampled steps contributes no row. Result sorted
 * by agent_type (localeCompare).
 */
export function computeCacheEfficiencyByAgent(summaries: RunSummary[]): CacheEfficiencyByAgent[] {
  const byAgent = buildCacheAccumulatorsByAgent(summaries);

  const result: CacheEfficiencyByAgent[] = [];
  for (const [agent_type, acc] of byAgent) {
    if (acc.sampleCount === 0) continue;
    result.push(finalizeCacheRow(agent_type, acc));
  }

  return result.sort((a, b) => a.agent_type.localeCompare(b.agent_type));
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
