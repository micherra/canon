import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { storePrReview } from "../tools/store-pr-review.js";
import { PrStore } from "../drift/pr-store.js";

describe("storePrReview", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-store-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls PrStore.appendReview with server-generated id and timestamp", async () => {
    const before = Date.now();

    const result = await storePrReview(
      {
        verdict: "CLEAN",
        files: ["src/foo.ts"],
        violations: [],
        honored: ["some-principle"],
        score: {
          rules: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          conventions: { passed: 1, total: 1 },
        },
      },
      tmpDir
    );

    const after = Date.now();

    expect(result.recorded).toBe(true);
    expect(result.pr_review_id).toMatch(/^prr_/);

    // Verify it was actually persisted
    const store = new PrStore(tmpDir);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);

    const stored = reviews[0];
    expect(stored.pr_review_id).toBe(result.pr_review_id);
    expect(stored.verdict).toBe("CLEAN");

    // Timestamp should be a valid ISO date within our test window
    const storedTime = new Date(stored.timestamp).getTime();
    expect(storedTime).toBeGreaterThanOrEqual(before);
    expect(storedTime).toBeLessThanOrEqual(after + 1000); // allow 1s buffer
  });

  it("returned pr_review_id matches prr_ prefix pattern", async () => {
    const result = await storePrReview(
      {
        verdict: "WARNING",
        files: [],
        violations: [{ principle_id: "some-rule", severity: "strong-opinion" }],
        honored: [],
        score: {
          rules: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    // Format: prr_YYYYMMDD_<16 hex chars>
    expect(result.pr_review_id).toMatch(/^prr_\d{8}_[0-9a-f]{16}$/);
  });

  it("stores with minimal required fields only", async () => {
    const result = await storePrReview(
      {
        verdict: "BLOCKING",
        files: [],
        violations: [{ principle_id: "validate-at-trust-boundaries", severity: "rule" }],
        honored: [],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.pr_review_id).toBeTruthy();

    const store = new PrStore(tmpDir);
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
        pr_number: 42,
        branch: "feature/my-feature",
        last_reviewed_sha: "deadbeef123",
        verdict: "WARNING",
        files: ["src/a.ts", "src/b.ts"],
        violations: [
          {
            principle_id: "thin-handlers",
            severity: "strong-opinion",
            file_path: "src/a.ts",
            impact_score: 7.5,
          },
        ],
        honored: ["errors-are-values", "validate-at-trust-boundaries"],
        score: {
          rules: { passed: 2, total: 2 },
          opinions: { passed: 1, total: 2 },
          conventions: { passed: 1, total: 1 },
        },
        file_priorities: [
          { path: "src/a.ts", priority_score: 0.9 },
          { path: "src/b.ts", priority_score: 0.4 },
        ],
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);

    const store = new PrStore(tmpDir);
    const reviews = await store.getReviews(42);
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

  it("each call generates a unique pr_review_id", async () => {
    const minimalInput = {
      verdict: "CLEAN" as const,
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    };

    const r1 = await storePrReview(minimalInput, tmpDir);
    const r2 = await storePrReview(minimalInput, tmpDir);

    expect(r1.pr_review_id).not.toBe(r2.pr_review_id);
  });
});
