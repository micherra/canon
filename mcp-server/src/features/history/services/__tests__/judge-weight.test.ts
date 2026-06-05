/**
 * judge-weight tests — pure outcome→promotion-weight function.
 *
 * TDD: these tests are written to drive the implementation in judge-weight.ts.
 * All tests operate on the exported pure function; no I/O.
 */

import { describe, expect, test } from "vitest";
import {
  computeOutcomeWeight,
  NEUTRAL_WEIGHT,
  WEIGHT_CEIL,
  WEIGHT_FLOOR,
} from "../judge-weight.ts";

// ---- AC#1: verdict × fix_iterations × test_pass_rate → weight near 1.0 ----

describe("computeOutcomeWeight — verdict sub-weight", () => {
  test("CLEAN verdict with 0 fixes and full pass-rate → weight > 1.0 and ≤ WEIGHT_CEIL", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 0,
      review_verdict: "CLEAN",
      test_pass_rate: 1.0,
    });
    expect(w).toBeGreaterThan(1.0);
    expect(w).toBeLessThanOrEqual(WEIGHT_CEIL);
  });

  test("approve verdict (alias for clean) → weight > 1.0", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 0,
      review_verdict: "approve",
      test_pass_rate: 1.0,
    });
    expect(w).toBeGreaterThan(1.0);
  });

  test("BLOCKING verdict with high fix_iterations and low pass-rate → weight < 1.0 and ≥ WEIGHT_FLOOR", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 5,
      review_verdict: "BLOCKING",
      test_pass_rate: 0.2,
    });
    expect(w).toBeLessThan(1.0);
    expect(w).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
  });

  test("WARNING with neutral fix_iterations and neutral pass-rate → weight ≈ NEUTRAL_WEIGHT", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 1,
      review_verdict: "WARNING",
      test_pass_rate: 0.8,
    });
    // Should be close to neutral — within 15%
    expect(w).toBeGreaterThan(0.7);
    expect(w).toBeLessThan(1.3);
  });

  test("case-insensitive verdict normalization — 'clean' (lowercase) → weight > 1.0", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 0,
      review_verdict: "clean",
      test_pass_rate: 1.0,
    });
    expect(w).toBeGreaterThan(1.0);
  });

  test("mixed-case verdict 'Clean' → weight > 1.0", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 0,
      review_verdict: "Clean",
      test_pass_rate: 1.0,
    });
    expect(w).toBeGreaterThan(1.0);
  });

  test("unknown verdict string → neutral sub-weight; overall weight depends only on other signals", () => {
    // With all signals neutral, unknown verdict → result near NEUTRAL_WEIGHT
    const w = computeOutcomeWeight({ fix_iterations: 0, review_verdict: "bogus-verdict" });
    expect(w).toBeCloseTo(NEUTRAL_WEIGHT, 1);
  });
});

describe("computeOutcomeWeight — fix_iterations sub-weight", () => {
  test("0 fix_iterations → sub-weight ≥ 1.0 (no penalty)", () => {
    const wZero = computeOutcomeWeight({ fix_iterations: 0, review_verdict: "CLEAN" });
    const wNull = computeOutcomeWeight({ review_verdict: "CLEAN" });
    // Both should be the same since 0 iterations = no penalty
    expect(wZero).toBeGreaterThanOrEqual(1.0);
    expect(wNull).toBeGreaterThanOrEqual(1.0);
  });

  test("1 fix_iteration → slight penalty; weight still ≥ WEIGHT_FLOOR", () => {
    const w = computeOutcomeWeight({ fix_iterations: 1, review_verdict: "WARNING" });
    expect(w).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
  });

  test("large fix_iterations (10) → weight approaches WEIGHT_FLOOR", () => {
    const wLarge = computeOutcomeWeight({ fix_iterations: 10, review_verdict: "BLOCKING" });
    const wSmall = computeOutcomeWeight({ fix_iterations: 1, review_verdict: "BLOCKING" });
    // More fix iterations → lower weight
    expect(wLarge).toBeLessThanOrEqual(wSmall);
    expect(wLarge).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
  });

  test("negative fix_iterations → treated as 0, no throw", () => {
    expect(() => computeOutcomeWeight({ fix_iterations: -1 })).not.toThrow();
    const w = computeOutcomeWeight({ fix_iterations: -1 });
    expect(w).toBeCloseTo(NEUTRAL_WEIGHT, 1);
  });
});

describe("computeOutcomeWeight — test_pass_rate sub-weight", () => {
  test("pass_rate 1.0 → sub-weight ≥ 1.0", () => {
    const w = computeOutcomeWeight({ review_verdict: "CLEAN", test_pass_rate: 1.0 });
    expect(w).toBeGreaterThan(1.0);
  });

  test("pass_rate 0.0 → sub-weight < 1.0", () => {
    const w = computeOutcomeWeight({ review_verdict: "BLOCKING", test_pass_rate: 0.0 });
    expect(w).toBeLessThan(1.0);
  });

  test("pass_rate > 1.0 (invalid) → treated as clamped/neutral, no throw", () => {
    expect(() => computeOutcomeWeight({ test_pass_rate: 1.5 })).not.toThrow();
    const w = computeOutcomeWeight({ test_pass_rate: 1.5 });
    expect(w).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
    expect(w).toBeLessThanOrEqual(WEIGHT_CEIL);
  });
});

// ---- AC#3: fail-safe — missing/partial signals → NEUTRAL_WEIGHT ----

describe("computeOutcomeWeight — AC#3 fail-safe: absent signals", () => {
  test("review_verdict absent → neutral sub-weight (no penalty)", () => {
    const w = computeOutcomeWeight({ fix_iterations: 0, test_pass_rate: 1.0 });
    // Without verdict signal, verdict sub-weight = 1.0; weight from other signals
    expect(w).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
    expect(w).toBeLessThanOrEqual(WEIGHT_CEIL);
  });

  test("fix_iterations absent → neutral sub-weight (no penalty)", () => {
    const w = computeOutcomeWeight({ review_verdict: "CLEAN", test_pass_rate: 1.0 });
    expect(w).toBeGreaterThan(1.0); // clean verdict + good pass rate → > 1.0
  });

  test("test_pass_rate absent → neutral sub-weight (no penalty)", () => {
    const w = computeOutcomeWeight({ fix_iterations: 0, review_verdict: "CLEAN" });
    expect(w).toBeGreaterThan(1.0); // clean + 0 fixes → > 1.0
  });

  test("ALL signals absent → exactly NEUTRAL_WEIGHT (1.0)", () => {
    const w = computeOutcomeWeight({});
    expect(w).toBe(NEUTRAL_WEIGHT);
  });

  test("NaN test_pass_rate → treated as absent (neutral), no throw", () => {
    expect(() => computeOutcomeWeight({ test_pass_rate: NaN })).not.toThrow();
    const w = computeOutcomeWeight({ test_pass_rate: NaN });
    expect(w).toBeCloseTo(NEUTRAL_WEIGHT, 1);
  });

  test("NaN fix_iterations → treated as absent (neutral), no throw", () => {
    expect(() => computeOutcomeWeight({ fix_iterations: NaN })).not.toThrow();
    const w = computeOutcomeWeight({ fix_iterations: NaN });
    expect(w).toBeCloseTo(NEUTRAL_WEIGHT, 1);
  });

  test("Infinity fix_iterations → treated as absent or max-penalty, no throw", () => {
    expect(() => computeOutcomeWeight({ fix_iterations: Infinity })).not.toThrow();
    const w = computeOutcomeWeight({ fix_iterations: Infinity });
    expect(w).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
    expect(w).toBeLessThanOrEqual(WEIGHT_CEIL);
  });
});

// ---- Clamp behavior ----

describe("computeOutcomeWeight — clamp to [WEIGHT_FLOOR, WEIGHT_CEIL]", () => {
  test("maximally-good signals → weight ≤ WEIGHT_CEIL", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 0,
      review_verdict: "CLEAN",
      test_pass_rate: 1.0,
    });
    expect(w).toBeLessThanOrEqual(WEIGHT_CEIL);
  });

  test("maximally-bad signals → weight ≥ WEIGHT_FLOOR", () => {
    const w = computeOutcomeWeight({
      fix_iterations: 100,
      review_verdict: "BLOCKING",
      test_pass_rate: 0.0,
    });
    expect(w).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
  });

  test("WEIGHT_FLOOR is a non-zero positive value (never zero)", () => {
    expect(WEIGHT_FLOOR).toBeGreaterThan(0);
  });
});
