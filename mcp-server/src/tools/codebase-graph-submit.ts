/**
 * codebase-graph-submit tool.
 *
 * Submits a background codebase graph generation job via JobManager.
 * Returns immediately with job_id + status for async callers.
 * In sync mode (CI / CANON_SYNC_JOBS=1), runs inline and returns complete.
 *
 * Canon principles:
 * - errors-are-values: returns ToolResult<SubmitResult>, never throws
 * - no-hidden-side-effects: deduplicated/cached flags surface what happened
 * - deep-modules: delegates all complexity to JobManager
 */

import type { ToolResult } from '../utils/tool-result.ts';
import type { SubmitResult } from '../jobs/job-manager.ts';
import { getOrCreateJobManager } from '../jobs/job-manager.ts';
import { deriveSourceDirsFromLayers } from '../utils/config.ts';
import type { CodebaseGraphInput } from './codebase-graph.ts';

export interface GraphSubmitInput extends CodebaseGraphInput {
  /** Skip cache, force new run (not yet implemented — reserved). */
  force?: boolean;
}

/**
 * Submit a codebase graph job.
 *
 * Computes sourceDirs from input (same logic as codebaseGraph), then delegates
 * to jobManager.submit(). Returns ToolResult<SubmitResult>.
 */
export async function codebaseGraphSubmit(
  input: GraphSubmitInput,
  projectDir: string,
  pluginDir: string,
): Promise<ToolResult<SubmitResult>> {
  // Resolve source directories — explicit overrides config-derived
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs || undefined;

  const manager = getOrCreateJobManager(projectDir, pluginDir);
  return manager.submit(input, sourceDirs ?? undefined);
}
