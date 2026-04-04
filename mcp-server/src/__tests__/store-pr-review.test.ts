import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriftStore } from "../drift/store.ts";
import { storePrReview } from "../tools/store-pr-review.ts";

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
});
