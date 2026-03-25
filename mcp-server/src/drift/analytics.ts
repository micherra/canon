/**
 * Flow execution analytics — aggregates flow-runs.jsonl for bottleneck
 * and cost analysis. Used by the inspector agent and get_flow_analytics tool.
 */

import { join } from "path";
import { CANON_DIR } from "../constants.ts";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.ts";

export interface FlowRunEntry {
  run_id: string;
  flow: string;
  tier: string;
  task: string;
  started: string;
  completed: string;
  total_duration_ms: number;
  state_durations: Record<string, number>;
  state_iterations: Record<string, number>;
  skipped_states: string[];
  total_spawns: number;
}

export interface FlowAnalytics {
  total_runs: number;
  by_flow: Record<string, {
    count: number;
    avg_duration_ms: number;
    min_duration_ms: number;
    max_duration_ms: number;
  }>;
  bottleneck_states: Array<{
    state: string;
    avg_duration_ms: number;
    total_iterations: number;
    appearances: number;
  }>;
  skip_rates: Record<string, { skipped: number; total: number; rate: number }>;
  total_spawns: number;
}

function flowRunsPath(projectDir: string): string {
  return join(projectDir, CANON_DIR, "flow-runs.jsonl");
}

export async function appendFlowRun(projectDir: string, entry: FlowRunEntry): Promise<void> {
  const path = flowRunsPath(projectDir);
  await appendJsonl(path, entry);
  await rotateIfNeeded(path);
}

export async function getFlowRuns(projectDir: string, flow?: string): Promise<FlowRunEntry[]> {
  const filter = flow ? (r: FlowRunEntry) => r.flow === flow : undefined;
  return readJsonl<FlowRunEntry>(flowRunsPath(projectDir), filter);
}

export function computeAnalytics(runs: FlowRunEntry[]): FlowAnalytics {
  if (runs.length === 0) {
    return { total_runs: 0, by_flow: {}, bottleneck_states: [], skip_rates: {}, total_spawns: 0 };
  }

  // Per-flow aggregation
  const byFlow: Record<string, { durations: number[]; count: number }> = {};
  for (const run of runs) {
    const entry = byFlow[run.flow] ?? { durations: [], count: 0 };
    entry.durations.push(run.total_duration_ms);
    entry.count++;
    byFlow[run.flow] = entry;
  }

  const byFlowResult: FlowAnalytics["by_flow"] = {};
  for (const [flow, data] of Object.entries(byFlow)) {
    const sorted = data.durations.sort((a, b) => a - b);
    byFlowResult[flow] = {
      count: data.count,
      avg_duration_ms: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      min_duration_ms: sorted[0],
      max_duration_ms: sorted[sorted.length - 1],
    };
  }

  // Per-state bottleneck analysis
  const stateStats: Record<string, { durations: number[]; iterations: number; appearances: number }> = {};
  for (const run of runs) {
    for (const [state, duration] of Object.entries(run.state_durations)) {
      const entry = stateStats[state] ?? { durations: [], iterations: 0, appearances: 0 };
      entry.durations.push(duration);
      entry.iterations += run.state_iterations[state] ?? 1;
      entry.appearances++;
      stateStats[state] = entry;
    }
  }

  const bottleneckStates = Object.entries(stateStats)
    .map(([state, data]) => ({
      state,
      avg_duration_ms: Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length),
      total_iterations: data.iterations,
      appearances: data.appearances,
    }))
    .sort((a, b) => b.avg_duration_ms - a.avg_duration_ms)
    .slice(0, 10);

  // Skip rates
  const skipCounts: Record<string, { skipped: number; total: number }> = {};
  for (const run of runs) {
    const allStates = new Set([
      ...Object.keys(run.state_durations),
      ...run.skipped_states,
    ]);
    for (const state of allStates) {
      const entry = skipCounts[state] ?? { skipped: 0, total: 0 };
      entry.total++;
      if (run.skipped_states.includes(state)) entry.skipped++;
      skipCounts[state] = entry;
    }
  }

  const skipRates: FlowAnalytics["skip_rates"] = {};
  for (const [state, data] of Object.entries(skipCounts)) {
    if (data.skipped > 0) {
      skipRates[state] = {
        ...data,
        rate: Math.round((data.skipped / data.total) * 100) / 100,
      };
    }
  }

  return {
    total_runs: runs.length,
    by_flow: byFlowResult,
    bottleneck_states: bottleneckStates,
    skip_rates: skipRates,
    total_spawns: runs.reduce((sum, r) => sum + r.total_spawns, 0),
  };
}
