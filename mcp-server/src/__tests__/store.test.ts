/**
 * Tests for DriftStore (SQLite-backed via DriftDb).
 *
 * Verifies that:
 * - DriftStore delegates to DriftDb (backed by SQLite drift.db)
 * - appendReview + getReviews round-trip
 * - All filter combinations work
 * - getLastReviewForPr and getLastReviewForBranch
 * - getComplianceTrend produces correct weekly buckets
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANON_DIR } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import type { ReviewEntry } from "../schema.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "canon-store-test-"));
}

function makeReview(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    review_id: `rev_test_${Math.random().toString(36).slice(2, 8)}`,
    files: ["src/a.ts"],
    violations: [],
    honored: [],
    score: {
      rules: { passed: 1, total: 1 },
      opinions: { passed: 0, total: 0 },
      conventions: { passed: 0, total: 0 },
    },
    verdict: "CLEAN",
    timestamp: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

describe("DriftStore (SQLite-backed)", () => {
  let tmpDir: string;
  let store: DriftStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, CANON_DIR), { recursive: true });
    store = new DriftStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // SQLite backing
  // --------------------------------------------------------------------------

  it("creates drift.db in the .canon directory on first use", async () => {
    await store.appendReview(makeReview());
    const dbPath = join(tmpDir, CANON_DIR, "drift.db");
    expect(existsSync(dbPath)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // appendReview + getReviews round-trip
  // --------------------------------------------------------------------------

  it("appends a review and reads it back with all fields intact", async () => {
    const entry = makeReview({
      review_id: "rev_roundtrip_01",
      files: ["src/a.ts", "src/b.ts"],
      violations: [{ principle_id: "thin-handlers", severity: "rule", message: "Handler too fat" }],
      honored: ["deep-modules"],
      verdict: "BLOCKING",
      timestamp: "2026-03-15T10:00:00Z",
      pr_number: 42,
      branch: "feat/my-feature",
    });

    await store.appendReview(entry);
    const reviews = await store.getReviews();

    expect(reviews).toHaveLength(1);
    const r = reviews[0];
    expect(r.review_id).toBe("rev_roundtrip_01");
    expect(r.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].principle_id).toBe("thin-handlers");
    expect(r.violations[0].message).toBe("Handler too fat");
    expect(r.honored).toEqual(["deep-modules"]);
    expect(r.verdict).toBe("BLOCKING");
    expect(r.pr_number).toBe(42);
    expect(r.branch).toBe("feat/my-feature");
  });

  it("returns empty array when no reviews have been appended", async () => {
    const reviews = await store.getReviews();
    expect(reviews).toEqual([]);
  });

  it("preserves review order (chronological by timestamp)", async () => {
    const first = makeReview({ review_id: "rev_first", timestamp: "2026-03-10T00:00:00Z" });
    const second = makeReview({ review_id: "rev_second", timestamp: "2026-03-12T00:00:00Z" });
    await store.appendReview(first);
    await store.appendReview(second);

    const reviews = await store.getReviews();
    expect(reviews[0].review_id).toBe("rev_first");
    expect(reviews[1].review_id).toBe("rev_second");
  });

  it("persists optional fields (file_priorities, recommendations)", async () => {
    const entry = makeReview({
      review_id: "rev_optional_01",
      file_priorities: [{ path: "src/a.ts", priority_score: 10 }],
      recommendations: [{ title: "Fix it", message: "Fix this now", source: "principle" }],
    });

    await store.appendReview(entry);
    const reviews = await store.getReviews();

    expect(reviews[0].file_priorities).toEqual([{ path: "src/a.ts", priority_score: 10 }]);
    expect(reviews[0].recommendations).toEqual([{ title: "Fix it", message: "Fix this now", source: "principle" }]);
  });

  // --------------------------------------------------------------------------
  // Filter: principleId
  // --------------------------------------------------------------------------

  it("filters by principleId matching violations", async () => {
    const matching = makeReview({
      violations: [{ principle_id: "thin-handlers", severity: "rule" }],
    });
    const nonMatching = makeReview({
      violations: [{ principle_id: "errors-are-values", severity: "rule" }],
    });
    await store.appendReview(matching);
    await store.appendReview(nonMatching);

    const results = await store.getReviews({ principleId: "thin-handlers" });
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe(matching.review_id);
  });

  it("filters by principleId matching honored list", async () => {
    const matching = makeReview({ honored: ["deep-modules"] });
    const nonMatching = makeReview({ honored: ["errors-are-values"] });
    await store.appendReview(matching);
    await store.appendReview(nonMatching);

    const results = await store.getReviews({ principleId: "deep-modules" });
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe(matching.review_id);
  });

  it("returns empty array when principleId matches nothing", async () => {
    await store.appendReview(makeReview({ honored: ["other-principle"] }));
    const results = await store.getReviews({ principleId: "nonexistent" });
    expect(results).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Filter: branch
  // --------------------------------------------------------------------------

  it("filters by branch", async () => {
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

  it("returns empty array when no reviews match branch filter", async () => {
    await store.appendReview(makeReview({ branch: "main" }));
    const results = await store.getReviews({ branch: "feat/does-not-exist" });
    expect(results).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Filter: prNumber
  // --------------------------------------------------------------------------

  it("filters by prNumber", async () => {
    const pr42 = makeReview({ pr_number: 42 });
    const pr99 = makeReview({ pr_number: 99 });
    await store.appendReview(pr42);
    await store.appendReview(pr99);

    const results = await store.getReviews({ prNumber: 42 });
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe(pr42.review_id);
  });

  // --------------------------------------------------------------------------
  // Filter: combined (AND logic)
  // --------------------------------------------------------------------------

  it("applies branch AND prNumber filters (AND logic)", async () => {
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

  it("applies principleId AND branch filters (AND logic)", async () => {
    const bothMatch = makeReview({ branch: "feat/y", honored: ["thin-handlers"] });
    const principleOnly = makeReview({ honored: ["thin-handlers"] });
    const branchOnly = makeReview({ branch: "feat/y", honored: ["other"] });
    await store.appendReview(bothMatch);
    await store.appendReview(principleOnly);
    await store.appendReview(branchOnly);

    const results = await store.getReviews({ principleId: "thin-handlers", branch: "feat/y" });
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe(bothMatch.review_id);
  });

  // --------------------------------------------------------------------------
  // getLastReviewForPr
  // --------------------------------------------------------------------------

  it("getLastReviewForPr returns most recent review for a PR number", async () => {
    const first = makeReview({
      review_id: "rev_pr_first",
      pr_number: 7,
      timestamp: "2026-03-10T00:00:00Z",
    });
    const second = makeReview({
      review_id: "rev_pr_second",
      pr_number: 7,
      timestamp: "2026-03-12T00:00:00Z",
    });
    await store.appendReview(first);
    await store.appendReview(second);

    const result = await store.getLastReviewForPr(7);
    expect(result).not.toBeNull();
    expect(result!.review_id).toBe("rev_pr_second");
  });

  it("getLastReviewForPr returns null when no reviews exist for PR", async () => {
    const result = await store.getLastReviewForPr(999);
    expect(result).toBeNull();
  });

  it("getLastReviewForPr returns null for empty store", async () => {
    const result = await store.getLastReviewForPr(1);
    expect(result).toBeNull();
  });

  // --------------------------------------------------------------------------
  // getLastReviewForBranch
  // --------------------------------------------------------------------------

  it("getLastReviewForBranch returns most recent review for a branch", async () => {
    const first = makeReview({
      review_id: "rev_branch_first",
      branch: "feat/branch-a",
      timestamp: "2026-03-10T00:00:00Z",
    });
    const second = makeReview({
      review_id: "rev_branch_second",
      branch: "feat/branch-a",
      timestamp: "2026-03-12T00:00:00Z",
    });
    await store.appendReview(first);
    await store.appendReview(second);

    const result = await store.getLastReviewForBranch("feat/branch-a");
    expect(result).not.toBeNull();
    expect(result!.review_id).toBe("rev_branch_second");
  });

  it("getLastReviewForBranch returns null when no reviews exist for branch", async () => {
    await store.appendReview(makeReview({ branch: "main" }));
    const result = await store.getLastReviewForBranch("feat/nonexistent");
    expect(result).toBeNull();
  });

  it("getLastReviewForBranch returns null for empty store", async () => {
    const result = await store.getLastReviewForBranch("feat/any");
    expect(result).toBeNull();
  });

  // --------------------------------------------------------------------------
  // getComplianceTrend
  // --------------------------------------------------------------------------

  it("getComplianceTrend returns empty array when no reviews exist", async () => {
    const trend = await store.getComplianceTrend("thin-handlers");
    expect(trend).toEqual([]);
  });

  it("getComplianceTrend buckets reviews by ISO week and computes pass rate", async () => {
    // Two reviews in the same week — one violation, one honored
    await store.appendReview(
      makeReview({
        review_id: "rev_w1_violation",
        violations: [{ principle_id: "thin-handlers", severity: "rule" }],
        honored: [],
        timestamp: "2026-03-16T00:00:00Z", // W12 (Monday)
      }),
    );
    await store.appendReview(
      makeReview({
        review_id: "rev_w1_honored",
        violations: [],
        honored: ["thin-handlers"],
        timestamp: "2026-03-17T00:00:00Z", // W12 (Tuesday)
      }),
    );

    const trend = await store.getComplianceTrend("thin-handlers");
    expect(trend).toHaveLength(1);
    expect(trend[0].violations).toBe(1);
    expect(trend[0].reviews).toBe(2);
    expect(trend[0].pass_rate).toBe(0.5); // 1 pass / 2 total
  });

  it("getComplianceTrend limits to most recent N weeks when weeks param provided", async () => {
    // 3 reviews in 3 different weeks
    await store.appendReview(
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: [],
        timestamp: "2026-03-02T00:00:00Z", // W10
      }),
    );
    await store.appendReview(
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: [],
        timestamp: "2026-03-09T00:00:00Z", // W11
      }),
    );
    await store.appendReview(
      makeReview({
        violations: [],
        honored: ["p1"],
        timestamp: "2026-03-16T00:00:00Z", // W12
      }),
    );

    const trend2 = await store.getComplianceTrend("p1", 2);
    expect(trend2).toHaveLength(2);
    // Should be the 2 most recent weeks
    expect(trend2[0].week).toContain("W11");
    expect(trend2[1].week).toContain("W12");
  });

  it("getComplianceTrend returns empty array when no reviews mention the principle", async () => {
    await store.appendReview(makeReview({ honored: ["other-principle"] }));
    const trend = await store.getComplianceTrend("nonexistent");
    expect(trend).toEqual([]);
  });
});
