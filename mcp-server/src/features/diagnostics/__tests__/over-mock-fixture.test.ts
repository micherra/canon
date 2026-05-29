/**
 * FIXTURE: Anti-over-mock pattern reference
 *
 * This file is a self-contained illustration for the reviewer's Stage 2
 * "Test Quality — Interaction-Only Tests" axis. It demonstrates:
 *
 *   (a) The ANTI-PATTERN: a test that mocks a collaborator and asserts ONLY
 *       toHaveBeenCalledWith — verifying wiring, not behavior.
 *
 *   (b) The CORRECT pattern: a test that mocks infrastructure and still
 *       asserts a real behavioral outcome.
 *
 * Neither test imports production modules — they use local trivial functions
 * so the suite stays green and self-contained.
 *
 * A reviewer reading the diff should flag (a) under the Interaction-Only Tests
 * sub-axis and suggest replacing the interaction assertion with a real-path
 * assertion on the return value or output.
 */

import { describe, expect, it, vi } from "vitest";

// ─── Local stubs (no production imports) ────────────────────────────────────

/**
 * A trivial pure computation the tests pretend to verify.
 * In a real codebase this might be `computeAccuracy`, `buildSummary`, etc.
 */
function computeScore(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * A coordinator that calls `computeScore` and passes the result to a sink.
 * In production this mirrors a composition-layer handler.
 */
function runPipeline(
  values: number[],
  scorer: (v: number[]) => number,
  sink: (score: number) => void,
): void {
  const result = scorer(values);
  sink(result);
}

// ─── (a) ANTI-PATTERN: interaction-only test ────────────────────────────────
//
// FIXTURE: over-mock anti-pattern
//
// This test mocks `computeScore` (the unit whose behavior the test NAME claims
// to verify) and then asserts ONLY toHaveBeenCalledWith on that mock.
// It would pass even if `computeScore` returned NaN, because the real
// implementation never runs and no real output is ever checked.
//
// Reviewer should flag: "mocks `computeScore` then asserts only
// toHaveBeenCalledWith on it; add a real-path assertion on the pipeline output."

describe("runPipeline — ANTI-PATTERN (interaction-only)", () => {
  it("calls computeScore with the provided values", () => {
    // FIXTURE: over-mock anti-pattern — real behavior NOT verified
    const mockScorer = vi.fn().mockReturnValue(0); // return value is arbitrary
    const mockSink = vi.fn();

    runPipeline([1, 2, 3], mockScorer, mockSink);

    // Asserts wiring only — passes even if mockScorer produces garbage
    expect(mockScorer).toHaveBeenCalledWith([1, 2, 3]);
    // No assertion on what mockSink received or what the pipeline produced
  });
});

// ─── (b) CORRECT PATTERN: mocks infrastructure, asserts real behavior ────────
//
// `sink` is the infrastructure boundary (e.g. a logger or DB write).
// We mock it to avoid side effects, but the test still asserts the REAL
// computational output by calling the real `computeScore` implementation.
// This is NOT an over-mock violation — the interaction assertion is on
// infrastructure (sink), not on the unit under test (computeScore), and
// a behavioral assertion on the computed value is also present.

describe("runPipeline — CORRECT PATTERN (real behavior verified)", () => {
  it("computes the mean and delivers it to the sink", () => {
    const mockSink = vi.fn(); // infrastructure seam — OK to mock

    runPipeline([2, 4, 6], computeScore, mockSink); // real scorer, not mocked

    // Behavioral assertion: the pipeline produced the correct mean (4)
    expect(mockSink).toHaveBeenCalledWith(4);
    // This assertion is on the infrastructure output carrying real computed data,
    // so the test would FAIL if computeScore were broken — behavior is verified.
  });

  it("passes edge case: single-element array produces that element as score", () => {
    const mockSink = vi.fn();

    runPipeline([7], computeScore, mockSink);

    expect(mockSink).toHaveBeenCalledWith(7);
  });
});
