/**
 * Context enrichment assembly module.
 *
 * Assembles a ${enrichment} block containing git history, drift signals,
 * prior workspace artifacts, and tension analysis for files in task scope.
 *
 * This module is called from enterAndPrepareState at Step 4.7 (between
 * Step 4.6 review scope and Step 5 spawn prompt). It is non-blocking:
 * any failure degrades gracefully to empty enrichment.
 *
 * NOTE: This is a stub. The full implementation is provided by enr-02.
 * The stub satisfies the enr-03 integration contract so tests can verify
 * the pipeline wiring independently of the enrichment assembly logic.
 */

import type { Board, ResolvedFlow } from "./flow-schema.ts";

export interface EnrichmentInput {
  workspace: string;
  stateId: string;
  board: Board;
  flow: ResolvedFlow;
  baseCommit?: string;
  cwd: string;
  projectDir?: string;
}

export interface EnrichmentResult {
  /** The assembled ${enrichment} block, or empty string */
  content: string;
  warnings: string[];
}

/** Budget caps by flow tier (number of files to include per section). */
export const TIER_FILE_CAPS: Record<string, number> = {
  hotfix: 5,
  feature: 15,
  epic: 30,
};

export const MAX_ENRICHMENT_CHARS = 6000;

/**
 * Assemble context enrichment for the given task scope.
 *
 * Returns enrichment content and any non-blocking warnings.
 * Never throws — callers rely on this being fail-safe.
 */
export async function assembleEnrichment(
  _input: EnrichmentInput,
): Promise<EnrichmentResult> {
  // Stub implementation — returns empty enrichment.
  // The full implementation (enr-02) replaces this with:
  // 1. resolveTaskScope to get file paths
  // 2. assembleGitSection for recent git history
  // 3. assembleDriftSection for drift signals
  // 4. assembleWorkspaceSection for prior workspace artifacts
  // 5. assembleTensionsSection for cross-referenced tensions
  return { content: "", warnings: [] };
}
