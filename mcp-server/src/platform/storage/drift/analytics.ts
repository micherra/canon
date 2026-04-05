/**
 * Flow run persistence — appends completed flow run entries and computes analytics.
 *
 * Delegates to DriftDb (SQLite-backed). The async interface is preserved for
 * backward compatibility with callers that use `await appendFlowRun(...)` and
 * `await computeAnalytics(...)`.
 */

import type { FlowAnalytics, FlowRunEntry } from "./drift-analytics-types.ts";
import { getDriftDb } from "./drift-db.ts";

// Re-export interfaces so callers continue to `import { FlowRunEntry, FlowAnalytics } from "./analytics.ts"`
export type { FlowAnalytics, FlowRunEntry } from "./drift-analytics-types.ts";

/**
 * Append a completed flow run entry to drift.db.
 * Returns a resolved Promise for backward compatibility with callers that await this.
 */
export async function appendFlowRun(projectDir: string, entry: FlowRunEntry): Promise<void> {
  getDriftDb(projectDir).appendFlowRun(entry);
}

/**
 * Compute aggregate analytics from all flow runs in drift.db.
 * Returns a resolved Promise for backward compatibility with callers that await this.
 */
export async function computeAnalytics(projectDir: string): Promise<FlowAnalytics> {
  return getDriftDb(projectDir).computeAnalytics();
}
