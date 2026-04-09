/**
 * Drift DB Analytics Query Methods
 *
 * Extracted from drift-db.ts: trend computation, weekly aggregation,
 * and analytics methods for DriftDb. These functions are pure analytics
 * that take a DriftDb instance and helper types.
 */

import type { FlowAnalytics, FlowRunEntry } from "./drift-analytics-types.ts";

/**
 * Convert an ISO timestamp to ISO week string (e.g., "2026-W12").
 * Uses Thursday-based ISO 8601 week numbering.
 * Exported for use in drift-db.ts.
 */
export function toISOWeek(timestamp: string): string {
  const date = new Date(timestamp);
  const thursday = new Date(date);
  const dayOfWeek = date.getUTCDay();
  const daysToThursday = dayOfWeek === 0 ? -3 : 4 - dayOfWeek;
  thursday.setUTCDate(date.getUTCDate() + daysToThursday);

  const year = thursday.getUTCFullYear();

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayOfWeek = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const w1Monday = new Date(jan4);
  w1Monday.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));

  const diffMs = thursday.getTime() - w1Monday.getTime();
  const diffDays = Math.round(diffMs / 86400000);
  const weekNum = Math.floor(diffDays / 7) + 1;

  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

export type WeeklyTrendPoint = {
  week: string; // ISO week: "2026-W12"
  pass_rate: number; // 0-1
  violations: number;
  reviews: number;
};

// Internal row types needed for analytics
type ReviewRow = {
  id: number;
  review_id: string;
  timestamp: string;
  files: string;
  honored: string;
  score: string;
  verdict: string;
  pr_number: number | null;
  branch: string | null;
  last_reviewed_sha: string | null;
  file_priorities: string | null;
  recommendations: string | null;
};

type FlowRunRow = {
  id: number;
  run_id: string;
  flow: string;
  tier: string;
  task: string;
  started: string;
  completed: string;
  total_duration_ms: number;
  state_durations: string;
  state_iterations: string;
  skipped_states: string;
  total_spawns: number;
  gate_pass_rate: number | null;
  postcondition_pass_rate: number | null;
  total_violations: number | null;
  total_test_results: string | null;
  total_files_changed: number | null;
  commits: string | null;
  diff_stat: string | null;
};

/**
 * Compute weekly compliance trend for a principle.
 * Groups reviews by ISO week and computes pass rate per bucket.
 * Optionally limits results to the most recent N weeks.
 */
export function computeComplianceTrend(
  allRows: ReviewRow[],
  violationReviewIds: Set<string>,
  principleId: string,
  weeks?: number,
): WeeklyTrendPoint[] {
  const relevant = allRows.filter((row) => {
    if (violationReviewIds.has(row.review_id)) return true;
    try {
      const honored = JSON.parse(row.honored) as string[];
      return honored.includes(principleId);
    } catch {
      return false;
    }
  });

  if (relevant.length === 0) return [];

  const weekBuckets = new Map<string, { violations: number; passes: number }>();

  for (const row of relevant) {
    const week = toISOWeek(row.timestamp);
    const bucket = weekBuckets.get(week) ?? { passes: 0, violations: 0 };

    if (violationReviewIds.has(row.review_id)) bucket.violations++;

    try {
      const honored = JSON.parse(row.honored) as string[];
      if (honored.includes(principleId)) bucket.passes++;
    } catch {
      // ignore malformed JSON
    }

    weekBuckets.set(week, bucket);
  }

  const sorted = Array.from(weekBuckets.entries()).sort(([a], [b]) => a.localeCompare(b));
  const limited = weeks !== undefined ? sorted.slice(-weeks) : sorted;

  return limited.map(([week, data]) => {
    const total = data.violations + data.passes;
    return {
      pass_rate: total > 0 ? Math.round((data.passes / total) * 100) / 100 : 0,
      reviews: total,
      violations: data.violations,
      week,
    };
  });
}

/**
 * Aggregate analytics across all flow runs.
 */
export function computeFlowAnalytics(rows: FlowRunRow[]): FlowAnalytics {
  if (rows.length === 0) {
    return { avg_duration_ms: 0, total_runs: 0 };
  }

  let totalDuration = 0;
  let gateSum = 0;
  let gateCount = 0;
  let postconditionSum = 0;
  let postconditionCount = 0;

  for (const row of rows) {
    totalDuration += row.total_duration_ms;
    if (row.gate_pass_rate !== null) {
      gateSum += row.gate_pass_rate;
      gateCount++;
    }
    if (row.postcondition_pass_rate !== null) {
      postconditionSum += row.postcondition_pass_rate;
      postconditionCount++;
    }
  }

  const result: FlowAnalytics = {
    avg_duration_ms: totalDuration / rows.length,
    total_runs: rows.length,
  };

  if (gateCount > 0) result.avg_gate_pass_rate = gateSum / gateCount;
  if (postconditionCount > 0)
    result.avg_postcondition_pass_rate = postconditionSum / postconditionCount;

  return result;
}

/** Deserialize a FlowRunRow into a FlowRunEntry. */
export function rowToFlowRunEntry(row: FlowRunRow): FlowRunEntry {
  const entry: FlowRunEntry = {
    completed: row.completed,
    flow: row.flow,
    run_id: row.run_id,
    skipped_states: JSON.parse(row.skipped_states) as string[],
    started: row.started,
    state_durations: JSON.parse(row.state_durations) as Record<string, number>,
    state_iterations: JSON.parse(row.state_iterations) as Record<string, number>,
    task: row.task,
    tier: row.tier,
    total_duration_ms: row.total_duration_ms,
    total_spawns: row.total_spawns,
  };
  if (row.gate_pass_rate !== null) entry.gate_pass_rate = row.gate_pass_rate;
  if (row.postcondition_pass_rate !== null)
    entry.postcondition_pass_rate = row.postcondition_pass_rate;
  if (row.total_violations !== null) entry.total_violations = row.total_violations;
  if (row.total_test_results !== null)
    entry.total_test_results = JSON.parse(
      row.total_test_results,
    ) as FlowRunEntry["total_test_results"];
  if (row.total_files_changed !== null) entry.total_files_changed = row.total_files_changed;
  if (row.commits !== null) entry.commits = JSON.parse(row.commits) as string[];
  if (row.diff_stat !== null) entry.diff_stat = row.diff_stat;
  return entry;
}
