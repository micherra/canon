/**
 * Tests for watch-staleness-adapter.ts
 *
 * Validates the single-signal staleness decay confidence scoring for learner
 * watch items:
 * - Fresh watch (0 days since last instance) → high confidence.
 * - Mid staleness (half saturation) → medium or low confidence.
 * - At/beyond saturation → score floors at 0 (low, not insufficient when
 *   confirming_instances ≥ 5).
 * - Non-finite / negative days → fully stale (conservative, trust-boundary rule).
 * - confirming_instances drives sample_size and therefore tier behaviour.
 * - Single shared engine, no bespoke decay math.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeWatchConfidence } from "../watch-staleness-adapter.ts";

const SATURATION = 30; // must match the constant in the adapter

describe("computeWatchConfidence", () => {
  describe("freshness gradient", () => {
    it("0 days with enough instances → tier high, score >= 0.7", () => {
      const result = computeWatchConfidence({
        watch_id: "w1",
        days_since_last_instance: 0,
        confirming_instances: 10,
      });
      expect(result.tier).toBe("high");
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });

    it("mid staleness (half saturation, 15 days) → medium or low tier", () => {
      const result = computeWatchConfidence({
        watch_id: "w2",
        days_since_last_instance: 15,
        confirming_instances: 10,
      });
      // value = 1 - 15/30 = 0.5 → medium tier (0.4 ≤ score < 0.7)
      expect(result.score).toBeGreaterThanOrEqual(0.4);
      expect(result.score).toBeLessThan(0.7);
      expect(result.tier).toBe("medium");
    });

    it("at saturation (30 days) → score 0, tier low (not insufficient) when instances ≥ 5", () => {
      const result = computeWatchConfidence({
        watch_id: "w3",
        days_since_last_instance: SATURATION,
        confirming_instances: 10,
      });
      expect(result.score).toBe(0);
      expect(result.tier).toBe("low");
      expect(result.tier).not.toBe("insufficient");
    });

    it("beyond saturation (60 days) → score 0, tier low when instances ≥ 5", () => {
      const result = computeWatchConfidence({
        watch_id: "w4",
        days_since_last_instance: 60,
        confirming_instances: 10,
      });
      expect(result.score).toBe(0);
      expect(result.tier).toBe("low");
    });

    it("score is monotonically decreasing with days_since_last_instance", () => {
      const fresh = computeWatchConfidence({
        watch_id: "w",
        days_since_last_instance: 0,
        confirming_instances: 10,
      });
      const mid = computeWatchConfidence({
        watch_id: "w",
        days_since_last_instance: 15,
        confirming_instances: 10,
      });
      const stale = computeWatchConfidence({
        watch_id: "w",
        days_since_last_instance: 30,
        confirming_instances: 10,
      });
      expect(fresh.score).toBeGreaterThan(mid.score);
      expect(mid.score).toBeGreaterThan(stale.score);
    });
  });

  describe("trust-boundary handling (non-finite / negative days)", () => {
    it("NaN days → treated as fully stale (conservative), tier low with enough instances", () => {
      const result = computeWatchConfidence({
        watch_id: "w5",
        days_since_last_instance: Number.NaN,
        confirming_instances: 10,
      });
      expect(result.score).toBe(0);
      expect(result.tier).toBe("low");
    });

    it("Infinity days → fully stale", () => {
      const result = computeWatchConfidence({
        watch_id: "w6",
        days_since_last_instance: Number.POSITIVE_INFINITY,
        confirming_instances: 10,
      });
      expect(result.score).toBe(0);
      expect(result.tier).toBe("low");
    });

    it("negative days → fully stale (conservative sentinel handling)", () => {
      const result = computeWatchConfidence({
        watch_id: "w7",
        days_since_last_instance: -5,
        confirming_instances: 10,
      });
      expect(result.score).toBe(0);
      expect(result.tier).toBe("low");
    });
  });

  describe("confirming_instances drives sample_size and tier", () => {
    it("0 confirming instances → tier insufficient (no evidence base)", () => {
      const result = computeWatchConfidence({
        watch_id: "w8",
        days_since_last_instance: 0,
        confirming_instances: 0,
      });
      // sample_size < 5 → insufficient regardless of value
      expect(result.tier).toBe("insufficient");
    });

    it("1 confirming instance → insufficient (below sample floor)", () => {
      const result = computeWatchConfidence({
        watch_id: "w9",
        days_since_last_instance: 0,
        confirming_instances: 1,
      });
      expect(result.tier).toBe("insufficient");
    });

    it("5 confirming instances → not insufficient (at sample floor boundary)", () => {
      const result = computeWatchConfidence({
        watch_id: "w10",
        days_since_last_instance: 0,
        confirming_instances: 5,
      });
      expect(result.tier).not.toBe("insufficient");
    });

    it("many confirming instances with 0 days → still high tier", () => {
      const result = computeWatchConfidence({
        watch_id: "w11",
        days_since_last_instance: 0,
        confirming_instances: 50,
      });
      expect(result.tier).toBe("high");
    });

    it("non-finite confirming_instances falls back to 0 (insufficient)", () => {
      const result = computeWatchConfidence({
        watch_id: "w12",
        days_since_last_instance: 0,
        confirming_instances: Number.NaN,
      });
      expect(result.tier).toBe("insufficient");
    });
  });

  describe("signal shape", () => {
    it("uses a single staleness signal (no auxiliary decay signals)", () => {
      const result = computeWatchConfidence({
        watch_id: "w13",
        days_since_last_instance: 0,
        confirming_instances: 10,
      });
      const signals = result.basis.map((b) => b.signal);
      expect(signals).toEqual(["staleness"]);
    });
  });

  // AC4 — import-shape assertion: the adapter MUST reuse the shared engine
  // (computeConfidenceAnnotation), never a bespoke decay function.
  it("reuses computeConfidenceAnnotation from the shared kernel (no second decay engine)", () => {
    const source = readFileSync(join(__dirname, "..", "watch-staleness-adapter.ts"), "utf-8");
    expect(source).toContain("computeConfidenceAnnotation");
    expect(source).toContain("@shared/lib/confidence.ts");
    // No parallel decay implementation beyond the value→days mapping.
    expect(source).not.toMatch(/Math\.exp/);
    expect(source).not.toMatch(/Math\.pow/);
    // No second loop or accumulator-based decay.
    expect(source).not.toMatch(/reduce.*score/);
  });
});
