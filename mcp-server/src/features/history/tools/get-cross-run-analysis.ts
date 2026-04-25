/**
 * get_cross_run_analysis tool — cross-run meta-analysis for the learner agent.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: Zod schema on all MCP tool inputs
 *   - bounded-context-boundaries: imports from shared kernel and history-types only
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import type { CrossRunAnalysisResult, RunSummary } from "../history-types.ts";
import { analyzeCrossRunPatterns } from "../services/cross-run-analyzer.ts";

export const GetCrossRunAnalysisInputSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe("Max archive entries to analyze (default 50)"),
  project_dir: z.string().describe("Project root directory path"),
  since: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp — only include runs archived after this time"),
});

export type GetCrossRunAnalysisInput = z.input<typeof GetCrossRunAnalysisInputSchema>;

/**
 * Compute a cross-run analysis from archived build summaries.
 *
 * Loads run summaries from archives that have `has_run_summary: true`,
 * then calls analyzeCrossRunPatterns() to compute recurring violations,
 * fix cycle patterns, agent performance trends, and planner patterns.
 *
 * When no archives exist, returns an empty analysis with current timestamp
 * as the analysis window.
 *
 * @param rawInput - Raw tool input; validated by Zod before use
 */
export async function getCrossRunAnalysis(
  rawInput: GetCrossRunAnalysisInput,
): Promise<ToolResult<CrossRunAnalysisResult>> {
  const input = GetCrossRunAnalysisInputSchema.parse(rawInput);
  const { project_dir, since, limit } = input;

  const db = getDriftDb(project_dir);

  // 1. Fetch archive manifests (limited)
  const archives = db.getArchiveManifests({ limit });

  // 2. Filter to those that have a run summary
  const archivesWithSummary = archives.filter((a) => a.has_run_summary);

  // 3. Read run-summary.json for each, skip on failure
  const summaries: RunSummary[] = [];
  for (const archive of archivesWithSummary) {
    const summaryPath = join(archive.archive_path, "run-summary.json");

    if (!existsSync(summaryPath)) continue;

    try {
      const raw = readFileSync(summaryPath, "utf-8");
      const parsed = JSON.parse(raw) as RunSummary;
      summaries.push(parsed);
    } catch {
      // Skip malformed or unreadable summaries
    }
  }

  // 4. Apply since filter if provided
  const filteredSummaries =
    since !== undefined ? summaries.filter((s) => s.run_metadata.archived_at >= since) : summaries;

  // 5. Run cross-run analysis
  const result = analyzeCrossRunPatterns(db, filteredSummaries, { limit, since });

  return toolOk(result);
}
