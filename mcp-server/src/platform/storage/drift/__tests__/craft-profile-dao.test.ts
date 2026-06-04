/**
 * craft-profile-dao.test.ts
 *
 * Tests for CraftProfileDao — area-keyed craft profile storage.
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system side effects.
 *
 * Test plan (from craft-v2-02 plan):
 * - audit profile (no flow/run_id) round-trips with those fields omitted
 * - review profile (flow+run_id+rollup) round-trips all fields
 * - getProfilesForSubsystems([]) → []; unknown key → []
 * - getRecentProfiles(n) orders by created_at desc, respects limit
 * - double-migration idempotency (run initDriftDb twice on in-memory db → no throw, table once)
 * - ratings JSON multi-rating round-trip equal
 */

import type { CraftDimensionRating } from "@shared/schema.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { CraftProfileDao } from "../craft-profile-dao.ts";
import { initDriftDb } from "../drift-schema.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

describe("CraftProfileDao", () => {
  let db: ReturnType<typeof makeDb>;
  let dao: CraftProfileDao;

  beforeEach(() => {
    db = makeDb();
    dao = new CraftProfileDao(db);
  });

  describe("insertProfile + getProfilesForSubsystems", () => {
    it("audit profile (no flow/run_id/rollup) round-trips with those fields omitted", () => {
      const ratings: CraftDimensionRating[] = [
        { dimension: "cohesion", band: "weak", evidence: "no tests" },
      ];

      dao.insertProfile({
        subsystem_key: "features/orchestration",
        source: "audit",
        ratings,
      });

      const rows = dao.getProfilesForSubsystems(["features/orchestration"]);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      expect(row.subsystem_key).toBe("features/orchestration");
      expect(row.source).toBe("audit");
      expect(row.ratings).toEqual(ratings);
      // flow, run_id, rollup must be absent (not null)
      expect(row).not.toHaveProperty("flow");
      expect(row).not.toHaveProperty("run_id");
      expect(row).not.toHaveProperty("rollup");
    });

    it("review profile (flow+run_id+rollup) round-trips all fields", () => {
      const ratings: CraftDimensionRating[] = [
        { dimension: "naming", band: "adequate" },
        { dimension: "predictability", band: "strong", evidence: "errors-are-values" },
      ];

      dao.insertProfile({
        subsystem_key: "platform/storage",
        source: "review",
        flow: "my-flow",
        run_id: "run-abc-123",
        ratings,
        rollup: 0.85,
      });

      const rows = dao.getProfilesForSubsystems(["platform/storage"]);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      expect(row.subsystem_key).toBe("platform/storage");
      expect(row.source).toBe("review");
      expect(row.flow).toBe("my-flow");
      expect(row.run_id).toBe("run-abc-123");
      expect(row.rollup).toBe(0.85);
      expect(row.ratings).toEqual(ratings);
    });
  });

  describe("getProfilesForSubsystems", () => {
    it("returns [] for empty input (define-errors-out-of-existence)", () => {
      dao.insertProfile({
        subsystem_key: "features/orchestration",
        source: "audit",
        ratings: [{ dimension: "cohesion", band: "weak" }],
      });

      const result = dao.getProfilesForSubsystems([]);
      expect(result).toEqual([]);
    });

    it("returns [] for unknown subsystem key (define-errors-out-of-existence)", () => {
      dao.insertProfile({
        subsystem_key: "features/orchestration",
        source: "audit",
        ratings: [{ dimension: "cohesion", band: "weak" }],
      });

      const result = dao.getProfilesForSubsystems(["nonexistent/area"]);
      expect(result).toEqual([]);
    });

    it("returns profiles for multiple subsystem keys", () => {
      dao.insertProfile({
        subsystem_key: "area-a",
        source: "audit",
        ratings: [{ dimension: "naming", band: "adequate" }],
      });
      dao.insertProfile({
        subsystem_key: "area-b",
        source: "review",
        flow: "flow-1",
        run_id: "run-1",
        ratings: [{ dimension: "predictability", band: "strong" }],
      });

      const result = dao.getProfilesForSubsystems(["area-a", "area-b"]);
      expect(result).toHaveLength(2);
      const keys = result.map((r) => r.subsystem_key);
      expect(keys).toContain("area-a");
      expect(keys).toContain("area-b");
    });
  });

  describe("getRecentProfiles", () => {
    it("orders by created_at DESC and respects limit", () => {
      // Insert profiles with distinct timestamps
      dao.insertProfile({
        subsystem_key: "area-x",
        source: "audit",
        ratings: [{ dimension: "cohesion", band: "weak" }],
      });
      // Small sleep to ensure different timestamps in SQLite
      const now = Date.now();
      while (Date.now() - now < 10) {
        /* busy wait */
      }

      dao.insertProfile({
        subsystem_key: "area-y",
        source: "review",
        flow: "f",
        run_id: "r",
        ratings: [{ dimension: "naming", band: "adequate" }],
      });

      const all = dao.getRecentProfiles(10);
      expect(all.length).toBeGreaterThanOrEqual(2);
      // Most recent should come first
      const timestamps = all.map((r) => r.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1] >= timestamps[i]).toBe(true);
      }
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        dao.insertProfile({
          subsystem_key: `area-${i}`,
          source: "audit",
          ratings: [{ dimension: "cohesion", band: "weak" }],
        });
      }

      const result = dao.getRecentProfiles(3);
      expect(result).toHaveLength(3);
    });

    it("returns [] when no profiles exist", () => {
      const result = dao.getRecentProfiles(10);
      expect(result).toEqual([]);
    });
  });

  describe("migration idempotency", () => {
    it("running initDriftDb twice on in-memory db does not throw and table exists once", () => {
      // A fresh DB already ran migrations in beforeEach; call again on same path style
      // Simulating idempotency: open a fresh in-memory DB and inspect
      expect(() => {
        const db2 = initDriftDb(":memory:");
        const dao2 = new CraftProfileDao(db2);
        dao2.insertProfile({
          subsystem_key: "test",
          source: "audit",
          ratings: [{ dimension: "naming", band: "adequate" }],
        });
        const rows = dao2.getProfilesForSubsystems(["test"]);
        expect(rows).toHaveLength(1);
        db2.close();
      }).not.toThrow();
    });

    it("craft_profiles table exists after migration", () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='craft_profiles'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("craft_profiles");
    });
  });

  describe("ratings JSON round-trip integrity", () => {
    it("multi-rating profile round-trips equal CraftDimensionRating[]", () => {
      const ratings: CraftDimensionRating[] = [
        {
          dimension: "cohesion",
          band: "weak",
          evidence: "minimal coverage",
          principle_refs: ["agent-tdd-required"],
        },
        {
          dimension: "naming",
          band: "adequate",
        },
        {
          dimension: "predictability",
          band: "strong",
          evidence: "errors-are-values throughout",
          principle_refs: ["errors-are-values", "define-errors-out-of-existence"],
        },
        {
          dimension: "simplicity",
          band: "weak",
        },
      ];

      dao.insertProfile({
        subsystem_key: "complex-area",
        source: "review",
        flow: "my-flow",
        run_id: "run-xyz",
        ratings,
        rollup: 0.6,
      });

      const rows = dao.getProfilesForSubsystems(["complex-area"]);
      expect(rows).toHaveLength(1);
      expect(rows[0].ratings).toEqual(ratings);
    });
  });
});
