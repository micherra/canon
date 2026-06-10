/**
 * DriftDb Closure Tests — auto-closure and read-path exclusion (closure-02)
 *
 * Tests the getClosures() accessor, appendReview auto-superseding,
 * and the open-only violation reconstitution in getReviews().
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 */

import type { ReviewEntry } from "@shared/schema.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DriftDb } from "../drift-db.ts";
import { initDriftDb } from "../drift-schema.ts";

function makeReviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/foo.ts", "src/bar.ts"],
    honored: ["deep-modules"],
    review_id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 2, total: 2 },
    },
    timestamp: new Date().toISOString(),
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

function makeDb(): { store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { store };
}

// ---- auto-closure: appendReview supersedes open violations (closure-02) ----

describe("appendReview auto-closure via getClosures().supersedeOpenViolations", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("honored principle for a file with an open violation → resolved (AC1)", () => {
    // Seed: review that records a (F,P) violation
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [{ file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" }],
    });
    store.appendReview(seedReview);

    // Verify seed has 1 open violation
    expect(store.getClosures().countOpenViolations()).toBe(1);

    // New review: honors deep-modules on src/foo.ts, no violation for that pair
    const cleanReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_clean",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      violations: [],
    });
    store.appendReview(cleanReview);

    // The open violation should now be resolved
    expect(store.getClosures().countOpenViolations()).toBe(0);

    // Verify the resolved row has the correct provenance
    const allViolations = store
      .getClosures()
      .getViolationsByReviewId("rev_seed", { includeResolved: true });
    expect(allViolations).toHaveLength(1);
    expect(allViolations[0].status).toBe("resolved");
    expect(allViolations[0].resolved_by_review_id).toBe("rev_clean");
    expect(allViolations[0].resolution_reason).toBe("superseded-by-clean-review");
  });

  test("false-close guard: review that does NOT honor the principle → violation stays open (mandatory)", () => {
    // Seed: review that records a (F,P) violation
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [{ file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" }],
    });
    store.appendReview(seedReview);

    // New review: reviews the file but does NOT honor deep-modules (different principle)
    const unrelatedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["thin-handlers"], // different principle — NOT deep-modules
      review_id: "rev_unrelated",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      violations: [],
    });
    store.appendReview(unrelatedReview);

    // The original violation MUST remain open (false-close guard)
    expect(store.getClosures().countOpenViolations()).toBe(1);
    const openViolations = store.getClosures().getViolationsByReviewId("rev_seed");
    expect(openViolations).toHaveLength(1);
    expect(openViolations[0].status).toBe("open");
  });

  test("false-close guard: review that re-records the same (F,P) violation → stays open", () => {
    // Seed: open violation for (src/foo.ts, deep-modules) — honored[] also contains it,
    // but the recorded violation for the same (file, principle) must prevent closure
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_seed",
      violations: [{ file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" }],
    });
    store.appendReview(seedReview);

    // Violation should remain open: principle is in honored[] but also in violations[] for same file
    expect(store.getClosures().countOpenViolations()).toBe(1);
  });

  test("WARNING/BLOCKING review that honors P for F still supersedes prior (F,P) violation", () => {
    // Seed: open violation
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [{ file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" }],
    });
    store.appendReview(seedReview);

    // WARNING review that honors deep-modules for src/foo.ts but has a different violation
    const warningReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_warning",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      verdict: "WARNING",
      violations: [
        {
          file_path: "src/foo.ts",
          principle_id: "thin-handlers", // different principle
          severity: "strong-opinion",
        },
      ],
    });
    store.appendReview(warningReview);

    // deep-modules violation should be resolved (per-pair logic, not review-wide verdict)
    // Only thin-handlers violation from rev_warning remains open
    expect(store.getClosures().countOpenViolations()).toBe(1);
    const resolvedViolations = store
      .getClosures()
      .getViolationsByReviewId("rev_seed", { includeResolved: true });
    expect(resolvedViolations[0].status).toBe("resolved");
  });

  test("appendReview auto-closure is in-transaction — getReviews reflects both atomically", () => {
    // Seed a violation
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [{ file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" }],
    });
    store.appendReview(seedReview);

    // Clean review should atomically commit both the review and the supersession
    const cleanReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_clean",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      violations: [],
    });
    store.appendReview(cleanReview);

    // Immediately after appendReview, getReviews should show the resolved state
    const reviews = store.getReviews();
    expect(reviews).toHaveLength(2);
    // The seed review's violations should be empty (resolved violations excluded by open-only filter)
    const seedEntry = reviews.find((r) => r.review_id === "rev_seed");
    expect(seedEntry).toBeDefined();
    expect(seedEntry!.violations).toHaveLength(0);
  });
});

// ---- read-path exclusion: getReviews returns only open violations (closure-02) ----

describe("read-path exclusion: getReviews reconstitutes only open violations", () => {
  let store: DriftDb;

  beforeEach(() => {
    ({ store } = makeDb());
  });

  afterEach(() => {
    store.close();
  });

  test("after resolution, getReviews violations[] excludes resolved rows", () => {
    // Seed: review with 2 violations — one will be resolved, one won't
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts", "src/bar.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [
        { file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" },
        { file_path: "src/bar.ts", principle_id: "thin-handlers", severity: "strong-opinion" },
      ],
    });
    store.appendReview(seedReview);

    // Clean review for src/foo.ts only (resolves deep-modules violation)
    const cleanReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_clean",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      violations: [],
    });
    store.appendReview(cleanReview);

    // getReviews should show seed with only the thin-handlers violation (open)
    const reviews = store.getReviews();
    const seedEntry = reviews.find((r) => r.review_id === "rev_seed");
    expect(seedEntry).toBeDefined();
    expect(seedEntry!.violations).toHaveLength(1);
    expect(seedEntry!.violations[0].principle_id).toBe("thin-handlers");
  });

  test("audit read (includeResolved: true) still returns resolved violation (AC2)", () => {
    // Seed and resolve a violation
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [{ file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" }],
    });
    store.appendReview(seedReview);

    const cleanReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_clean",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      violations: [],
    });
    store.appendReview(cleanReview);

    // open-only read: empty
    const openOnly = store.getClosures().getViolationsByReviewId("rev_seed");
    expect(openOnly).toHaveLength(0);

    // inclusive read: resolved row still present
    const allRows = store
      .getClosures()
      .getViolationsByReviewId("rev_seed", { includeResolved: true });
    expect(allRows).toHaveLength(1);
    expect(allRows[0].status).toBe("resolved");
  });

  test("open count excludes resolved violations", () => {
    // 2 violations seeded
    const seedReview = makeReviewEntry({
      files: ["src/foo.ts", "src/bar.ts"],
      honored: [],
      review_id: "rev_seed",
      violations: [
        { file_path: "src/foo.ts", principle_id: "deep-modules", severity: "rule" },
        { file_path: "src/bar.ts", principle_id: "thin-handlers", severity: "strong-opinion" },
      ],
    });
    store.appendReview(seedReview);

    expect(store.getClosures().countOpenViolations()).toBe(2);

    // Resolve one
    const cleanReview = makeReviewEntry({
      files: ["src/foo.ts"],
      honored: ["deep-modules"],
      review_id: "rev_clean",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      violations: [],
    });
    store.appendReview(cleanReview);

    // Only 1 remains open
    expect(store.getClosures().countOpenViolations()).toBe(1);
  });
});
