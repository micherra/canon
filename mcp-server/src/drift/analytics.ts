/**
 * Flow run persistence — appends completed flow run entries to
 * flow-runs.jsonl. Used by update-board.ts on flow completion.
 */

import { join } from "path";
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
}

function flowRunsPath(projectDir: string): string {
  return join(projectDir, CANON_DIR, "flow-runs.jsonl");
}

export async function appendFlowRun(projectDir: string, entry: FlowRunEntry): Promise<void> {
  const path = flowRunsPath(projectDir);
  await appendJsonl(path, entry);
  await rotateIfNeeded(path);
}
