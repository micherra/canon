/**
 * get_build_history tool — list archived build runs with metadata.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: Zod schema on all MCP tool inputs
 *   - bounded-context-boundaries: imports from shared kernel and history-types only
 */

import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import type { BuildHistoryResult } from "../history-types.ts";

export const GetBuildHistoryInputSchema = z.object({
  branch: z.string().optional().describe("Filter by branch name"),
  flow: z.string().optional().describe("Filter by flow name"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(20)
    .describe("Max entries to return (default 20)"),
  project_dir: z.string().describe("Project root directory path"),
});

export type GetBuildHistoryInput = z.input<typeof GetBuildHistoryInputSchema>;

/**
 * List archived build runs with optional filters.
 *
 * Queries drift.db for archive manifests. Returns archives sorted by
 * archived_at descending (most recent first). Never throws — returns
 * empty archives array when database has no entries.
 *
 * @param rawInput - Raw tool input; validated by Zod before use
 */
export async function getBuildHistory(
  rawInput: GetBuildHistoryInput,
): Promise<ToolResult<BuildHistoryResult>> {
  const input = GetBuildHistoryInputSchema.parse(rawInput);
  const { project_dir, branch, flow, limit } = input;

  const db = getDriftDb(project_dir);

  const archives = db.getArchiveManifests({ branch, flow, limit });
  const total_count = db.countArchives();

  return toolOk({ archives, total_count });
}
