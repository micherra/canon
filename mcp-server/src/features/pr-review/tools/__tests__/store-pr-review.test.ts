import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORRECTNESS_SCAN_PRINCIPLE_ID } from "@features/orchestration/tools/write-review.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import type { CraftProfile } from "@shared/schema.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storePrReview } from "../store-pr-review.ts";

describe("storePrReview", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-store-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("calls DriftStore.appendReview with server-generated id and timestamp", async () => {
    const before = Date.now();

    const result = await storePrReview(
      {
        files: ["src/foo.ts"],
        honored: ["some-principle"],
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      tmpDir,
    );

    const after = Date.now();

    expect(result.recorded).toBe(true);
    expect(result.review_id).toMatch(/^rev_/);

    // Verify it was actually persisted
    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);

    const stored = reviews[0];
    expect(stored.review_id).toBe(result.review_id);
    expect(stored.verdict).toBe("CLEAN");

    // Timestamp should be a valid ISO date within our test window
    const storedTime = new Date(stored.timestamp).getTime();
    expect(storedTime).toBeGreaterThanOrEqual(before);
    expect(storedTime).toBeLessThanOrEqual(after + 1000); // allow 1s buffer
  });

  it("returned review_id matches rev_ prefix pattern", async () => {
    const result = await storePrReview(
      {
        files: [],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 0, total: 0 },
        },
        verdict: "WARNING",
        violations: [{ principle_id: "some-rule", severity: "strong-opinion" }],
      },
      tmpDir,
    );

    // Format: rev_YYYYMMDD_<16 hex chars>
    expect(result.review_id).toMatch(/^rev_\d{8}_[0-9a-f]{16}$/);
  });

  it("stores with minimal required fields only", async () => {
    const result = await storePrReview(
      {
        files: [],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        verdict: "BLOCKING",
        violations: [{ principle_id: "validate-at-trust-boundaries", severity: "rule" }],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);
    expect(result.review_id).toBeTruthy();

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].pr_number).toBeUndefined();
    expect(reviews[0].branch).toBeUndefined();
    expect(reviews[0].last_reviewed_sha).toBeUndefined();
    expect(reviews[0].file_priorities).toBeUndefined();
  });

  it("stores with all optional fields provided", async () => {
    const result = await storePrReview(
      {
        branch: "feature/my-feature",
        file_priorities: [
          { path: "src/a.ts", priority_score: 0.9 },
          { path: "src/b.ts", priority_score: 0.4 },
        ],
        files: ["src/a.ts", "src/b.ts"],
        honored: ["errors-are-values", "validate-at-trust-boundaries"],
        last_reviewed_sha: "deadbeef123",
        pr_number: 42,
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 2 },
          rules: { passed: 2, total: 2 },
        },
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/a.ts",
            impact_score: 7.5,
            principle_id: "thin-handlers",
            severity: "strong-opinion",
          },
        ],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews({ prNumber: 42 });
    expect(reviews).toHaveLength(1);

    const stored = reviews[0];
    expect(stored.pr_number).toBe(42);
    expect(stored.branch).toBe("feature/my-feature");
    expect(stored.last_reviewed_sha).toBe("deadbeef123");
    expect(stored.verdict).toBe("WARNING");
    expect(stored.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(stored.violations).toHaveLength(1);
    expect(stored.violations[0].principle_id).toBe("thin-handlers");
    expect(stored.violations[0].impact_score).toBe(7.5);
    expect(stored.honored).toEqual(["errors-are-values", "validate-at-trust-boundaries"]);
    expect(stored.file_priorities).toEqual([
      { path: "src/a.ts", priority_score: 0.9 },
      { path: "src/b.ts", priority_score: 0.4 },
    ]);
  });

  it("stores recommendations when provided", async () => {
    const recommendations = [
      {
        file_path: "src/tools/foo.ts",
        message: "Business logic should move to a service layer.",
        source: "principle" as const,
        title: "thin-handlers",
      },
      {
        message: "JSON.parse on line 42 is unguarded.",
        source: "holistic" as const,
        title: "Missing error handling",
      },
    ];

    const result = await storePrReview(
      {
        files: ["src/tools/foo.ts"],
        honored: [],
        recommendations,
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "WARNING",
        violations: [],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);

    const stored = reviews[0];
    expect(stored.recommendations).toEqual(recommendations);
  });

  it("recommendations field absent when not provided", async () => {
    await storePrReview(
      {
        files: [],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews[0].recommendations).toBeUndefined();
  });

  it("each call generates a unique pr_review_id", async () => {
    const minimalInput = {
      files: [],
      honored: [],
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      verdict: "CLEAN" as const,
      violations: [],
    };

    const r1 = await storePrReview(minimalInput, tmpDir);
    const r2 = await storePrReview(minimalInput, tmpDir);

    expect(r1.review_id).not.toBe(r2.review_id);
  });

  // ---- Craft profile tests ----

  const validCraftProfile: CraftProfile = {
    ratings: [
      { dimension: "simplicity", band: "strong", evidence: "single-responsibility functions" },
      { dimension: "naming", band: "adequate", evidence: "mostly clear names" },
      { dimension: "cohesion", band: "weak", evidence: "mixed concerns in handler" },
      { dimension: "interface-depth", band: "n-a" },
    ],
    rollup: 2.0,
  };

  it("review WITH valid craft_profile → N craft_profiles rows (one per distinct area), review row still stored", async () => {
    // Two files from different subsystems
    const result = await storePrReview(
      {
        craft_profile: validCraftProfile,
        files: [
          "mcp-server/src/features/orchestration/tools/foo.ts",
          "mcp-server/src/features/pr-review/tools/bar.ts",
        ],
        honored: ["simplicity-first"],
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);

    // Review row still stored
    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);

    // craft_profiles rows: one per distinct subsystem (features/orchestration, features/pr-review)
    const db = getDriftDb(tmpDir);
    const rows = db.getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(2);

    const subsystems = new Set(rows.map((r) => r.subsystem_key));
    expect(subsystems).toContain("features/orchestration");
    expect(subsystems).toContain("features/pr-review");

    // Each row carries source:'review' and same ratings/rollup
    for (const row of rows) {
      expect(row.source).toBe("review");
      expect(row.ratings).toHaveLength(validCraftProfile.ratings.length);
      expect(row.rollup).toBe(validCraftProfile.rollup);
    }
  });

  it("review WITHOUT craft_profile → review stored + ZERO craft_profiles rows (no derivation from recommendations)", async () => {
    await storePrReview(
      {
        // No craft_profile provided
        files: ["mcp-server/src/features/orchestration/tools/foo.ts"],
        honored: [],
        recommendations: [
          {
            title: "thin-handlers",
            message: "Business logic should move to a service layer.",
            source: "principle",
          },
        ],
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "WARNING",
        violations: [],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1); // review still stored

    // ZERO craft_profiles rows — no derivation from recommendations
    const db = getDriftDb(tmpDir);
    const rows = db.getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  it("malformed craft_profile (bad band) → error returned, no craft_profiles row written", async () => {
    const malformedProfile = {
      ratings: [
        {
          dimension: "simplicity",
          band: "excellent", // invalid band — not in ["strong","adequate","weak","n-a"]
          evidence: "great code",
        },
      ],
    };

    await expect(
      storePrReview(
        {
          craft_profile: malformedProfile as unknown as CraftProfile,
          files: ["mcp-server/src/features/orchestration/tools/foo.ts"],
          honored: [],
          score: {
            conventions: { passed: 0, total: 0 },
            opinions: { passed: 0, total: 0 },
            rules: { passed: 0, total: 0 },
          },
          verdict: "CLEAN",
          violations: [],
        },
        tmpDir,
      ),
    ).rejects.toThrow();

    // No craft row written
    const db = getDriftDb(tmpDir);
    const rows = db.getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  it("backward compat: review without craft_profile has same behavior as before", async () => {
    // No craft_profile → unchanged store behavior
    const result = await storePrReview(
      {
        files: ["src/foo.ts"],
        honored: ["some-principle"],
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);
    expect(result.review_id).toMatch(/^rev_/);

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].craft_profile).toBeUndefined();
  });

  it("craft_profile with empty files → zero craft rows, no error", async () => {
    const result = await storePrReview(
      {
        craft_profile: validCraftProfile,
        files: [], // no files → no distinct areas
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);

    const db = getDriftDb(tmpDir);
    const rows = db.getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  it("craft_profile with files in same subsystem → exactly one craft row", async () => {
    await storePrReview(
      {
        craft_profile: validCraftProfile,
        files: [
          "mcp-server/src/features/orchestration/tools/foo.ts",
          "mcp-server/src/features/orchestration/tools/bar.ts",
        ],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      tmpDir,
    );

    const db = getDriftDb(tmpDir);
    const rows = db.getCraftProfiles().getRecentProfiles(10);
    expect(rows).toHaveLength(1); // same subsystem → one row
    expect(rows[0].subsystem_key).toBe("features/orchestration");
  });

  // ---- correctness-scan persistence filter ----

  it("does NOT persist correctness-scan violations to the review store", async () => {
    // correctness-scan is a pseudo-principle; it must never appear in stored reviews
    await storePrReview(
      {
        files: ["src/a.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        verdict: "BLOCKING",
        violations: [{ principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" }],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);
    const stored = reviews[0];
    // No correctness-scan violation persisted
    expect(stored.violations.map((v) => v.principle_id)).not.toContain(
      CORRECTNESS_SCAN_PRINCIPLE_ID,
    );
    expect(stored.violations).toHaveLength(0);
  });

  it("stores real violations while stripping correctness-scan from the same review", async () => {
    // Mixed input: one real violation + one correctness-scan.
    // Only the real violation should appear in the store.
    await storePrReview(
      {
        files: ["src/a.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 2 },
        },
        verdict: "BLOCKING",
        violations: [
          { principle_id: "thin-handlers", severity: "strong-opinion" },
          { principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" },
        ],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);
    const stored = reviews[0];
    // Only thin-handlers persisted, not correctness-scan
    expect(stored.violations).toHaveLength(1);
    expect(stored.violations[0].principle_id).toBe("thin-handlers");
    expect(stored.violations.map((v) => v.principle_id)).not.toContain(
      CORRECTNESS_SCAN_PRINCIPLE_ID,
    );
  });
});
