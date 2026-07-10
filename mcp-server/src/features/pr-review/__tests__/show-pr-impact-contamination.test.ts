/**
 * show-pr-impact-contamination.test.ts
 *
 * Regression coverage for cross-PR top-level contamination: when
 * `showPrImpact` is called with no `branch`/`pr_number` filter (exactly how
 * the review renderer calls it), `findLatestReview`'s no-filter fallback used
 * to return the GLOBALLY latest stored review across ALL PRs, even when it
 * described a different, unrelated diff than the one `prep` was just computed
 * for. The fix anchors the no-filter selection to `prep.files` (the live-diff
 * change set) instead of "whatever was reviewed last."
 *
 * See DESIGN.md dc-02/dc-03 and fix-prep-anchored-review-PLAN.md.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks — must be declared before importing the module under test

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("../tools/pr-review-data.ts", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "node:fs";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { getPrReviewData } from "../tools/pr-review-data.ts";
import { showPrImpact } from "../tools/show-pr-impact.ts";
import { makePrepStub, makeSharedReview as makeReview } from "./show-pr-impact-test-utils.ts";

describe("showPrImpact — cross-PR top-level contamination (no-filter path)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-contam-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(getPrReviewData).mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("anchors the top-level review to prep.files instead of the globally-latest review", async () => {
    const store = new DriftStore(tmpDir);

    // Review B — an earlier review whose files match prep (the diff currently being rendered)
    await store.appendReview(
      makeReview({ files: ["src/featureB.ts"], pr_number: 485, review_id: "revB" }),
    );
    // Review A — appended AFTER B, so it is the globally-latest review by timestamp.
    // Its files are disjoint from prep — an unrelated prior PR.
    await store.appendReview(
      makeReview({ files: ["src/featureA.ts"], pr_number: 478, review_id: "revA" }),
    );

    // prep describes PR #485's change set (review B), NOT the globally-latest review (A).
    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub([{ path: "src/featureB.ts", status: "modified" }]) as never,
    );

    // Called exactly as the renderer calls it: no branch, no pr_number.
    const result = await showPrImpact(tmpDir, { diff_base: "abc", worktree_path: tmpDir });

    expect(result.has_review).toBe(true);
    expect(result.review?.files).toEqual(["src/featureB.ts"]);
    expect(result.review?.pr_number).toBe(485);
  });

  it("renders prep-only (has_review: false) when no stored review matches prep.files", async () => {
    const store = new DriftStore(tmpDir);

    // Only review A exists, and its files are disjoint from prep.
    await store.appendReview(
      makeReview({ files: ["src/featureA.ts"], pr_number: 478, review_id: "revA" }),
    );

    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub([{ path: "src/featureB.ts", status: "modified" }]) as never,
    );

    const result = await showPrImpact(tmpDir, { diff_base: "abc", worktree_path: tmpDir });

    expect(result.has_review).toBe(false);
    expect(result.review).toBeUndefined();
    expect(result.blastRadius).toBeUndefined();
    expect(result.subgraph.nodes).toEqual([]);
  });

  it("leaves the explicit pr_number filter path unchanged", async () => {
    const store = new DriftStore(tmpDir);

    // Review A is disjoint from prep, but is explicitly requested by pr_number.
    await store.appendReview(
      makeReview({ files: ["src/featureA.ts"], pr_number: 478, review_id: "revA" }),
    );

    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub([{ path: "src/featureB.ts", status: "modified" }]) as never,
    );

    const result = await showPrImpact(tmpDir, { pr_number: 478 });

    expect(result.has_review).toBe(true);
    expect(result.review?.pr_number).toBe(478);
    expect(result.review?.files).toEqual(["src/featureA.ts"]);
  });
});
