/**
 * aggregate-backfill.test.ts — coverage for backfill-aware aggregation (AC-2, d-t2fix-04).
 *
 * Every exported function under test is pure (no I/O) — synthetic fixtures only.
 */

import type { ReviewEntry } from "@shared/schema.ts";
import { describe, expect, it } from "vitest";
import { isLatencyEligible, joinRecordsToReviews, renderReport, scoreRecords } from "../aggregate.ts";
import type { CheckerRunRecord } from "../record.ts";

const PRINCIPLE = "leave-touched-files-better";

function record(overrides: Partial<CheckerRunRecord> & { record_id: string }): CheckerRunRecord {
  return {
    base_sha: "base",
    branch: "feat/x",
    checker_elapsed_ms: 100,
    failed_open: false,
    findings: [],
    head_sha: "head",
    rubric_hash: "hash1",
    slug: "slug",
    timestamp: "2026-01-01T00:00:00.000Z",
    touched_files: [],
    ...overrides,
  };
}

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

// ---- isLatencyEligible ----

describe("isLatencyEligible", () => {
  it("a backfilled record is NOT latency-eligible", () => {
    const rec = record({ backfilled: true, checker_elapsed_ms: 0, record_id: "r1" });
    expect(isLatencyEligible(rec)).toBe(false);
  });

  it("a native record with backfilled absent is latency-eligible", () => {
    const rec = record({ record_id: "r1" });
    expect(isLatencyEligible(rec)).toBe(true);
  });

  it("a record with backfilled:false is latency-eligible", () => {
    const rec = record({ backfilled: false, record_id: "r1" });
    expect(isLatencyEligible(rec)).toBe(true);
  });
});

// ---- renderReport: native/backfilled split disclosure ----

describe("renderReport — backfill split disclosure", () => {
  it("discloses n=8 as 4 native + 4 backfilled", () => {
    const joined = [
      ...Array.from({ length: 4 }, (_, i) =>
        joinRecordsToReviews(
          [record({ branch: "feat/x", head_sha: `native_${i}`, record_id: `native_${i}` })],
          [review({ branch: "feat/x", last_reviewed_sha: `native_${i}`, review_id: `rev_native_${i}` })],
        )[0],
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        joinRecordsToReviews(
          [record({ backfilled: true, branch: "feat/x", checker_elapsed_ms: 0, head_sha: `bf_${i}`, record_id: `bf_${i}` })],
          [review({ branch: "feat/x", last_reviewed_sha: `bf_${i}`, review_id: `rev_bf_${i}` })],
        )[0],
      ),
    ];

    const score = scoreRecords(joined);
    const report = renderReport({
      coverageReviewsInWindow: 8,
      joined,
      malformed: 0,
      reason: "insufficient_n",
      rubricHashes: ["hash1"],
      score,
      verdict: "CONTINUE",
    });

    expect(report).toContain("- Sample: n=8 (4 native + 4 backfilled; backfilled excluded from latency, included in finding-rate & sample-size)");
  });
});

// ---- scoreRecords: backfilled records count toward sample size (d-t2fix-04) ----

describe("scoreRecords — backfilled records count toward the n-gate", () => {
  it("4 native + 4 backfilled records yield scored_record_count === 8", () => {
    const joined = [
      ...Array.from({ length: 4 }, (_, i) =>
        joinRecordsToReviews(
          [record({ branch: "feat/x", head_sha: `native_${i}`, record_id: `native_${i}`, touched_files: ["a.ts"] })],
          [review({ branch: "feat/x", last_reviewed_sha: `native_${i}`, review_id: `rev_native_${i}` })],
        )[0],
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        joinRecordsToReviews(
          [
            record({
              backfilled: true,
              branch: "feat/x",
              checker_elapsed_ms: 0,
              head_sha: `bf_${i}`,
              record_id: `bf_${i}`,
              touched_files: ["a.ts"],
            }),
          ],
          [review({ branch: "feat/x", last_reviewed_sha: `bf_${i}`, review_id: `rev_bf_${i}` })],
        )[0],
      ),
    ];

    const score = scoreRecords(joined);

    expect(score.scored_record_count).toBe(8);
  });
});
