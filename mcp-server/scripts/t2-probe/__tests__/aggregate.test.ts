/**
 * aggregate.test.ts — coverage for the T2 probe aggregation/verdict pipeline.
 *
 * Every exported function is pure (no I/O) — synthetic fixtures only, no
 * real drift.db or JSONL file. `main()` is not unit-tested directly (it's
 * the thin I/O shell); the verify step runs it once against a synthetic
 * dataset end-to-end per DESIGN.md.
 */

import type { ReviewEntry } from "@shared/schema.ts";
import { describe, expect, it } from "vitest";
import {
  applyVerdict,
  dedupeRecords,
  joinRecordsToReviews,
  MIN_POSITIVE_UNITS,
  MIN_SCORED_RECORDS,
  parseRecords,
  scoreRecords,
} from "../aggregate.ts";
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

// ---- parseRecords ----

describe("parseRecords", () => {
  it("parses well-formed JSONL lines", () => {
    const lines = [JSON.stringify(record({ record_id: "r1" })), JSON.stringify(record({ record_id: "r2" }))];
    const { malformed, records } = parseRecords(lines);
    expect(records).toHaveLength(2);
    expect(malformed).toBe(0);
  });

  it("counts malformed lines and never throws", () => {
    const lines = [JSON.stringify(record({ record_id: "r1" })), "not json{{{", JSON.stringify({ incomplete: true })];
    expect(() => {
      const { malformed, records } = parseRecords(lines);
      expect(records).toHaveLength(1);
      expect(malformed).toBe(2);
    }).not.toThrow();
  });

  it("skips blank lines without counting them as malformed", () => {
    const lines = ["", "  ", JSON.stringify(record({ record_id: "r1" }))];
    const { malformed, records } = parseRecords(lines);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(0);
  });
});

// ---- parseRecords: findings[] element validation (W2) ----

describe("parseRecords — findings element shape (W2)", () => {
  it("a findings element missing file_path counts the whole line as malformed, not a record", () => {
    const badRecord = {
      ...record({ record_id: "r1" }),
      findings: [{ description: "no file_path here" }],
    };
    const lines = [JSON.stringify(badRecord)];

    expect(() => {
      const { malformed, records } = parseRecords(lines);
      expect(records).toHaveLength(0);
      expect(malformed).toBe(1);
    }).not.toThrow();
  });

  it("a findings element missing description counts the line as malformed", () => {
    const badRecord = {
      ...record({ record_id: "r1" }),
      findings: [{ file_path: "a.ts", line: 1 }],
    };
    const { malformed, records } = parseRecords([JSON.stringify(badRecord)]);
    expect(records).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it("a findings element with a wrong-type line (not number|null) counts the line as malformed", () => {
    const badRecord = {
      ...record({ record_id: "r1" }),
      findings: [{ description: "d", file_path: "a.ts", line: "not-a-number" }],
    };
    const { malformed, records } = parseRecords([JSON.stringify(badRecord)]);
    expect(records).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it("a well-formed findings element (including line:null) still parses as a valid record", () => {
    const goodRecord = {
      ...record({ record_id: "r1" }),
      findings: [{ description: "d", file_path: "a.ts", line: null }],
    };
    const { malformed, records } = parseRecords([JSON.stringify(goodRecord)]);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(0);
  });

  it("a record with a malformed findings element never reaches scoreRecords via the normal pipeline, so it cannot crash it", () => {
    const badRecord = {
      ...record({ record_id: "r1", touched_files: ["a.ts"] }),
      findings: [{ description: "no file_path" }],
    };
    const { records } = parseRecords([JSON.stringify(badRecord)]);
    // The malformed record was filtered out by parseRecords — nothing reaches
    // joinRecordsToReviews/scoreRecords, so there is nothing left that could throw.
    expect(records).toHaveLength(0);
  });
});

// ---- dedupeRecords ----

describe("dedupeRecords", () => {
  it("keeps the latest record per (branch, head_sha)", () => {
    const older = record({ head_sha: "sha1", record_id: "r1", timestamp: "2026-01-01T00:00:00.000Z" });
    const newer = record({ head_sha: "sha1", record_id: "r2", timestamp: "2026-01-02T00:00:00.000Z" });
    const deduped = dedupeRecords([older, newer]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].record_id).toBe("r2");
  });

  it("keeps records with distinct (branch, head_sha) pairs", () => {
    const a = record({ branch: "feat/a", head_sha: "sha1", record_id: "r1" });
    const b = record({ branch: "feat/b", head_sha: "sha1", record_id: "r2" });
    const deduped = dedupeRecords([a, b]);
    expect(deduped).toHaveLength(2);
  });
});

// ---- joinRecordsToReviews ----

describe("joinRecordsToReviews (AC4 / P2(b))", () => {
  it("layer 1: review_id exact match wins even when a layer-2 candidate exists for a different review", () => {
    const rec = record({ branch: "feat/x", head_sha: "sha_other", record_id: "r1", review_id: "rev_exact" });
    const exact = review({ branch: "feat/x", last_reviewed_sha: "sha_different", review_id: "rev_exact" });
    const layer2Candidate = review({ branch: "feat/x", last_reviewed_sha: "sha_other", review_id: "rev_layer2" });

    const [result] = joinRecordsToReviews([rec], [exact, layer2Candidate]);
    expect(result.status).toBe("joined");
    if (result.status === "joined") {
      expect(result.layer).toBe(1);
      expect(result.review.review_id).toBe("rev_exact");
    }
  });

  it("layer 2: branch + last_reviewed_sha === head_sha joins the SHA-matching review, not the first or latest", () => {
    const rec = record({ branch: "feat/x", head_sha: "sha2", record_id: "r1" });
    const firstReview = review({
      branch: "feat/x",
      last_reviewed_sha: "sha1",
      review_id: "rev_first",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const matchingReview = review({
      branch: "feat/x",
      last_reviewed_sha: "sha2",
      review_id: "rev_matching",
      timestamp: "2026-01-03T00:00:00.000Z",
    });
    const latestReview = review({
      branch: "feat/x",
      last_reviewed_sha: "sha3",
      review_id: "rev_latest",
      timestamp: "2026-01-05T00:00:00.000Z",
    });

    const [result] = joinRecordsToReviews([rec], [firstReview, matchingReview, latestReview]);
    expect(result.status).toBe("joined");
    if (result.status === "joined") {
      expect(result.layer).toBe(2);
      expect(result.review.review_id).toBe("rev_matching");
    }
  });

  it("layer 3: branch + unique same-branch review within +/-2h window joins", () => {
    const rec = record({
      branch: "feat/x",
      head_sha: "sha_unresolved",
      record_id: "r1",
      timestamp: "2026-01-01T12:00:00.000Z",
    });
    const withinWindow = review({
      branch: "feat/x",
      review_id: "rev_window",
      timestamp: "2026-01-01T13:00:00.000Z",
    });
    const outsideWindow = review({
      branch: "feat/x",
      review_id: "rev_outside",
      timestamp: "2026-01-02T20:00:00.000Z",
    });

    const [result] = joinRecordsToReviews([rec], [withinWindow, outsideWindow]);
    expect(result.status).toBe("joined");
    if (result.status === "joined") {
      expect(result.layer).toBe(3);
      expect(result.review.review_id).toBe("rev_window");
    }
  });

  it("layer 3: two same-branch candidates within window -> unjoinable, never a guess", () => {
    const rec = record({
      branch: "feat/x",
      head_sha: "sha_unresolved",
      record_id: "r1",
      timestamp: "2026-01-01T12:00:00.000Z",
    });
    const candidateA = review({ branch: "feat/x", review_id: "rev_a", timestamp: "2026-01-01T12:30:00.000Z" });
    const candidateB = review({ branch: "feat/x", review_id: "rev_b", timestamp: "2026-01-01T13:30:00.000Z" });

    const [result] = joinRecordsToReviews([rec], [candidateA, candidateB]);
    expect(result.status).toBe("unjoinable");
  });

  it("no matching review at any layer -> unjoinable", () => {
    const rec = record({ branch: "feat/x", head_sha: "sha_none", record_id: "r1" });
    const unrelated = review({ branch: "feat/y", review_id: "rev_unrelated" });

    const [result] = joinRecordsToReviews([rec], [unrelated]);
    expect(result.status).toBe("unjoinable");
  });
});

// ---- scoreRecords ----

describe("scoreRecords", () => {
  it("AC3/P2(a): failed-open records are excluded from every recall/FP denominator", () => {
    const cleanRec = record({
      failed_open: false,
      record_id: "r1",
      touched_files: ["a.ts"],
    });
    const cleanReview = review({
      review_id: "rev1",
      violations: [{ file_path: "a.ts", principle_id: PRINCIPLE, severity: "medium" }],
    });
    const withoutFailedOpen = scoreRecords([{ layer: 1, record: cleanRec, review: cleanReview, status: "joined" }]);

    const failedOpenRec = record({ failed_open: true, record_id: "r2", touched_files: ["b.ts", "c.ts"] });
    const failedOpenReview = review({
      review_id: "rev2",
      violations: [{ file_path: "b.ts", principle_id: PRINCIPLE, severity: "high" }],
    });
    const withFailedOpenMixedIn = scoreRecords([
      { layer: 1, record: cleanRec, review: cleanReview, status: "joined" },
      { layer: 1, record: failedOpenRec, review: failedOpenReview, status: "joined" },
    ]);

    expect(withFailedOpenMixedIn.recall).toBe(withoutFailedOpen.recall);
    expect(withFailedOpenMixedIn.fp_rate).toBe(withoutFailedOpen.fp_rate);
    expect(withFailedOpenMixedIn.positive_units).toBe(withoutFailedOpen.positive_units);
    expect(withFailedOpenMixedIn.negative_units).toBe(withoutFailedOpen.negative_units);
    expect(withFailedOpenMixedIn.failed_open_count).toBe(1);
    expect(withoutFailedOpen.failed_open_count).toBe(0);
  });

  it("AC6: per-finding recall — 3 planted misses in 3 files, checker catches 1 -> recall = 1/3", () => {
    const rec = record({
      findings: [{ description: "caught it", file_path: "a.ts", line: 1 }],
      record_id: "r1",
      touched_files: ["a.ts", "b.ts", "c.ts"],
    });
    const rev = review({
      review_id: "rev1",
      violations: [
        { file_path: "a.ts", principle_id: PRINCIPLE, severity: "low" },
        { file_path: "b.ts", principle_id: PRINCIPLE, severity: "low" },
        { file_path: "c.ts", principle_id: PRINCIPLE, severity: "low" },
      ],
    });

    const score = scoreRecords([{ layer: 1, record: rec, review: rev, status: "joined" }]);

    expect(score.positive_units).toBe(3);
    expect(score.caught).toBe(1);
    expect(score.recall).toBeCloseTo(1 / 3);
  });

  it("a path-less reviewer violation is excluded from scoring, not counted as a positive", () => {
    const rec = record({ record_id: "r1", touched_files: ["a.ts"] });
    const rev = review({
      review_id: "rev1",
      violations: [{ principle_id: PRINCIPLE, severity: "low" }],
    });

    const score = scoreRecords([{ layer: 1, record: rec, review: rev, status: "joined" }]);

    expect(score.excluded_no_file_path).toBe(1);
    expect(score.positive_units).toBe(0);
    expect(score.negative_units).toBe(1);
  });

  it("normalizes paths (leading ./ and separators) before matching", () => {
    const rec = record({
      findings: [{ description: "caught", file_path: "./a.ts", line: null }],
      record_id: "r1",
      touched_files: ["./a.ts"],
    });
    const rev = review({
      review_id: "rev1",
      violations: [{ file_path: "a.ts", principle_id: PRINCIPLE, severity: "low" }],
    });

    const score = scoreRecords([{ layer: 1, record: rec, review: rev, status: "joined" }]);

    expect(score.positive_units).toBe(1);
    expect(score.caught).toBe(1);
  });

  it("a touched file with no reviewer violation is a negative; a checker finding on it is a false positive", () => {
    const rec = record({
      findings: [{ description: "spurious", file_path: "a.ts", line: null }],
      record_id: "r1",
      touched_files: ["a.ts"],
    });
    const rev = review({ review_id: "rev1", violations: [] });

    const score = scoreRecords([{ layer: 1, record: rec, review: rev, status: "joined" }]);

    expect(score.negative_units).toBe(1);
    expect(score.false_positives).toBe(1);
    expect(score.fp_rate).toBe(1);
  });

  it("unjoinable records are counted but excluded from scoring", () => {
    const rec = record({ failed_open: false, record_id: "r1", touched_files: ["a.ts"] });
    const score = scoreRecords([{ record: rec, status: "unjoinable" }]);

    expect(score.unjoinable_count).toBe(1);
    expect(score.positive_units).toBe(0);
    expect(score.negative_units).toBe(0);
  });
});

// ---- applyVerdict ----

describe("applyVerdict (AC7)", () => {
  const baseScore = {
    caught: 0,
    excluded_no_file_path: 0,
    failed_open_count: 0,
    false_positives: 0,
    fp_rate: 0,
    negative_units: 0,
    positive_units: 0,
    recall: 0,
    scored_record_count: 0,
    unjoinable_count: 0,
  };

  it("PASS: recall >= 0.80 and fp_rate <= 0.10, N-gate met", () => {
    const score = { ...baseScore, fp_rate: 0.05, positive_units: MIN_POSITIVE_UNITS, recall: 0.85, scored_record_count: MIN_SCORED_RECORDS };
    const { verdict } = applyVerdict(score, MIN_SCORED_RECORDS);
    expect(verdict).toBe("PASS");
  });

  it("FALSIFY: recall < 0.50", () => {
    const score = { ...baseScore, fp_rate: 0.05, positive_units: MIN_POSITIVE_UNITS, recall: 0.4, scored_record_count: MIN_SCORED_RECORDS };
    const { verdict } = applyVerdict(score, MIN_SCORED_RECORDS);
    expect(verdict).toBe("FALSIFY");
  });

  it("FALSIFY: fp_rate > 0.35", () => {
    const score = { ...baseScore, fp_rate: 0.5, positive_units: MIN_POSITIVE_UNITS, recall: 0.9, scored_record_count: MIN_SCORED_RECORDS };
    const { verdict } = applyVerdict(score, MIN_SCORED_RECORDS);
    expect(verdict).toBe("FALSIFY");
  });

  it("CONTINUE: mid-zone (neither PASS nor FALSIFY thresholds met)", () => {
    const score = { ...baseScore, fp_rate: 0.2, positive_units: MIN_POSITIVE_UNITS, recall: 0.65, scored_record_count: MIN_SCORED_RECORDS };
    const { verdict } = applyVerdict(score, MIN_SCORED_RECORDS);
    expect(verdict).toBe("CONTINUE");
  });

  it("CONTINUE(insufficient_n): fewer than MIN_SCORED_RECORDS scored records, even with strong recall/fp", () => {
    const score = { ...baseScore, fp_rate: 0.05, positive_units: MIN_POSITIVE_UNITS, recall: 0.9, scored_record_count: MIN_SCORED_RECORDS - 1 };
    const { reason, verdict } = applyVerdict(score, MIN_SCORED_RECORDS - 1);
    expect(verdict).toBe("CONTINUE");
    expect(reason).toBe("insufficient_n");
  });

  it("CONTINUE(insufficient_n): fewer than MIN_POSITIVE_UNITS positives, even with enough scored records", () => {
    const score = { ...baseScore, fp_rate: 0.05, positive_units: MIN_POSITIVE_UNITS - 1, recall: 0.9, scored_record_count: MIN_SCORED_RECORDS };
    const { reason, verdict } = applyVerdict(score, MIN_SCORED_RECORDS);
    expect(verdict).toBe("CONTINUE");
    expect(reason).toBe("insufficient_n");
  });
});
