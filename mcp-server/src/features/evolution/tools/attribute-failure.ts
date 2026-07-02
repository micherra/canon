/**
 * attribute-failure.ts — attribute_failure MCP tool handler.
 *
 * Thin handler: logic lives in services/attribution-join.ts,
 * services/attribution-provenance-source.ts, and services/attribution-failure-sources.ts.
 *
 * Contract:
 * - Exactly ONE of workspace or archive_id must be provided → INVALID_INPUT otherwise.
 * - Returns ToolResult<AttributeFailureResult> — never throws for expected conditions.
 * - Fail-open: absent provenance, reviews, or cliff events → partial result, not error.
 * - No node:child_process. No model calls. Deterministic join only.
 *
 * ADR-002: ToolResult contract; no subprocess needed.
 * no-llm-calls-in-mcp-tools: deterministic equality join + sha256 hashing only.
 */

import { readFileSync } from "node:fs";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import { resolveArtifactReadPath } from "../services/artifact-path-resolver.ts";
import {
  collectArchivedFailureSources,
  collectFailureSources,
} from "../services/attribution-failure-sources.ts";
import { attributeFailures } from "../services/attribution-join.ts";
import { readProvenance } from "../services/attribution-provenance-source.ts";
import type { AttributeFailureResult } from "../services/attribution-types.ts";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const AttributeFailureInputSchema = z.object({
  archive_id: z
    .string()
    .optional()
    .describe(
      "Archive ID of a completed build (from get_build_history). " +
        "Exactly one of workspace or archive_id must be provided.",
    ),
  project_dir: z
    .string()
    .describe(
      "Absolute path to the project root (contains .canon/ directory). " +
        "Required for artifact body reads, drift.db cliff events, and archive lookups.",
    ),
  workspace: z
    .string()
    .optional()
    .describe(
      "Absolute path to the live Canon workspace directory. " +
        "Exactly one of workspace or archive_id must be provided.",
    ),
});

type AttributeFailureInput = z.input<typeof AttributeFailureInputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * attribute_failure — main handler.
 *
 * Wires: provenance source → failure sources → pure join → ToolResult.
 * readCurrentBody seam reads artifact bodies via resolveArtifactReadPath
 * (project_dir-first, pluginDir-fallback for trusted plugin-tier artifacts;
 * fail-open: null on missing).
 *
 * @param pluginDir - Optional absolute plugin root; injected from server-state by
 *   register-evolution.ts so a trusted plugin-tier artifact absent from project_dir
 *   (foreign plugin install) is still found. Not a public schema field.
 */
export async function attributeFailure(
  input: AttributeFailureInput,
  pluginDir?: string,
): Promise<ToolResult<AttributeFailureResult>> {
  const { workspace, archive_id, project_dir } = input;

  // Validate: exactly one of workspace / archive_id
  if (!workspace && !archive_id) {
    return toolError(
      "INVALID_INPUT",
      "Exactly one of 'workspace' or 'archive_id' must be provided.",
      false,
    );
  }
  if (workspace && archive_id) {
    return toolError(
      "INVALID_INPUT",
      "Provide exactly one of 'workspace' or 'archive_id', not both.",
      false,
    );
  }

  // 1. Read provenance (fail-open: [] on any error)
  const provenance = workspace
    ? readProvenance({ kind: "live", workspace })
    : readProvenance({ archive_id: archive_id!, kind: "archived", project_dir });

  // 2. Collect failure sources (fail-open per source)
  // Live workspace: collect from workspace reviews/ + drift.db cliff events.
  // Archived build: read review_results from archived run-summary.json and
  //   cliff events from drift.db using the archive's run_metadata.slug.
  const { violations, cliffEvents } = workspace
    ? collectFailureSources(workspace, project_dir)
    : collectArchivedFailureSources(archive_id!, project_dir);

  // 3. readCurrentBody seam — reads artifact via the cross-root resolver, fail-open.
  // Absolute provenance paths are honored as-is; relative paths resolve project_dir
  // first, then fall back to pluginDir for a trusted plugin-tier artifact absent
  // from project_dir (foreign plugin install). Overlay (.canon/) never falls back.
  const readCurrentBody = (artifactPath: string): string | null => {
    try {
      return readFileSync(resolveArtifactReadPath(artifactPath, project_dir, pluginDir), "utf-8");
    } catch {
      return null;
    }
  };

  // 4. Pure join
  const result = attributeFailures({
    cliffEvents,
    provenance,
    readCurrentBody,
    violations,
    // transcript excerpt seam: not wired in this build (getTranscript requires async I/O
    // and the join is synchronous). Transcript evidence will be empty in v1.
    // Wire in a future pass by making attributeFailures async or pre-fetching transcripts.
  });

  return toolOk(result);
}
