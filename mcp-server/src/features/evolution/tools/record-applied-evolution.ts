/**
 * record-applied-evolution.ts — record_applied_evolution MCP tool handler.
 *
 * Writes one durable apply-provenance row to drift.db `applied_evolutions` when
 * an evolution-candidate is applied (ADR-0034). This is the AUTHORITATIVE write —
 * fail-closed: any storage failure returns a `ToolResult` error (never fail-open),
 * since a lost provenance record defeats the purpose of the build. The command
 * layer surfaces the error to the user but does not roll back the apply.
 *
 * Contract:
 * - Input carries pre-computed `before_hash` / `after_hash` (the call-site hashes
 *   on-disk content via `hashContent`). The tool does not read files.
 * - `principle_id` is nullable (null for agent-def cliff targets).
 * - `apply_base_commit` is optional; `applying_commit` is never written here — it
 *   is back-filled later from the Canon-Evolution: trailer.
 * - Reaches drift.db via `getDriftDb(project_dir)` (mirrors attribute_failure).
 *
 * ADR-002: ToolResult contract; no subprocess, no node:child_process, no model calls.
 * no-cross-feature-internal-import: imports only @platform/storage/drift + @shared/lib.
 */

import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const RecordAppliedEvolutionInputSchema = z.object({
  after_hash: z
    .string()
    .describe("sha256 hex of the applied candidate body (post-edit on-disk content)."),
  applied_at: z
    .string()
    .describe(
      "ISO-8601 timestamp of the apply. THE cohort-split anchor for get_evolution_outcomes.",
    ),
  apply_base_commit: z
    .string()
    .optional()
    .describe(
      "git rev-parse HEAD at apply time (audit anchor). Optional — the apply does not commit.",
    ),
  artifact_class: z
    .string()
    .describe(
      "Artifact class of the mutated target: principle | rule | primer | agent | template.",
    ),
  before_hash: z
    .string()
    .describe("sha256 hex of the on-disk target content BEFORE the apply edited it."),
  holdout_baseline: z
    .number()
    .int()
    .describe("Gen-time §7 holdout baseline pass count recorded on the proposal."),
  holdout_candidate: z
    .number()
    .int()
    .describe("Gen-time §7 holdout candidate pass count recorded on the proposal."),
  principle_id: z
    .string()
    .nullable()
    .optional()
    .describe("Principle the target carries; null for agent-def cliff targets."),
  project_dir: z
    .string()
    .describe("Absolute path to the project root (contains .canon/). Drift.db lives under it."),
  proposal_id: z
    .string()
    .describe(
      "MutationProposal.id — the UNIQUE key. Re-recording the same id is an idempotent upsert.",
    ),
  target_path: z.string().describe("Repo-relative path of the mutated artifact."),
});

type RecordAppliedEvolutionInput = z.input<typeof RecordAppliedEvolutionInputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * record_applied_evolution — authoritative, fail-closed apply-provenance write.
 *
 * @returns `{ ok: true, proposal_id }` on a successful write; a `ToolResult`
 *   error (`INVALID_INPUT` for empty ids, `UNEXPECTED` for a storage failure)
 *   otherwise. Never fail-open — a storage failure is surfaced, not swallowed.
 */
export async function recordAppliedEvolution(
  input: RecordAppliedEvolutionInput,
): Promise<ToolResult<{ proposal_id: string }>> {
  const { project_dir, proposal_id } = input;

  if (!proposal_id) {
    return toolError("INVALID_INPUT", "proposal_id must be a non-empty string.", false);
  }
  if (!project_dir) {
    return toolError("INVALID_INPUT", "project_dir must be a non-empty string.", false);
  }

  try {
    getDriftDb(project_dir)
      .getAppliedEvolutions()
      .record({
        after_hash: input.after_hash,
        applied_at: input.applied_at,
        apply_base_commit: input.apply_base_commit ?? null,
        artifact_class: input.artifact_class,
        before_hash: input.before_hash,
        holdout_baseline: input.holdout_baseline,
        holdout_candidate: input.holdout_candidate,
        principle_id: input.principle_id ?? null,
        proposal_id,
        target_path: input.target_path,
      });
    return toolOk({ proposal_id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail-closed: authoritative write. Surface the storage failure as an error.
    return toolError("UNEXPECTED", `apply-provenance record failed: ${message}`, false);
  }
}
