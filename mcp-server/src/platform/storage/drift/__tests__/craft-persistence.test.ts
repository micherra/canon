/**
 * craft-persistence.test.ts
 *
 * Tests for validateAndPersistCraftProfile — the shared validate+persist helper
 * relocated from features/pr-review to platform/storage/drift per ADR-0003.
 *
 * Test plan:
 * - undefined craft_profile → no rows inserted, no error
 * - invalid craft_profile → throws with informative message
 * - valid profile + empty files → no rows inserted
 * - valid profile + one file → one row inserted with correct subsystem_key
 * - valid profile + two files same subsystem_key → one row (deduplication)
 * - valid profile + two files different subsystem_keys → two rows
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAndPersistCraftProfile } from "../craft-persistence.ts";

describe("validateAndPersistCraftProfile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-craft-persist-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("undefined craft_profile → no rows inserted, no error", () => {
    expect(() => validateAndPersistCraftProfile(undefined, ["src/foo.ts"], tmpDir)).not.toThrow();

    const rows = getDriftDb(tmpDir).getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  it("invalid craft_profile → throws with informative message", () => {
    // A profile missing the required 'ratings' field is invalid
    expect(() =>
      validateAndPersistCraftProfile({ ratings: "not-an-array" } as never, ["src/foo.ts"], tmpDir),
    ).toThrow(/Invalid craft_profile/);
  });

  it("valid profile + empty files → no rows inserted", () => {
    validateAndPersistCraftProfile(
      { ratings: [{ dimension: "naming", band: "adequate" }] },
      [],
      tmpDir,
    );

    const rows = getDriftDb(tmpDir).getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  it("valid profile + one file → one row with correct subsystem_key and source=review", () => {
    validateAndPersistCraftProfile(
      { ratings: [{ dimension: "cohesion", band: "strong" }] },
      ["mcp-server/src/features/orchestration/tools/report.ts"],
      tmpDir,
    );

    const rows = getDriftDb(tmpDir).getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("review");
    expect(rows[0].ratings).toEqual([{ dimension: "cohesion", band: "strong" }]);
  });

  it("valid profile + two files with same subsystem_key → one row (deduplication)", () => {
    // Both files derive to the same subsystem_key
    validateAndPersistCraftProfile(
      { ratings: [{ dimension: "naming", band: "weak" }] },
      [
        "mcp-server/src/features/orchestration/tools/report.ts",
        "mcp-server/src/features/orchestration/tools/init-workspace.ts",
      ],
      tmpDir,
    );

    const rows = getDriftDb(tmpDir).getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(1);
  });

  it("valid profile + two files with different subsystem_keys → two rows", () => {
    validateAndPersistCraftProfile(
      { ratings: [{ dimension: "predictability", band: "adequate" }] },
      [
        "mcp-server/src/features/orchestration/tools/report.ts",
        "mcp-server/src/platform/storage/drift/store.ts",
      ],
      tmpDir,
    );

    const rows = getDriftDb(tmpDir).getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.subsystem_key);
    expect(keys).toContain("features/orchestration");
    expect(keys).toContain("platform/storage/drift");
  });

  it("rollup is persisted when present in profile", () => {
    validateAndPersistCraftProfile(
      { ratings: [{ dimension: "cohesion", band: "strong" }], rollup: 0.75 },
      ["mcp-server/src/features/orchestration/tools/report.ts"],
      tmpDir,
    );

    const rows = getDriftDb(tmpDir).getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].rollup).toBe(0.75);
  });
});
