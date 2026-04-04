/**
 * codebase-graph-poll tool.
 *
 * Synchronous DB read — returns the current status of a background job.
 * No async I/O — purely reads from the SQLite job store.
 *
 * Canon principles:
 * - errors-are-values: INVALID_INPUT for missing job_id, not an exception
 * - deep-modules: delegates to JobManager.poll()
 */

import type { PollResult } from "../jobs/job-manager.ts";
import { getJobManager } from "../jobs/job-manager.ts";
import type { ToolResult } from "../shared/lib/tool-result.ts";
import { toolError } from "../shared/lib/tool-result.ts";

export type GraphPollInput = {
  job_id: string;
};

/**
 * Poll the status of a background codebase graph job.
 *
 * Synchronous — reads DB only; no async I/O.
 * Returns INVALID_INPUT if the job_id does not exist or the manager is not initialized.
 */
export function codebaseGraphPoll(input: GraphPollInput): ToolResult<PollResult> {
  const manager = getJobManager();
  if (!manager) {
    return toolError(
      "INVALID_INPUT",
      "Job manager not initialized. Submit a job first via codebase_graph_submit.",
    );
  }
  return manager.poll(input.job_id);
}
