/**
 * Area Memory Enrichment Service — Feed-forward area context for agent prompts.
 *
 * Queries drift.db for recent observations from prior builds in the areas
 * being worked on, formats them into a structured markdown section for
 * agent context injection.
 *
 * Follows the pitfall-enrichment.ts pattern exactly.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty arrays produce empty string; fail-open wrapper
 * - simplicity-first: three focused functions — query, format, build
 * - errors-are-values: typed return values; no thrown errors for expected conditions
 */

import type { AreaMemoryDao, AreaObservationRow } from "@platform/storage/drift/area-memory-dao.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";

// ---- Query function ----

/**
 * Query area observations for the given file paths.
 *
 * Derives subsystem keys from all file paths, deduplicates them,
 * queries the DAO, and caps results at 5 entries.
 *
 * Returns empty array for empty input (define-errors-out-of-existence).
 */
export function queryAreaObservations(
  filePaths: string[],
  areaMemoryDao: AreaMemoryDao,
): AreaObservationRow[] {
  if (filePaths.length === 0) return [];

  // Derive and deduplicate subsystem keys
  const keySet = new Set<string>();
  for (const fp of filePaths) {
    keySet.add(deriveSubsystemKey(fp));
  }
  const uniqueKeys = Array.from(keySet);

  const observations = areaMemoryDao.getObservationsForSubsystems(uniqueKeys);

  // Cap at 5
  return observations.slice(0, 5);
}

// ---- Formatting function ----

/**
 * Format area observations into a structured markdown section.
 *
 * Returns empty string for empty array (define-errors-out-of-existence).
 * Caps at 5 entries.
 *
 * Output format:
 * ```
 * ## Area Memory
 *
 * Recent observations from prior builds in the areas you're working in:
 *
 * - [{source}, {relative_date}] {content} (area: {subsystem_key})
 * ```
 */
export function formatAreaMemorySection(observations: AreaObservationRow[]): string {
  if (observations.length === 0) return "";

  const lines: string[] = [
    "## Area Memory",
    "",
    "Recent observations from prior builds in the areas you're working in:",
    "",
  ];

  const capped = observations.slice(0, 5);
  for (const obs of capped) {
    const date = obs.created_at.slice(0, 10); // YYYY-MM-DD
    lines.push(`- [${obs.source}, ${date}] ${obs.content} (area: ${obs.subsystem_key})`);
  }

  return lines.join("\n");
}

// ---- Fail-open wrapper ----

/**
 * Build the area memory section for the given file paths.
 *
 * Fail-open: returns `{ section: "", count: 0 }` on any error so enrichment
 * never blocks agent spawn.
 *
 * After querying observations, calls markInjected() so the learner can
 * track which observations were served to agents.
 */
export function buildAreaMemorySection(
  filePaths: string[],
  projectDir: string,
): { section: string; count: number } {
  if (filePaths.length === 0) return { count: 0, section: "" };
  try {
    const areaMemoryDao = getDriftDb(projectDir).getAreaMemory();
    const observations = queryAreaObservations(filePaths, areaMemoryDao);
    if (observations.length > 0) {
      areaMemoryDao.markInjected(observations.map((o) => o.id));
    }
    return {
      count: observations.length,
      section: formatAreaMemorySection(observations),
    };
  } catch (err) {
    console.warn(
      "[area-memory-enrichment] buildAreaMemorySection failed:",
      err instanceof Error ? err.message : err,
    );
    return { count: 0, section: "" };
  }
}
