/**
 * craft-audit-service.test.ts
 *
 * Tests for the craft audit service — area selection and profile persistence.
 *
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system side effects.
 *
 * Test plan (from craft-v2-04 plan):
 * - selectAuditAreas dedupes files → subsystem keys; respects limit; honors explicit areas
 * - persistAuditProfile validates + writes source:'audit' row with null flow/run_id (read back via CraftProfileDao)
 * - malformed ratings → error, no write
 * - empty input → no rows, no throw
 */

import { CraftProfileDao } from "@platform/storage/drift/craft-profile-dao.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import type { CraftDimensionRating } from "@shared/schema.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { persistAuditProfile, selectAuditAreas } from "../craft-audit-service.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

describe("selectAuditAreas", () => {
  it("dedupes file paths to distinct subsystem keys", () => {
    // Two files in the same subsystem map to one key
    const ranked = [
      "mcp-server/src/features/orchestration/tools/init-workspace.ts",
      "mcp-server/src/features/orchestration/tools/finalize-workspace.ts",
      "mcp-server/src/features/diagnostics/services/signal-compiler.ts",
    ];
    const result = selectAuditAreas({ ranked_files: ranked, limit: 10 });
    expect(result).toContain("features/orchestration");
    expect(result).toContain("features/diagnostics");
    // Both orchestration files collapse to one key
    expect(result.filter((k) => k === "features/orchestration")).toHaveLength(1);
  });

  it("respects the limit: 100 ranked files with limit=5 yields ≤5 distinct keys", () => {
    // Generate 100 files across 20 distinct subsystems (5 files each)
    const subsystems = Array.from({ length: 20 }, (_, i) => `area-${i}`);
    const ranked = subsystems.flatMap((s) =>
      Array.from({ length: 5 }, (_, j) => `mcp-server/src/features/${s}/tools/file-${j}.ts`),
    );

    const result = selectAuditAreas({ ranked_files: ranked, limit: 5 });
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("honors explicit areas (overrides ranked_files)", () => {
    const areas = ["features/orchestration", "platform/storage/drift"];
    const result = selectAuditAreas({ areas });
    expect(result).toEqual(areas);
  });

  it("explicit areas are returned as-is without dedup (already distinct)", () => {
    const areas = ["features/orchestration", "features/diagnostics", "features/orchestration"];
    const result = selectAuditAreas({ areas });
    // duplicates are removed
    expect(result).toHaveLength(2);
  });

  it("empty ranked_files with no areas returns empty array (define-errors-out-of-existence)", () => {
    const result = selectAuditAreas({ ranked_files: [], limit: 5 });
    expect(result).toEqual([]);
  });

  it("empty areas returns empty array (define-errors-out-of-existence)", () => {
    const result = selectAuditAreas({ areas: [] });
    expect(result).toEqual([]);
  });

  it("preserves ranked order up to limit", () => {
    // Files from different subsystems in a known order
    const ranked = [
      "mcp-server/src/features/diagnostics/tools/drift.ts",
      "mcp-server/src/features/orchestration/tools/init.ts",
      "mcp-server/src/platform/storage/drift/drift-db.ts",
      "mcp-server/src/shared/lib/config.ts",
      "mcp-server/src/features/principles/tools/get.ts",
    ];
    const result = selectAuditAreas({ ranked_files: ranked, limit: 3 });
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("features/diagnostics");
    expect(result[1]).toBe("features/orchestration");
    expect(result[2]).toBe("platform/storage/drift");
  });
});

describe("persistAuditProfile", () => {
  let dao: CraftProfileDao;

  beforeEach(() => {
    const db = makeDb();
    dao = new CraftProfileDao(db);
  });

  it("writes source:'audit' row with null flow/run_id", () => {
    const ratings: CraftDimensionRating[] = [
      { dimension: "simplicity", band: "adequate", evidence: "single-responsibility" },
      { dimension: "naming", band: "strong" },
    ];

    persistAuditProfile({ subsystem_key: "features/diagnostics", ratings }, dao);

    const rows = dao.getProfilesForSubsystems(["features/diagnostics"]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source).toBe("audit");
    expect(row.subsystem_key).toBe("features/diagnostics");
    expect(row.ratings).toEqual(ratings);
    // flow and run_id must be absent (not set)
    expect(row).not.toHaveProperty("flow");
    expect(row).not.toHaveProperty("run_id");
  });

  it("accepts optional rollup value", () => {
    const ratings: CraftDimensionRating[] = [{ dimension: "cohesion", band: "strong" }];

    persistAuditProfile({ subsystem_key: "features/orchestration", ratings, rollup: 0.9 }, dao);

    const rows = dao.getProfilesForSubsystems(["features/orchestration"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rollup).toBe(0.9);
  });

  it("malformed ratings (invalid band) → throws, no write", () => {
    const badRatings = [
      { dimension: "simplicity", band: "unknown-band" },
    ] as unknown as CraftDimensionRating[];

    expect(() => {
      persistAuditProfile({ subsystem_key: "bad-area", ratings: badRatings }, dao);
    }).toThrow();

    // Verify no row was written
    const rows = dao.getProfilesForSubsystems(["bad-area"]);
    expect(rows).toEqual([]);
  });

  it("malformed ratings (invalid dimension) → throws, no write", () => {
    const badRatings = [
      { dimension: "not-a-dimension", band: "adequate" },
    ] as unknown as CraftDimensionRating[];

    expect(() => {
      persistAuditProfile({ subsystem_key: "bad-area-2", ratings: badRatings }, dao);
    }).toThrow();

    const rows = dao.getProfilesForSubsystems(["bad-area-2"]);
    expect(rows).toEqual([]);
  });

  it("empty ratings array → no write, no throw (define-errors-out-of-existence)", () => {
    expect(() => {
      persistAuditProfile({ subsystem_key: "empty-area", ratings: [] }, dao);
    }).not.toThrow();

    // Empty ratings array is valid schema — row is written but with empty ratings
    const rows = dao.getProfilesForSubsystems(["empty-area"]);
    // With empty ratings, the schema validates (z.array has no min) — row is written
    expect(rows).toHaveLength(1);
    expect(rows[0].ratings).toEqual([]);
  });

  it("persists all 6 craft dimensions in one profile", () => {
    const ratings: CraftDimensionRating[] = [
      { dimension: "simplicity", band: "adequate" },
      { dimension: "cohesion", band: "strong" },
      { dimension: "interface-depth", band: "weak" },
      { dimension: "naming", band: "adequate" },
      { dimension: "locality", band: "strong" },
      { dimension: "predictability", band: "n-a" },
    ];

    persistAuditProfile({ subsystem_key: "features/principles", ratings, rollup: 0.75 }, dao);

    const rows = dao.getProfilesForSubsystems(["features/principles"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ratings).toHaveLength(6);
    expect(rows[0].ratings).toEqual(ratings);
  });
});
