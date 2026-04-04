/**
 * Integration tests filling Wave 1 Known Gaps for DriftStore.getReviews() filter options.
 *
 * Wave 1 declared these as untested:
 *   - getReviews({ principleId }) filter path
 *   - getReviews({ branch }) filter path
 *   - getReviews({ prNumber }) filter path  (covered by pr-review-data.test.ts; included here for completeness of AND-logic)
 *   - getLastReviewForBranch()
 *
 * Wave 3 closed the prNumber/getLastReviewForPr gap via pr-review-data.test.ts.
 * This file closes the remaining three gaps.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriftStore } from "../drift/store.ts";
import type { ReviewEntry } from "../schema.ts";

function makeReview(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/a.ts"],
    honored: [],
    review_id: `rev_test_${Math.random().toString(36).slice(2, 8)}`,
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 1, total: 1 },
    },
    timestamp: "2026-03-15T00:00:00Z",
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

describe("DriftStore.getReviews() — filter options (Wave 1 Known Gaps)", () => {
  let tmpDir: string;
  let store: DriftStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-filter-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    store = new DriftStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  // getReviews({ principleId })

  describe("principleId filter", () => {
    it("returns reviews where the principle appears in violations", async () => {
      const matching = makeReview({
        honored: [],
        violations: [{ principle_id: "thin-handlers", severity: "rule" }],
      });
      const nonMatching = makeReview({
        honored: [],
        violations: [{ principle_id: "errors-are-values", severity: "rule" }],
      });
      await store.appendReview(matching);
      await store.appendReview(nonMatching);

      const results = await store.getReviews({ principleId: "thin-handlers" });

      expect(results).toHaveLength(1);
      expect(results[0].review_id).toBe(matching.review_id);
    });

    it("returns reviews where the principle appears in honored list", async () => {
      const matchingHonored = makeReview({
        honored: ["deep-modules", "thin-handlers"],
        violations: [],
      });
      const noMatch = makeReview({
        honored: ["errors-are-values"],
        violations: [],
      });
      await store.appendReview(matchingHonored);
      await store.appendReview(noMatch);

      const results = await store.getReviews({ principleId: "thin-handlers" });

      expect(results).toHaveLength(1);
      expect(results[0].review_id).toBe(matchingHonored.review_id);
    });

    it("returns reviews matching via either violations or honored (OR within principleId)", async () => {
      const viaViolation = makeReview({
        honored: [],
        violations: [{ principle_id: "p1", severity: "rule" }],
      });
      const viaHonored = makeReview({
        honored: ["p1"],
        violations: [],
      });
      const neither = makeReview({
        honored: ["p3"],
        violations: [{ principle_id: "p2", severity: "rule" }],
      });
      await store.appendReview(viaViolation);
      await store.appendReview(viaHonored);
      await store.appendReview(neither);

      const results = await store.getReviews({ principleId: "p1" });

      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.review_id);
      expect(ids).toContain(viaViolation.review_id);
      expect(ids).toContain(viaHonored.review_id);
    });

    it("returns empty array when no reviews mention the principle", async () => {
      await store.appendReview(makeReview({ honored: ["other-principle"] }));

      const results = await store.getReviews({ principleId: "nonexistent" });

      expect(results).toHaveLength(0);
    });
  });

  // getReviews({ branch })

  describe("branch filter", () => {
    it("returns only reviews for the specified branch", async () => {
      const onBranch = makeReview({ branch: "feat/my-feature" });
      const otherBranch = makeReview({ branch: "main" });
      const noBranch = makeReview();
      await store.appendReview(onBranch);
      await store.appendReview(otherBranch);
      await store.appendReview(noBranch);

      const results = await store.getReviews({ branch: "feat/my-feature" });

      expect(results).toHaveLength(1);
      expect(results[0].review_id).toBe(onBranch.review_id);
    });

    it("returns empty array when no reviews have the specified branch", async () => {
      await store.appendReview(makeReview({ branch: "main" }));

      const results = await store.getReviews({ branch: "feat/does-not-exist" });

      expect(results).toHaveLength(0);
    });

    it("excludes reviews with no branch field when filtering by branch", async () => {
      // A review without branch: undefined should not match a branch filter
      await store.appendReview(makeReview()); // no branch set

      const results = await store.getReviews({ branch: "feat/something" });

      expect(results).toHaveLength(0);
    });
  });

  // AND-combination of filters

  describe("combined filters (AND logic)", () => {
    it("applies branch AND prNumber filters together", async () => {
      const both = makeReview({ branch: "feat/x", pr_number: 99 });
      const branchOnly = makeReview({ branch: "feat/x" });
      const prOnly = makeReview({ pr_number: 99 });
      await store.appendReview(both);
      await store.appendReview(branchOnly);
      await store.appendReview(prOnly);

      const results = await store.getReviews({ branch: "feat/x", prNumber: 99 });

      expect(results).toHaveLength(1);
      expect(results[0].review_id).toBe(both.review_id);
    });

    it("applies principleId AND branch filters together", async () => {
      const bothMatch = makeReview({
        branch: "feat/y",
        honored: ["thin-handlers"],
      });
      const principleOnly = makeReview({
        honored: ["thin-handlers"],
      });
      const branchOnly = makeReview({
        branch: "feat/y",
        honored: ["other"],
      });
      await store.appendReview(bothMatch);
      await store.appendReview(principleOnly);
      await store.appendReview(branchOnly);

      const results = await store.getReviews({
        branch: "feat/y",
        principleId: "thin-handlers",
      });

      expect(results).toHaveLength(1);
      expect(results[0].review_id).toBe(bothMatch.review_id);
    });
  });

  // getLastReviewForBranch()

  describe("getLastReviewForBranch()", () => {
    it("returns the last (most recently appended) review for the branch", async () => {
      const first = makeReview({
        branch: "feat/branch-a",
        review_id: "rev_first",
        timestamp: "2026-03-10T00:00:00Z",
      });
      const second = makeReview({
        branch: "feat/branch-a",
        review_id: "rev_second",
        timestamp: "2026-03-12T00:00:00Z",
      });
      await store.appendReview(first);
      await store.appendReview(second);

      const result = await store.getLastReviewForBranch("feat/branch-a");

      expect(result).not.toBeNull();
      expect(result!.review_id).toBe("rev_second");
    });

    it("returns null when no reviews exist for the branch", async () => {
      await store.appendReview(makeReview({ branch: "main" }));

      const result = await store.getLastReviewForBranch("feat/nonexistent");

      expect(result).toBeNull();
    });

    it("returns null when the store is empty", async () => {
      const result = await store.getLastReviewForBranch("feat/any");

      expect(result).toBeNull();
    });

    it("ignores reviews for other branches", async () => {
      const mainReview = makeReview({ branch: "main", review_id: "rev_main" });
      const targetReview = makeReview({
        branch: "feat/target",
        review_id: "rev_target",
      });
      await store.appendReview(mainReview);
      await store.appendReview(targetReview);

      const result = await store.getLastReviewForBranch("feat/target");

      expect(result!.review_id).toBe("rev_target");
    });
  });
});
