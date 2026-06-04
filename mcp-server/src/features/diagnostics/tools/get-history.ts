/**
 * get_history — Query flow execution history with associated decisions.
 *
 * Returns recent flow runs from drift.db, sorted newest-first, optionally filtered
 * by flow name. Each run is enriched with its associated decision records.
 *
 * Follows toolresult-contract: returns ToolResult<GetHistoryResult>, never throws.
 * Follows define-errors-out-of-existence: empty DB returns { flow_runs: [], total_decisions: 0 }.
 * Follows no-silent-failures: unexpected errors are caught by wrapHandler in index.ts.
 */

import type { DecisionEntry, FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";

export const GetHistoryInputSchema = z.object({
  flow: z.string().optional().describe("Filter by flow name (e.g., 'feature', 'fast-path')"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(20)
    .describe("Maximum number of flow runs to return"),
  project_dir: z.string().describe("Project root directory path"),
});

/** Raw input type before Zod parsing (limit is optional, default applied at parse time). */
export type GetHistoryInput = z.input<typeof GetHistoryInputSchema>;

export type GetHistoryResult = {
  flow_runs: Array<FlowRunEntry & { decisions: DecisionEntry[] }>;
  total_decisions: number;
};

const DEFAULT_LIMIT = 20;

export const getHistory = async (
  rawInput: GetHistoryInput,
): Promise<ToolResult<GetHistoryResult>> => {
  // Apply Zod defaults so callers without limit get 20
  const input = GetHistoryInputSchema.parse(rawInput);
  const limit = input.limit ?? DEFAULT_LIMIT;

  const driftDb = getDriftDb(input.project_dir);

  // Get all flow runs (may be filtered by flow name)
  let runs = driftDb.getAllFlowRuns();
  if (input.flow !== undefined) {
    runs = runs.filter((r) => r.flow === input.flow);
  }

  // Sort by completed desc (newest first), then take limit
  runs.sort((a, b) => b.completed.localeCompare(a.completed));
  runs = runs.slice(0, limit);

  // Enrich each run with its associated decisions
  const enriched = runs.map((run) => ({
    ...run,
    decisions: driftDb.getDecisionsByRun(run.run_id),
  }));

  // Count total decisions across all runs in the database
  const totalDecisions = driftDb.getRecentDecisions(1_000_000).length;

  return toolOk({ flow_runs: enriched, total_decisions: totalDecisions });
};
