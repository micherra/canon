/**
 * Tests for the ReviewViolation message field (schema-violation-message)
 *
 * Verifies backward compatibility: violations without message still parse,
 * and violations with message are accepted and typed correctly.
 */

import { describe, expect, it } from "vitest";
import { reportInputSchema } from "../shared/schema.ts";

// Shared test data

const baseReviewInput = {
  files: ["src/index.ts", "src/utils/config.ts"],
  honored: ["functions-do-one-thing", "deep-modules"],
  score: {
    conventions: { passed: 1, total: 1 },
    opinions: { passed: 2, total: 2 },
    rules: { passed: 3, total: 3 },
  },
  type: "review" as const,
  verdict: "CLEAN" as const,
};

describe("reportInputSchema — review violations with message field", () => {
  it("accepts a violation WITH message field", () => {
    const input = {
      ...baseReviewInput,
      violations: [
        {
          file_path: "src/index.ts",
          impact_score: 42,
          message: "Function does multiple things: parses and stores",
          principle_id: "functions-do-one-thing",
          severity: "strong-opinion",
        },
      ],
    };

    const result = reportInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "review") {
      const violation = result.data.violations[0];
      expect(violation.message).toBe("Function does multiple things: parses and stores");
    }
  });

  it("accepts a violation WITHOUT message field (backward compat)", () => {
    const input = {
      ...baseReviewInput,
      violations: [
        {
          file_path: "src/tools/store-pr-review.ts",
          impact_score: 10,
          principle_id: "validate-at-trust-boundaries",
          severity: "rule",
          // message intentionally omitted
        },
      ],
    };

    const result = reportInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "review") {
      const violation = result.data.violations[0];
      expect(violation.message).toBeUndefined();
    }
  });

  it("accepts violations array with mixed message presence", () => {
    const input = {
      ...baseReviewInput,
      violations: [
        {
          message: "Has message",
          principle_id: "functions-do-one-thing",
          severity: "strong-opinion",
        },
        {
          principle_id: "validate-at-trust-boundaries",
          severity: "rule",
          // no message
        },
      ],
    };

    const result = reportInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "review") {
      expect(result.data.violations[0].message).toBe("Has message");
      expect(result.data.violations[1].message).toBeUndefined();
    }
  });

  it("accepts empty violations array (backward compat) and produces valid parsed structure", () => {
    const input = {
      ...baseReviewInput,
      violations: [],
    };

    const result = reportInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "review") {
      expect(result.data.violations).toEqual([]);
      expect(result.data.files).toEqual(["src/index.ts", "src/utils/config.ts"]);
      expect(result.data.verdict).toBe("CLEAN");
      expect(result.data.score.rules.passed).toBe(3);
    }
  });

  it("rejects non-string message field", () => {
    const input = {
      ...baseReviewInput,
      violations: [
        {
          message: 42, // should be string
          principle_id: "functions-do-one-thing",
          severity: "strong-opinion",
        },
      ],
    };

    const result = reportInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
