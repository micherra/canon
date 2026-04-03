/**
 * codebase-graph-materialize tool.
 *
 * Reads the KG from a completed job, runs post-pipeline steps (compliance overlay,
 * insights, layer enrichment), and returns CompactGraphOutput.
 *
 * This extracts the post-pipeline portion of codebaseGraph() for use after
 * background job completion.
 *
 * Canon principles:
 * - errors-are-values: returns ToolResult, INVALID_INPUT when job not complete
 * - no-hidden-side-effects: callers know the job must be complete before calling
 * - deep-modules: delegates graph building to codebaseGraph()
 */

import type { ToolResult } from '../utils/tool-result.ts';
import { toolError, toolOk } from '../utils/tool-result.ts';
import { getJobManager } from '../jobs/job-manager.ts';
import { codebaseGraph, compactGraph, type CompactGraphOutput } from './codebase-graph.ts';
import type { CodebaseGraphInput } from './codebase-graph.ts';

export interface GraphMaterializeInput {
  job_id: string;
  diff_base?: string;
  changed_files?: string[];
  detail_level?: 'file' | 'entity';
}

/**
 * Materialize the results of a completed codebase graph job.
 *
 * 1. Polls the job — returns INVALID_INPUT if not complete.
 * 2. Runs codebaseGraph to rebuild the full in-memory graph (reads KG from SQLite DB).
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
      'INVALID_INPUT',
      'Job manager not initialized. Submit a job first via codebase_graph_submit.',
    );
  }

  const pollResult = manager.poll(input.job_id);
  if (!pollResult.ok) {
    return pollResult;
  }

  if (pollResult.status !== 'complete') {
    return toolError(
      'INVALID_INPUT',
      `Job ${input.job_id} is not complete (status: ${pollResult.status}). Poll until status is 'complete' before materializing.`,
    );
  }

  // Step 2: Read KG from DB and build full graph
  const graphInput: CodebaseGraphInput = {
    diff_base: input.diff_base,
    changed_files: input.changed_files,
    detail_level: input.detail_level,
  };

  try {
    const fullGraph = await codebaseGraph(graphInput, projectDir, pluginDir);

    // Step 3: Compact and return with job_id attached
    const compact = compactGraph(fullGraph);
    return toolOk({
      ...compact,
      job_id: input.job_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError('UNEXPECTED', `Failed to materialize graph: ${message}`);
  }
}
