/**
 * Craft drift computation — pure functions for analyzing craft profile trends.
 *
 * Extracted from cross-run-analyzer.ts to keep each file under 600 lines.
 * All functions operate on pre-loaded CraftProfileRow arrays — no I/O.
 *
 * bounded-context-boundaries: imports only from shared kernel types and the
 * history-types bounded context. No cross-feature imports.
 */

import type { CraftProfileRow } from "@platform/storage/drift/craft-profile-dao.ts";
import type { CraftDimension } from "@shared/lib/craft-rubric.ts";
import { craftBandOrdinal } from "@shared/lib/craft-rubric.ts";
import type { CraftDimensionDrift, CraftDrift } from "../history-types.ts";

/** Minimum number of profiles per dimension (or area) to classify a trend direction. */
const MIN_CRAFT_PROFILES = 4;

/**
 * Ordinal data point for a single profile's rating of a given dimension.
 * Only graded (non-n-a) ratings are included.
 */
type OrdinalPoint = { created_at: string; ordinal: number };

/**
 * Collect ordinal data points for a specific dimension from a set of profiles,
 * sorted chronologically. Excludes profiles where the dimension is rated n-a.
 */
function collectOrdinalPoints(
  profiles: CraftProfileRow[],
  dimension: CraftDimension,
): OrdinalPoint[] {
  const points: OrdinalPoint[] = [];
  for (const profile of profiles) {
    for (const rating of profile.ratings) {
      if (rating.dimension !== dimension) continue;
      const ordinal = craftBandOrdinal(rating.band);
      if (ordinal === null) continue; // n-a excluded
      points.push({ created_at: profile.created_at, ordinal });
    }
  }
  points.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return points;
}

/**
 * Classify trend direction by comparing recent half vs prior half.
 * Mirrors the classifyTrend logic used for performance trends.
 * Rising mean ordinal > 10% → "improving" (higher = better craft).
 * Falling > 10% → "degrading". Flat or sparse → "stable".
 */
function classifyCraftTrend(points: OrdinalPoint[]): "improving" | "stable" | "degrading" {
  const n = points.length;
  if (n < MIN_CRAFT_PROFILES) return "stable";

  const half = Math.floor(n / 2);
  const priorHalf = points.slice(0, half);
  const recentHalf = points.slice(n - half);

  const priorAvg = priorHalf.reduce((sum, p) => sum + p.ordinal, 0) / half;
  const recentAvg = recentHalf.reduce((sum, p) => sum + p.ordinal, 0) / half;

  if (priorAvg <= 0) return "stable";

  const changePct = (recentAvg - priorAvg) / priorAvg;
  // Higher ordinal = better craft (non-inverted)
  if (changePct > 0.1) return "improving";
  if (changePct < -0.1) return "degrading";
  return "stable";
}

/**
 * Compute CraftDimensionDrift entries for a given set of profiles.
 * Handles all 6 dimensions; skips dimensions where all ratings are n-a.
 */
function computeDimensionDrifts(profiles: CraftProfileRow[]): CraftDimensionDrift[] {
  const dimensions: CraftDimension[] = [
    "simplicity",
    "cohesion",
    "interface-depth",
    "naming",
    "locality",
    "predictability",
  ];

  const result: CraftDimensionDrift[] = [];
  for (const dimension of dimensions) {
    const points = collectOrdinalPoints(profiles, dimension);
    if (points.length === 0) continue; // no graded data for this dimension

    const avg_band_ordinal = points.reduce((sum, p) => sum + p.ordinal, 0) / points.length;
    const direction = classifyCraftTrend(points);

    result.push({
      avg_band_ordinal,
      dimension,
      direction,
      sample_count: points.length,
    });
  }
  return result;
}

/**
 * Compute craft drift across a set of craft profiles.
 *
 * Pure function — no I/O. The caller is responsible for fetching profiles
 * from the DAO before calling this function (command-query-separation).
 *
 * Empty/sparse inputs return "stable" direction and empty collections —
 * never null, never throw (define-errors-out-of-existence).
 *
 * @param profiles - CraftProfileRow records from both review and audit sources
 * @returns CraftDrift with global by_dimension rollup and optional by_area breakdown
 */
export function computeCraftDrift(profiles: CraftProfileRow[]): CraftDrift {
  if (profiles.length === 0) {
    return { by_dimension: [], profile_count: 0 };
  }

  // Global rollup across all areas
  const by_dimension = computeDimensionDrifts(profiles);

  // Per-area breakdown: group profiles by subsystem_key
  const byArea = new Map<string, CraftProfileRow[]>();
  for (const profile of profiles) {
    const existing = byArea.get(profile.subsystem_key);
    if (existing === undefined) {
      byArea.set(profile.subsystem_key, [profile]);
    } else {
      existing.push(profile);
    }
  }

  // Only include areas with enough profiles to be meaningful
  const by_area: Array<{ subsystem_key: string; by_dimension: CraftDimensionDrift[] }> = [];
  for (const [subsystem_key, areaProfiles] of byArea) {
    if (areaProfiles.length < MIN_CRAFT_PROFILES) continue;
    const areaDimensions = computeDimensionDrifts(areaProfiles);
    if (areaDimensions.length === 0) continue;
    by_area.push({ by_dimension: areaDimensions, subsystem_key });
  }

  return {
    by_area: by_area.length > 0 ? by_area : undefined,
    by_dimension,
    profile_count: profiles.length,
  };
}
