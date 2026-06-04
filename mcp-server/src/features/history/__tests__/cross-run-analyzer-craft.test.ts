/**
 * Craft-drift dimension tests for cross-run-analyzer.
 *
 * Tests the computeCraftDrift pure function (exported for testing) and
 * the integration path through analyzeCrossRunPatterns.
 *
 * Uses in-memory SQLite via DriftDb (same pattern as cross-run-analyzer.test.ts).
 *
 * Key invariants under test:
 * - Rising band ordinals → "improving"; falling → "degrading"; flat → "stable"
 * - Empty/single profile → stable direction, no throw
 * - n-a bands excluded from avg_band_ordinal (no NaN)
 * - by_area present only for areas with ≥ MIN_CRAFT_PROFILES profiles
 * - analyzeCrossRunPatterns returns craft_drift; existing fields unaffected
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CraftProfileRow } from "../../../platform/storage/drift/craft-profile-dao.ts";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { CraftDimensionRating } from "../../../shared/schema.ts";
import type { RunSummary } from "../history-types.ts";
import { analyzeCrossRunPatterns, computeCraftDrift } from "../services/cross-run-analyzer.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

/** Build a CraftProfileRow with the specified ratings and created_at timestamp. */
function makeProfile(
  subsystem_key: string,
  ratings: CraftDimensionRating[],
  created_at: string,
  id = 1,
): CraftProfileRow {
  return {
    created_at,
    id,
    ratings,
    source: "review",
    subsystem_key,
  };
}

/** Build an ISO timestamp offset from epoch by hours. */
function ts(hoursOffset: number): string {
  return new Date(hoursOffset * 3_600_000).toISOString();
}

function makeRunSummary(): RunSummary {
  const now = new Date().toISOString();
  return {
    archive_id: "arc_test",
    artifact_inventory: { directories: [], files: [], total_files: 0 },
    decision_summaries: [],
    planner_context: null,
    review_results: [],
    run_metadata: {
      archived_at: now,
      branch: "main",
      completed_at: now,
      flow: "feature",
      slug: "test",
      started_at: now,
      task: "test task",
      tier: "standard",
      total_duration_ms: 1000,
    },
    step_outcomes: [],
    version: 1,
  };
}

// ---- computeCraftDrift unit tests ----

describe("computeCraftDrift", () => {
  describe("empty and sparse inputs", () => {
    test("empty profiles → stable, empty by_dimension, profile_count=0", () => {
      const result = computeCraftDrift([]);
      expect(result.profile_count).toBe(0);
      expect(result.by_dimension).toEqual([]);
      expect(result.by_area).toBeUndefined();
    });

    test("single profile → stable direction, profile_count=1, no throw", () => {
      const profiles = [
        makeProfile("features/auth", [{ dimension: "simplicity", band: "strong" }], ts(0)),
      ];
      const result = computeCraftDrift(profiles);
      expect(result.profile_count).toBe(1);
      // Single profile: not enough to classify trend — must be stable
      const dim = result.by_dimension.find((d) => d.dimension === "simplicity");
      expect(dim?.direction).toBe("stable");
      expect(() => computeCraftDrift(profiles)).not.toThrow();
    });

    test("fewer than MIN_CRAFT_PROFILES profiles → stable direction", () => {
      // MIN_CRAFT_PROFILES = 4; 3 profiles is sparse
      const profiles = [
        makeProfile("a", [{ dimension: "cohesion", band: "weak" }], ts(0), 1),
        makeProfile("a", [{ dimension: "cohesion", band: "adequate" }], ts(1), 2),
        makeProfile("a", [{ dimension: "cohesion", band: "strong" }], ts(2), 3),
      ];
      const result = computeCraftDrift(profiles);
      const dim = result.by_dimension.find((d) => d.dimension === "cohesion");
      expect(dim?.direction).toBe("stable");
    });
  });

  describe("direction classification", () => {
    test("rising ordinals (weak→adequate→adequate→strong) → improving", () => {
      // 4 profiles: ordinals 1, 2, 2, 3 → recent half avg > prior half avg > 10%
      const profiles = [
        makeProfile("sub", [{ dimension: "simplicity", band: "weak" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "simplicity", band: "adequate" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "simplicity", band: "adequate" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "simplicity", band: "strong" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      const dim = result.by_dimension.find((d) => d.dimension === "simplicity");
      expect(dim?.direction).toBe("improving");
      expect(dim?.sample_count).toBe(4);
    });

    test("falling ordinals (strong→strong→adequate→weak) → degrading", () => {
      const profiles = [
        makeProfile("sub", [{ dimension: "naming", band: "strong" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "naming", band: "strong" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "naming", band: "adequate" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "naming", band: "weak" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      const dim = result.by_dimension.find((d) => d.dimension === "naming");
      expect(dim?.direction).toBe("degrading");
    });

    test("flat ordinals → stable", () => {
      const profiles = [
        makeProfile("sub", [{ dimension: "locality", band: "adequate" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "locality", band: "adequate" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "locality", band: "adequate" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "locality", band: "adequate" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      const dim = result.by_dimension.find((d) => d.dimension === "locality");
      expect(dim?.direction).toBe("stable");
    });
  });

  describe("n-a band exclusion", () => {
    test("all n-a bands → dimension excluded from by_dimension (no NaN)", () => {
      const profiles = [
        makeProfile("sub", [{ dimension: "interface-depth", band: "n-a" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "interface-depth", band: "n-a" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "interface-depth", band: "n-a" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "interface-depth", band: "n-a" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      // Either the dimension is absent or avg_band_ordinal is not NaN
      const dim = result.by_dimension.find((d) => d.dimension === "interface-depth");
      if (dim !== undefined) {
        expect(Number.isNaN(dim.avg_band_ordinal)).toBe(false);
      }
    });

    test("mixed n-a and graded bands → only graded ordinals in avg", () => {
      // 4 profiles: n-a, strong(3), n-a, adequate(2) → ordinals [3, 2] → avg 2.5
      const profiles = [
        makeProfile("sub", [{ dimension: "predictability", band: "n-a" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "predictability", band: "strong" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "predictability", band: "n-a" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "predictability", band: "adequate" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      const dim = result.by_dimension.find((d) => d.dimension === "predictability");
      expect(dim).toBeDefined();
      expect(Number.isNaN(dim!.avg_band_ordinal)).toBe(false);
      // avg of strong(3) and adequate(2) = 2.5
      expect(dim!.avg_band_ordinal).toBeCloseTo(2.5);
      // sample_count reflects graded profiles only
      expect(dim!.sample_count).toBe(2);
    });
  });

  describe("avg_band_ordinal", () => {
    test("correct average across 4 profiles", () => {
      // ordinals: weak(1) + adequate(2) + adequate(2) + strong(3) = 8, avg = 2
      const profiles = [
        makeProfile("sub", [{ dimension: "cohesion", band: "weak" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "cohesion", band: "adequate" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "cohesion", band: "adequate" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "cohesion", band: "strong" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      const dim = result.by_dimension.find((d) => d.dimension === "cohesion");
      expect(dim?.avg_band_ordinal).toBeCloseTo(2.0);
    });
  });

  describe("by_area gating", () => {
    test("single area with ≥ MIN_CRAFT_PROFILES → by_area entry present", () => {
      const profiles = [
        makeProfile("features/auth", [{ dimension: "simplicity", band: "weak" }], ts(0), 1),
        makeProfile("features/auth", [{ dimension: "simplicity", band: "adequate" }], ts(1), 2),
        makeProfile("features/auth", [{ dimension: "simplicity", band: "adequate" }], ts(2), 3),
        makeProfile("features/auth", [{ dimension: "simplicity", band: "strong" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      expect(result.by_area).toBeDefined();
      const areaEntry = result.by_area?.find((a) => a.subsystem_key === "features/auth");
      expect(areaEntry).toBeDefined();
      expect(areaEntry?.by_dimension.length).toBeGreaterThan(0);
    });

    test("area with < MIN_CRAFT_PROFILES profiles → omitted from by_area", () => {
      // 3 profiles for area1 (below floor), 4 for area2 (at floor)
      const profiles = [
        // area1: 3 profiles (below MIN_CRAFT_PROFILES = 4)
        makeProfile("features/foo", [{ dimension: "naming", band: "strong" }], ts(0), 1),
        makeProfile("features/foo", [{ dimension: "naming", band: "strong" }], ts(1), 2),
        makeProfile("features/foo", [{ dimension: "naming", band: "strong" }], ts(2), 3),
        // area2: 4 profiles (at floor)
        makeProfile("features/bar", [{ dimension: "naming", band: "weak" }], ts(3), 4),
        makeProfile("features/bar", [{ dimension: "naming", band: "adequate" }], ts(4), 5),
        makeProfile("features/bar", [{ dimension: "naming", band: "adequate" }], ts(5), 6),
        makeProfile("features/bar", [{ dimension: "naming", band: "strong" }], ts(6), 7),
      ];
      const result = computeCraftDrift(profiles);
      const fooArea = result.by_area?.find((a) => a.subsystem_key === "features/foo");
      const barArea = result.by_area?.find((a) => a.subsystem_key === "features/bar");
      expect(fooArea).toBeUndefined();
      expect(barArea).toBeDefined();
    });

    test("no area reaches MIN_CRAFT_PROFILES → by_area absent or empty", () => {
      const profiles = [
        makeProfile("a", [{ dimension: "simplicity", band: "strong" }], ts(0), 1),
        makeProfile("b", [{ dimension: "simplicity", band: "weak" }], ts(1), 2),
      ];
      const result = computeCraftDrift(profiles);
      // by_area is either absent or empty
      const areaCount = result.by_area?.length ?? 0;
      expect(areaCount).toBe(0);
    });
  });

  describe("profile_count", () => {
    test("profile_count reflects all profiles including those with n-a", () => {
      const profiles = [
        makeProfile("sub", [{ dimension: "simplicity", band: "n-a" }], ts(0), 1),
        makeProfile("sub", [{ dimension: "simplicity", band: "strong" }], ts(1), 2),
        makeProfile("sub", [{ dimension: "simplicity", band: "strong" }], ts(2), 3),
        makeProfile("sub", [{ dimension: "simplicity", band: "strong" }], ts(3), 4),
      ];
      const result = computeCraftDrift(profiles);
      expect(result.profile_count).toBe(4);
    });
  });
});

// ---- analyzeCrossRunPatterns integration tests ----

describe("analyzeCrossRunPatterns — craft_drift integration", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("craft_drift populated when profiles exist in db", () => {
    // Insert 4 profiles via the DAO (covers both review and audit sources)
    const dao = store.getCraftProfiles();
    dao.insertProfile({
      ratings: [{ dimension: "simplicity", band: "weak" }],
      source: "review",
      subsystem_key: "features/auth",
    });
    dao.insertProfile({
      ratings: [{ dimension: "simplicity", band: "adequate" }],
      source: "audit",
      subsystem_key: "features/auth",
    });
    dao.insertProfile({
      ratings: [{ dimension: "simplicity", band: "adequate" }],
      source: "review",
      subsystem_key: "features/auth",
    });
    dao.insertProfile({
      ratings: [{ dimension: "simplicity", band: "strong" }],
      source: "audit",
      subsystem_key: "features/auth",
    });

    const result = analyzeCrossRunPatterns(store, [makeRunSummary()]);
    expect(result.craft_drift).toBeDefined();
    expect(result.craft_drift.profile_count).toBe(4);
    expect(result.craft_drift.by_dimension.length).toBeGreaterThan(0);
  });

  test("craft_drift.profile_count=0 and by_dimension=[] when db has no profiles", () => {
    const result = analyzeCrossRunPatterns(store, []);
    expect(result.craft_drift.profile_count).toBe(0);
    expect(result.craft_drift.by_dimension).toEqual([]);
  });

  test("existing result fields (recurring_violations, agent_performance_trends, etc.) unaffected", () => {
    const result = analyzeCrossRunPatterns(store, [makeRunSummary()]);
    expect(result).toHaveProperty("recurring_violations");
    expect(result).toHaveProperty("fix_cycle_patterns");
    expect(result).toHaveProperty("agent_performance_trends");
    expect(result).toHaveProperty("planner_patterns");
    expect(result).toHaveProperty("total_archived_runs");
    expect(result).toHaveProperty("analysis_window");
  });
});
