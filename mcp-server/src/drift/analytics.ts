/**
 * Flow run persistence — appends completed flow run entries to
 * flow-runs.jsonl. Used by update-board.ts on flow completion.
 */

import { join } from "path";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { CANON_DIR } from "../constants.ts";
import { appendJsonl, rotateIfNeeded } from "./jsonl-store.ts";

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
  // Aggregated quality signals (optional — absent for old entries and runs with no gate/postcondition data)
  gate_pass_rate?: number;
  postcondition_pass_rate?: number;
  total_violations?: number;
  total_test_results?: { passed: number; failed: number; skipped: number };
  total_files_changed?: number;
}

export interface FlowAnalytics {
  total_runs: number;
  avg_duration_ms: number;
  avg_gate_pass_rate?: number;
  avg_postcondition_pass_rate?: number;
}

function flowRunsPath(projectDir: string): string {
  return join(projectDir, CANON_DIR, "flow-runs.jsonl");
}

export async function appendFlowRun(projectDir: string, entry: FlowRunEntry): Promise<void> {
  const path = flowRunsPath(projectDir);
  await appendJsonl(path, entry);
  await rotateIfNeeded(path);
}

/**
 * Read all flow run entries from flow-runs.jsonl and compute aggregate analytics.
 * Returns totals and averages. New fields (avg_gate_pass_rate, avg_postcondition_pass_rate)
 * are only present when at least one run has the corresponding data.
 */
export async function computeAnalytics(projectDir: string): Promise<FlowAnalytics> {
  const path = flowRunsPath(projectDir);

  if (!existsSync(path)) {
    return { total_runs: 0, avg_duration_ms: 0 };
  }

  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    return { total_runs: 0, avg_duration_ms: 0 };
  }

  const entries: FlowRunEntry[] = lines.map((l) => JSON.parse(l));

  let totalDuration = 0;
  let gatePassRateSum = 0;
  let gatePassRateCount = 0;
  let postconditionPassRateSum = 0;
  let postconditionPassRateCount = 0;

  for (const entry of entries) {
    totalDuration += entry.total_duration_ms ?? 0;
    if (entry.gate_pass_rate != null) {
      gatePassRateSum += entry.gate_pass_rate;
      gatePassRateCount++;
    }
    if (entry.postcondition_pass_rate != null) {
      postconditionPassRateSum += entry.postcondition_pass_rate;
      postconditionPassRateCount++;
    }
  }

  const result: FlowAnalytics = {
    total_runs: entries.length,
    avg_duration_ms: entries.length > 0 ? totalDuration / entries.length : 0,
  };

  if (gatePassRateCount > 0) {
    result.avg_gate_pass_rate = gatePassRateSum / gatePassRateCount;
  }
  if (postconditionPassRateCount > 0) {
    result.avg_postcondition_pass_rate = postconditionPassRateSum / postconditionPassRateCount;
  }

  return result;
}
