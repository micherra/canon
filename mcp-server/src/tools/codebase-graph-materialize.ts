/**
 * codebase-graph-materialize tool.
 *
 * Reads the KG from a completed job, runs post-pipeline steps (compliance overlay,
 * insights, layer enrichment), and returns CompactGraphOutput.
 *
 * The background worker already ran runPipeline and populated the KG DB.
 * Materialize reads directly from that DB — no pipeline re-run.
 *
 * Canon principles:
 * - errors-are-values: returns ToolResult, INVALID_INPUT when job not complete
 * - no-hidden-side-effects: callers know the job must be complete before calling
 * - deep-modules: delegates graph reading to readGraphFromDb()
 */

import { getJobManager } from "../jobs/job-manager.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import { toolError, toolOk } from "../utils/tool-result.ts";
import type { CodebaseGraphInput } from "./codebase-graph.ts";
import { type CompactGraphOutput, compactGraph, readGraphFromDb } from "./codebase-graph.ts";

export type GraphMaterializeInput = {
  job_id: string;
  diff_base?: string;
  changed_files?: string[];
  detail_level?: "file" | "entity";
};

/**
 * Materialize the results of a completed codebase graph job.
 *
 * 1. Polls the job — returns INVALID_INPUT if not complete.
 * 2. Reads the KG from the DB the background worker already populated (no pipeline re-run).
 * 3. Returns compactGraph(result) with the job_id attached.
 */
export async function codebaseGraphMaterialize(
  input: GraphMaterializeInput,
  projectDir: string,
  pluginDir: string,
): Promise<ToolResult<CompactGraphOutput & { job_id: string }>> {
  // Step 1: Check job status — must be complete
  const manager = getJobManager();
  if (!manager) {
    return toolError(
      "INVALID_INPUT",
      "Job manager not initialized. Submit a job first via codebase_graph_submit.",
    );
  }

  const pollResult = manager.poll(input.job_id);
  if (!pollResult.ok) {
    return pollResult;
  }

  if (pollResult.status !== "complete") {
    return toolError(
      "INVALID_INPUT",
      `Job ${input.job_id} is not complete (status: ${pollResult.status}). Poll until status is 'complete' before materializing.`,
    );
  }

  // Step 2: Read from the KG DB the background job already populated.
  // readGraphFromDb skips runPipeline — the worker already ran the heavy pipeline work.
  const graphInput: CodebaseGraphInput = {
    changed_files: input.changed_files,
    detail_level: input.detail_level,
    diff_base: input.diff_base,
  };

  try {
    const fullGraph = await readGraphFromDb(graphInput, projectDir, pluginDir);

    // Step 3: Compact and return with job_id attached
    const compact = compactGraph(fullGraph);
    return toolOk({
      ...compact,
      job_id: input.job_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError("UNEXPECTED", `Failed to materialize graph: ${message}`);
  }
}
