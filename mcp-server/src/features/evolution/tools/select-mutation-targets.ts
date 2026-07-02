/**
 * select-mutation-targets.ts — select_mutation_targets MCP tool handler.
 *
 * Thin handler: logic lives in services/mutation-selection.ts.
 * Mirrors attribute-failure.ts composition pattern:
 *   readProvenance → collectFailureSources/collectArchivedFailureSources
 *     → attributeFailures → selectMutationTargets.
 *
 * Contract:
 * - Exactly ONE of workspace or archive_id must be provided → INVALID_INPUT otherwise.
 * - Returns ToolResult<SelectMutationTargetsResult> — never throws for expected conditions.
 * - Fail-open: absent provenance or reviews → partial result (empty targets), not error.
 * - No node:child_process. No model calls. Deterministic join + rank + read only.
 *
 * ADR-002: ToolResult contract; no subprocess needed.
 * no-llm-calls-in-mcp-tools: pure join+rank+read — ZERO model calls.
 *   Verified by: grep -rniE 'anthropic|claude -p|messages.create|model:' select-mutation-targets.ts
 */

import { existsSync, readFileSync } from "node:fs";
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
import type { FailureAttribution } from "../services/attribution-types.ts";
import { selectMutationTargets } from "../services/mutation-selection.ts";
import type { SelectMutationTargetsResult } from "../services/mutation-types.ts";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const SelectMutationTargetsInputSchema = z.object({
  archive_id: z
    .string()
    .optional()
    .describe(
      "Archive ID of a completed build (from get_build_history). " +
        "Exactly one of workspace or archive_id must be provided.",
    ),
  max_targets_per_pass: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum number of mutation targets to select per pass. " +
        "Defaults to DEFAULT_MAX_TARGETS_PER_PASS (3). " +
        "Overflow targets land in skipped with reason budget_exhausted.",
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

type SelectMutationTargetsInput = z.input<typeof SelectMutationTargetsInputSchema>;

// ---------------------------------------------------------------------------
// Helpers — extracted to keep the handler under the line/complexity limits
// ---------------------------------------------------------------------------

/**
 * readBodiesAndExistence — read baseline bodies + existence for each attribution.
 *
 * I/O injected here so selectMutationTargets stays pure.
 * Resolves each path project_dir-first with a pluginDir fallback for trusted
 * plugin-tier artifacts (resolveArtifactReadPath); existence + body keys stay on
 * the ORIGINAL relative path so downstream lookups are unaffected.
 * Fail-open: file-read errors return "" rather than propagating.
 */
function readBodiesAndExistence(
  attributions: FailureAttribution[],
  projectDir: string,
  pluginDir?: string,
): { bodies: Record<string, string>; existing: Record<string, boolean> } {
  const bodies: Record<string, string> = {};
  const existing: Record<string, boolean> = {};

  for (const attr of attributions) {
    const path = attr.target_artifact.path;
    const resolved = resolveArtifactReadPath(path, projectDir, pluginDir);
    const fileExists = existsSync(resolved);
    existing[path] = fileExists;
    if (fileExists) {
      try {
        bodies[path] = readFileSync(resolved, "utf-8");
      } catch {
        bodies[path] = "";
      }
    } else {
      bodies[path] = "";
    }
  }

  return { bodies, existing };
}

/**
 * collectAttributionSources — reads provenance + failure sources for the
 * given workspace or archive_id.
 */
function collectAttributionSources(
  workspace: string | undefined,
  archiveId: string | undefined,
  projectDir: string,
  readCurrentBody: (p: string) => string | null,
) {
  const provenance = workspace
    ? readProvenance({ kind: "live", workspace })
    : readProvenance({ archive_id: archiveId!, kind: "archived", project_dir: projectDir });

  const { cliffEvents, violations } = workspace
    ? collectFailureSources(workspace, projectDir)
    : collectArchivedFailureSources(archiveId!, projectDir);

  return attributeFailures({ cliffEvents, provenance, readCurrentBody, violations });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * selectMutationTargetsHandler — main handler.
 *
 * Wires:
 *   provenance source → failure sources → pure join → baseline body reads
 *     → selectMutationTargets → ToolResult.
 *
 * Mirrors attribute-failure.ts composition exactly (consumes AS-IS).
 * Extends it with: body reads + existence checks + selectMutationTargets call.
 *
 * Fail-open for every source: absent provenance, absent REVIEW.md, absent
 * artifact bodies all produce partial results rather than errors.
 *
 * @param pluginDir - Optional absolute plugin root; injected from server-state by
 *   register-evolution.ts so a trusted plugin-tier artifact absent from project_dir
 *   (foreign plugin install) is still found for the hash re-check + baseline read.
 *   Not a public schema field.
 */
export async function selectMutationTargetsHandler(
  input: SelectMutationTargetsInput,
  pluginDir?: string,
): Promise<ToolResult<SelectMutationTargetsResult>> {
  const { workspace, archive_id, project_dir, max_targets_per_pass } = input;

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

  // readCurrentBody seam — fail-open; project_dir-first, pluginDir-fallback
  const readCurrentBody = (artifactPath: string): string | null => {
    try {
      return readFileSync(resolveArtifactReadPath(artifactPath, project_dir, pluginDir), "utf-8");
    } catch {
      return null;
    }
  };

  // Run the attribution pipeline
  const joinResult = collectAttributionSources(workspace, archive_id, project_dir, readCurrentBody);

  // Read baseline bodies + existence (I/O injected here; selectMutationTargets stays pure)
  const { bodies, existing } = readBodiesAndExistence(
    joinResult.attributions,
    project_dir,
    pluginDir,
  );

  // Pure selection
  const selectionResult = selectMutationTargets(joinResult.attributions, bodies, existing, {
    maxTargetsPerPass: max_targets_per_pass,
  });

  return toolOk(selectionResult);
}
