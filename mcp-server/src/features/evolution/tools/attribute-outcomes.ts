/**
 * attribute-outcomes.ts — attribute_outcomes MCP tool handler.
 *
 * Thin handler: logic lives in services/outcome-attribution.ts (pure aggregation) and
 * the Layer 1 primitives it composes (attribution-join.ts, positive-attribution.ts,
 * attribution-weight.ts). Reuses the archive-read seams established by
 * attribute-failure.ts / select-mutation-targets.ts (resolveArtifactReadPath,
 * getDriftDb archive lookups) — does not re-implement path resolution. Builds the
 * shared corpus-artifact lookup (corpus-artifact-lookup.ts) ONCE per call and injects
 * it as attributeHonored's corpus-fallback join seam (ADR-0062, Bug-1 part (d)).
 *
 * Contract:
 * - project_dir is required -> INVALID_INPUT when absent.
 * - archive_ids defaults to every archive in drift.db (get_build_history's source).
 * - now defaults to the build corpus's max completed_at/archived_at (NEVER Date.now())
 *   — the scoring path threads a single now_ms, resolved once, down into the pure
 *   aggregator (dc-01 determinism).
 * - Returns ToolResult<AggregateOutcomesResult> — never throws for expected conditions.
 * - Fail-open: absent provenance/reviews/archives -> partial result (empty scores), not error.
 * - PURE QUERY — mutates nothing (command-query-separation). No node:child_process.
 *   No model calls.
 *
 * No-LLM verification: grep -niE 'anthropic|claude -p|messages.create|model:'
 * attribute-outcomes.ts -> zero hits.
 * Determinism verification: grep -n 'Date.now()' attribute-outcomes.ts -> zero hits in
 * the scoring path (the only Date usage is Date.parse on caller-supplied/corpus strings).
 *
 * ADR-002: ToolResult contract; no subprocess needed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunSummary } from "../../../platform/storage/archive/archive-types.ts";
import { getDriftDb } from "../../../platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "../../../shared/lib/tool-result.ts";
import { toolError, toolOk } from "../../../shared/lib/tool-result.ts";
import { resolveArtifactReadPath } from "../services/artifact-path-resolver.ts";
import { buildCorpusArtifactLookup } from "../services/corpus-artifact-lookup.ts";
import type { AggregateOutcomesResult, BuildRecord } from "../services/outcome-attribution.ts";
import { aggregateOutcomes } from "../services/outcome-attribution.ts";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const AttributeOutcomesInputSchema = z.object({
  archive_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Archive IDs to aggregate over (from get_build_history). Defaults to every " +
        "archive registered in drift.db for this project.",
    ),
  now: z
    .string()
    .optional()
    .describe(
      "ISO timestamp threaded into decay. Defaults to the build corpus's max " +
        "completed_at/archived_at (never the wall clock) — resolving it from caller " +
        "input or the corpus itself keeps the scoring path deterministic.",
    ),
  project_dir: z
    .string()
    .describe("Absolute path to the project root (contains .canon/ directory)."),
});

type AttributeOutcomesInput = z.input<typeof AttributeOutcomesInputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * attribute_outcomes — main handler.
 *
 * Wires: archive enumeration -> per-archive RunSummary + cliff-event read -> pure
 * aggregation -> ToolResult.
 *
 * @param pluginDir - Optional absolute plugin root; injected from server-state by
 *   register-evolution.ts so a trusted plugin-tier artifact absent from project_dir
 *   (foreign plugin install) is still found for the hash re-check. Not a public schema field.
 * @param decisions - Optional pre-resolved decisions corpus; injected by the composition
 *   root (app/register-evolution.ts via buildDecisionsCorpus) because
 *   no-cross-feature-internal-import forbids features/evolution/ from importing
 *   features/orchestration/services/decisions-corpus.ts directly — the same pattern
 *   app/register-knowledge.ts uses for ensureContextGraphFresh's decisions parameter.
 *   Not a public schema field. Defaults to [] (v1: threaded only to meta.decisions_seen,
 *   see outcome-attribution.ts file header).
 */
export async function attributeOutcomes(
  input: AttributeOutcomesInput,
  pluginDir?: string,
  decisions?: readonly unknown[],
): Promise<ToolResult<AggregateOutcomesResult>> {
  const { project_dir, archive_ids, now } = input;

  if (!project_dir) {
    return toolError("INVALID_INPUT", "project_dir is required.", false);
  }

  const db = getDriftDb(project_dir);
  const resolvedArchiveIds = archive_ids ?? db.getArchiveManifests().map((a) => a.archive_id);

  const builds: BuildRecord[] = [];
  for (const archiveId of resolvedArchiveIds) {
    const build = readBuildRecord(archiveId, project_dir);
    if (build !== null) builds.push(build);
  }

  const now_ms = resolveNowMs(now, builds);

  // readCurrentBody seam — fail-open; project_dir-first, pluginDir-fallback (same
  // cross-root resolver attribute_failure/select_mutation_targets use).
  const readCurrentBody = (artifactPath: string): string | null => {
    try {
      return readFileSync(resolveArtifactReadPath(artifactPath, project_dir, pluginDir), "utf-8");
    } catch {
      return null;
    }
  };

  // Built once per call (ADR-0062, Bug-1 part (d)) — the corpus-fallback join seam for
  // attributeHonored's no-provenance edge (shared with select_mutation_targets' scores
  // mode nomination resolver, corpus-artifact-lookup.ts).
  const resolveCorpusArtifact = await buildCorpusArtifactLookup(
    project_dir,
    pluginDir ?? project_dir,
  );

  const result = aggregateOutcomes({
    builds,
    decisions: decisions ?? [],
    now_ms,
    readCurrentBody,
    resolveCorpusArtifact,
  });

  return toolOk(result);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Read a single build's RunSummary + cliff events. Fail-open per archive: any
 * error (missing archive, missing/unparseable run-summary.json, missing/malformed
 * required fields) skips that archive entirely — never throws, never blocks the
 * rest of the corpus.
 */
function readBuildRecord(archiveId: string, projectDir: string): BuildRecord | null {
  try {
    const db = getDriftDb(projectDir);
    const archive = db.getArchiveById(archiveId);
    if (archive === null) return null;

    const summaryPath = join(archive.archive_path, "run-summary.json");
    const raw = readFileSync(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("run_metadata" in parsed) ||
      !("review_results" in parsed)
    ) {
      return null;
    }
    const summary = parsed as RunSummary;

    const slug = summary.run_metadata.slug;
    const cliffEvents =
      typeof slug === "string" && slug.length > 0 ? db.getCliffEvents().getByWorkspace(slug) : [];

    return { archive_id: archiveId, cliffEvents, summary };
  } catch (err: unknown) {
    console.warn(
      `[attribute_outcomes] readBuildRecord failed for archive_id=${archiveId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Resolve now_ms once, at the handler boundary — NEVER Date.now() (determinism, dc-01):
 *   1. Caller-supplied `now` (ISO), when parseable.
 *   2. Otherwise the build corpus's max completed_at/archived_at.
 *   3. Otherwise 0 (empty corpus — decay is a no-op either way).
 */
function resolveNowMs(now: string | undefined, builds: BuildRecord[]): number {
  if (now !== undefined) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return parsed;
  }
  let maxMs = 0;
  for (const build of builds) {
    const raw = build.summary.run_metadata.completed_at ?? build.summary.run_metadata.archived_at;
    if (raw === null || raw === undefined || raw === "") continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > maxMs) maxMs = parsed;
  }
  return maxMs;
}
