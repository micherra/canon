/**
 * measure.test.ts — regression coverage for the T2 probe positive/negative
 * split. This split had zero test coverage until now, which is exactly how
 * the original bug (violation-OR-honored `getReviews({principleId})` inflating
 * the positive set 6 -> 24) shipped unnoticed: it matched its own DESIGN.md
 * ASSUMPTION 1/3 in prose but not in code. `findViolationReviewIds` and
 * `classifyReviews` are both pure/injectable — no real DB, no model calls.
 */

import type { ReviewEntry } from "@shared/schema.ts";
import { describe, expect, it } from "vitest";
import { classifyReviews, findViolationReviewIds, type ReviewsSource } from "../measure.ts";

const PRINCIPLE = "leave-touched-files-better";

function review(overrides: Partial<ReviewEntry> & { review_id: string }): ReviewEntry {
  return {
    files: [],
    honored: [],
    score: { conventions: { passed: 0, total: 0 }, opinions: { passed: 0, total: 0 }, rules: { passed: 0, total: 0 } },
    timestamp: "2026-01-01T00:00:00.000Z",
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

describe("classifyReviews", () => {
  it("(a) a review with a recorded violation is positive", () => {
    const violated = review({ review_id: "rev_violated" });
    const { positives, negatives } = classifyReviews([violated], new Set(["rev_violated"]));

    expect(positives.map((r) => r.review_id)).toEqual(["rev_violated"]);
    expect(negatives).toEqual([]);
  });

  it("(b) a review assessed-and-honored but never violated is negative, NOT positive", () => {
    const honoredOnly = review({ honored: [PRINCIPLE], review_id: "rev_honored_only" });
    const { positives, negatives } = classifyReviews([honoredOnly], new Set());

    expect(positives).toEqual([]);
    expect(negatives.map((r) => r.review_id)).toEqual(["rev_honored_only"]);
  });

  it("(c) a review that never mentioned the principle is negative", () => {
    const unrelated = review({ review_id: "rev_unrelated" });
    const { positives, negatives } = classifyReviews([unrelated], new Set());

    expect(positives).toEqual([]);
    expect(negatives.map((r) => r.review_id)).toEqual(["rev_unrelated"]);
  });

  it("classifies a mixed batch correctly (violated + honored-only + unrelated)", () => {
    const violated = review({ review_id: "rev_violated" });
    const honoredOnly = review({ honored: [PRINCIPLE], review_id: "rev_honored_only" });
    const unrelated = review({ review_id: "rev_unrelated" });

    const { positives, negatives } = classifyReviews(
      [violated, honoredOnly, unrelated],
      new Set(["rev_violated"]),
    );

    expect(positives.map((r) => r.review_id)).toEqual(["rev_violated"]);
    expect(negatives.map((r) => r.review_id).sort()).toEqual(["rev_honored_only", "rev_unrelated"]);
  });
});

describe("findViolationReviewIds", () => {
  it("regression: excludes honored-only reviews even though a naive violation-OR-honored query would include them", () => {
    // Mirrors the real bug: `rev_honored_only` has the principle in `honored`
    // but no entry in `violations`. A fake DriftDb whose `getReviews` returns
    // both the true-violation review and the honored-only review; the ONLY
    // correct way to distinguish them is via the `violations` array, not `honored`.
    const violated = review({ review_id: "rev_violated", violations: [{ principle_id: PRINCIPLE, severity: "medium" }] });
    const honoredOnly = review({ honored: [PRINCIPLE], review_id: "rev_honored_only" });

    const fakeDriftDb: ReviewsSource = {
      getReviews: (options) => {
        expect(options).toEqual({ includeResolvedViolations: true });
        return [violated, honoredOnly];
      },
    };

    const ids = findViolationReviewIds(fakeDriftDb, PRINCIPLE);

    expect(ids).toEqual(new Set(["rev_violated"]));
  });

  it("includes resolved (not just open) violations — a fixed violation still counts historically", () => {
    const resolvedViolation = review({
      review_id: "rev_resolved",
      violations: [{ principle_id: PRINCIPLE, severity: "low" }],
    });

    const fakeDriftDb: ReviewsSource = {
      getReviews: () => [resolvedViolation],
    };

    const ids = findViolationReviewIds(fakeDriftDb, PRINCIPLE);

    expect(ids).toEqual(new Set(["rev_resolved"]));
  });

  it("ignores violations for a different principle", () => {
    const otherPrincipleViolation = review({
      review_id: "rev_other",
      violations: [{ principle_id: "some-other-principle", severity: "low" }],
    });

    const fakeDriftDb: ReviewsSource = {
      getReviews: () => [otherPrincipleViolation],
    };

    const ids = findViolationReviewIds(fakeDriftDb, PRINCIPLE);

    expect(ids).toEqual(new Set());
  });
});
