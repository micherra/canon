import { describe, it, expect } from "vitest";
import {
  deriveTier,
  computeConfidenceAnnotation,
  ConfidenceAnnotationSchema,
} from "../confidence.js";

describe("deriveTier", () => {
  it("returns 'insufficient' when sampleSize < 5 regardless of score", () => {
    expect(deriveTier(1.0, 0)).toBe("insufficient");
    expect(deriveTier(1.0, 4)).toBe("insufficient");
    expect(deriveTier(0.9, 3)).toBe("insufficient");
    expect(deriveTier(0.0, 1)).toBe("insufficient");
  });

  it("returns 'high' when score >= 0.7 and sampleSize >= 5", () => {
    expect(deriveTier(0.8, 10)).toBe("high");
    expect(deriveTier(1.0, 100)).toBe("high");
    expect(deriveTier(0.9, 5)).toBe("high");
  });

  it("returns 'medium' when score >= 0.4 and < 0.7 and sampleSize >= 5", () => {
    expect(deriveTier(0.5, 10)).toBe("medium");
    expect(deriveTier(0.6, 5)).toBe("medium");
    expect(deriveTier(0.45, 20)).toBe("medium");
  });

  it("returns 'low' when score < 0.4 and sampleSize >= 5", () => {
    expect(deriveTier(0.3, 10)).toBe("low");
    expect(deriveTier(0.0, 5)).toBe("low");
    expect(deriveTier(0.39, 50)).toBe("low");
  });

  it("boundary: score exactly 0.7 with sampleSize 5 returns 'high'", () => {
    expect(deriveTier(0.7, 5)).toBe("high");
  });

  it("boundary: score exactly 0.4 with sampleSize 5 returns 'medium'", () => {
    expect(deriveTier(0.4, 5)).toBe("medium");
  });

  it("boundary: sampleSize exactly 4 returns 'insufficient' even with score 1.0", () => {
    expect(deriveTier(1.0, 4)).toBe("insufficient");
  });
});

describe("computeConfidenceAnnotation", () => {
  it("with empty inputs returns { score: 0, tier: 'insufficient', basis: [], sample_size: 0 }", () => {
    const result = computeConfidenceAnnotation([]);
    expect(result).toEqual({
      score: 0,
      tier: "insufficient",
      basis: [],
      sample_size: 0,
    });
  });

  it("with single high-value input returns expected score and tier", () => {
    const result = computeConfidenceAnnotation([
      {
        signal: "test_signal",
        value: 0.9,
        weight: 1.0,
        detail: "high confidence",
        sample_size: 10,
      },
    ]);
    expect(result.score).toBeCloseTo(0.9);
    expect(result.tier).toBe("high");
    expect(result.sample_size).toBe(10);
  });

  it("with mixed inputs computes correct weighted average", () => {
    const result = computeConfidenceAnnotation([
      {
        signal: "signal_a",
        value: 0.8,
        weight: 0.6,
        detail: "detail a",
        sample_size: 20,
      },
      {
        signal: "signal_b",
        value: 0.2,
        weight: 0.4,
        detail: "detail b",
        sample_size: 10,
      },
    ]);
    // weighted average: (0.8 * 0.6 + 0.2 * 0.4) / (0.6 + 0.4) = (0.48 + 0.08) / 1.0 = 0.56
    expect(result.score).toBeCloseTo(0.56);
    expect(result.tier).toBe("medium");
  });

  it("normalizes basis weights to sum to ~1", () => {
    const result = computeConfidenceAnnotation([
      {
        signal: "a",
        value: 0.8,
        weight: 0.3,
        detail: "d",
        sample_size: 10,
      },
      {
        signal: "b",
        value: 0.6,
        weight: 0.7,
        detail: "e",
        sample_size: 10,
      },
    ]);
    const weightSum = result.basis.reduce((sum, b) => sum + b.weight, 0);
    expect(weightSum).toBeCloseTo(1.0);
  });

  it("uses minimum sample_size across inputs", () => {
    const result = computeConfidenceAnnotation([
      {
        signal: "a",
        value: 0.9,
        weight: 1.0,
        detail: "large sample",
        sample_size: 100,
      },
      {
        signal: "b",
        value: 0.8,
        weight: 1.0,
        detail: "small sample",
        sample_size: 3,
      },
    ]);
    expect(result.sample_size).toBe(3);
    // sample_size 3 < 5, so tier should be insufficient
    expect(result.tier).toBe("insufficient");
  });

  it("clamps score to [0, 1]", () => {
    // Degenerate case: all weights zero means score = 0
    const result = computeConfidenceAnnotation([
      {
        signal: "a",
        value: 0.5,
        weight: 0,
        detail: "zero weight",
        sample_size: 10,
      },
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("ConfidenceAnnotationSchema", () => {
  it("validates a well-formed annotation", () => {
    const annotation = {
      score: 0.75,
      tier: "high" as const,
      basis: [{ signal: "test", weight: 1.0, detail: "test detail" }],
      sample_size: 10,
    };
    const result = ConfidenceAnnotationSchema.safeParse(annotation);
    expect(result.success).toBe(true);
  });

  it("rejects score outside [0, 1]", () => {
    const tooHigh = {
      score: 1.5,
      tier: "high",
      basis: [],
      sample_size: 10,
    };
    expect(ConfidenceAnnotationSchema.safeParse(tooHigh).success).toBe(false);

    const tooLow = {
      score: -0.1,
      tier: "low",
      basis: [],
      sample_size: 10,
    };
    expect(ConfidenceAnnotationSchema.safeParse(tooLow).success).toBe(false);
  });
});
