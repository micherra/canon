/**
 * Craft Audit Service — Reusable logic for /canon:craft-audit command.
 *
 * Provides two focused functions following pure-io-service-split:
 * - selectAuditAreas: pure compute (takes KG results, returns subsystem keys)
 * - persistAuditProfile: the single effect (validate + write via CraftProfileDao)
 *
 * Canon principles:
 * - pure-io-service-split: area selection is pure; KG I/O happens in the command
 * - simplicity-first: thin glue reusing deriveSubsystemKey + existing DAO
 * - define-errors-out-of-existence: empty input → empty output; unknown areas → keyed+stored
 */

import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
import type { CraftDimensionRating } from "@shared/schema.ts";
import { CraftProfileSchema } from "@shared/schema.ts";
import type { CraftProfileDao } from "@platform/storage/drift/craft-profile-dao.ts";

// ---- Types ----

/** Options for selecting which areas to audit. */
export type SelectAuditAreasOpts = {
  /** Explicit subsystem area keys to audit. When provided, bypasses ranked_files. */
  areas?: string[];
  /**
   * Ranked list of file paths from the knowledge graph (e.g., by blast radius / centrality).
   * The service maps these to subsystem keys via deriveSubsystemKey and dedupes.
   * PASSED IN — the service does NOT call graph_query itself (pure-io-service-split).
   */
  ranked_files?: string[];
  /**
   * Maximum number of distinct subsystem keys to return.
   * Ignored when areas is provided.
   */
  limit?: number;
};

/** Input for persisting a single audit profile. */
export type PersistAuditProfileInput = {
  subsystem_key: string;
  ratings: CraftDimensionRating[];
  rollup?: number;
};

// ---- Pure compute helpers ----

/** Deduplicate an array of strings while preserving order. */
function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

/**
 * Map ranked file paths to distinct subsystem keys, bounded by limit.
 * Pure: accepts file list as parameter, performs no I/O.
 */
function subsystemKeysFromFiles(rankedFiles: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of rankedFiles) {
    if (result.length >= limit) break;
    const key = deriveSubsystemKey(file);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

// ---- Pure compute ----

/**
 * Select audit areas to evaluate.
 *
 * When `areas` is provided, deduplicates and returns them as-is.
 * Otherwise, takes the ranked file list (from KG blast_radius results),
 * maps each file to its subsystem key via deriveSubsystemKey, deduplicates,
 * and returns at most `limit` distinct keys in ranked order.
 *
 * Returns empty array for empty or missing inputs (define-errors-out-of-existence).
 *
 * This function is pure: it accepts KG results as parameters and
 * performs no I/O (pure-io-service-split).
 */
export function selectAuditAreas(opts: SelectAuditAreasOpts): string[] {
  if (opts.areas !== undefined) {
    return dedup(opts.areas);
  }
  const rankedFiles = opts.ranked_files ?? [];
  if (rankedFiles.length === 0) return [];
  return subsystemKeysFromFiles(rankedFiles, opts.limit ?? rankedFiles.length);
}

// ---- Single effect ----

/**
 * Validate and persist one audit area's craft profile.
 *
 * Validates the input against CraftProfileSchema (same schema as the reviewer).
 * Throws a ZodError on validation failure — no row is written on error.
 *
 * Writes via CraftProfileDao with source:'audit', flow:undefined, run_id:undefined
 * (no build coupling — define-errors-out-of-existence: unknown area → keyed+stored).
 *
 * @param input - subsystem key, ratings, optional rollup
 * @param dao - CraftProfileDao instance (caller provides for testability)
 */
export function persistAuditProfile(
  input: PersistAuditProfileInput,
  dao: CraftProfileDao,
): void {
  // Validate before write — throws ZodError on invalid input
  CraftProfileSchema.parse({ ratings: input.ratings, rollup: input.rollup });

  dao.insertProfile({
    subsystem_key: input.subsystem_key,
    source: "audit",
    ratings: input.ratings,
    rollup: input.rollup,
    // flow and run_id explicitly not set (undefined → null in DAO)
  });
}
