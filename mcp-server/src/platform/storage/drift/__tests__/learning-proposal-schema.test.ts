/**
 * LearningProposalSchema Tests
 *
 * Tests Zod schema validation for learning proposal frontmatter.
 * All tests use safeParse to match real usage at validation boundaries.
 */

import { describe, expect, test } from "vitest";
import { type LearningProposal, LearningProposalSchema } from "../learning-proposal-schema.ts";

describe("LearningProposalSchema — valid parsing", () => {
  test("parses a valid proposal with all fields", () => {
    const input = {
      confidence: 0.85,
      proposal_id: "prop_abc123",
      target: "deep-modules",
      type: "new-convention",
    };

    const result = LearningProposalSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const data: LearningProposal = result.data;
      expect(data.proposal_id).toBe("prop_abc123");
      expect(data.type).toBe("new-convention");
      expect(data.confidence).toBe(0.85);
      expect(data.target).toBe("deep-modules");
    }
  });

  test("accepts all five valid type values", () => {
    const validTypes = [
      "new-convention",
      "severity-change",
      "principle-revision",
      "convention-graduation",
      "stale-removal",
    ] as const;

    for (const type of validTypes) {
      const result = LearningProposalSchema.safeParse({
        confidence: 0.5,
        proposal_id: "prop_test",
        target: "some-principle",
        type,
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts confidence at boundary 0", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0,
      proposal_id: "prop_boundary_low",
      target: "old-principle",
      type: "stale-removal",
    });
    expect(result.success).toBe(true);
  });

  test("accepts confidence at boundary 1", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 1,
      proposal_id: "prop_boundary_high",
      target: "strong-principle",
      type: "severity-change",
    });
    expect(result.success).toBe(true);
  });

  test("strips extra fields (Zod default strip behavior)", () => {
    const result = LearningProposalSchema.safeParse({
      another: 42,
      confidence: 0.7,
      extra_field: "should be stripped",
      proposal_id: "prop_extra",
      target: "some-target",
      type: "new-convention",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra_field");
      expect(result.data).not.toHaveProperty("another");
    }
  });
});

describe("LearningProposalSchema — missing required fields", () => {
  test("fails when proposal_id is missing", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0.8,
      target: "some-target",
      type: "new-convention",
    });
    expect(result.success).toBe(false);
  });

  test("fails when type is missing", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0.8,
      proposal_id: "prop_123",
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is missing", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_123",
      target: "some-target",
      type: "new-convention",
    });
    expect(result.success).toBe(false);
  });

  test("fails when target is missing", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0.8,
      proposal_id: "prop_123",
      type: "new-convention",
    });
    expect(result.success).toBe(false);
  });

  test("fails when all fields are missing (empty object)", () => {
    const result = LearningProposalSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("LearningProposalSchema — invalid type value", () => {
  test("fails for an unrecognized type string", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0.5,
      proposal_id: "prop_bad_type",
      target: "some-target",
      type: "unknown-type",
    });
    expect(result.success).toBe(false);
  });

  test("fails for empty string type", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0.5,
      proposal_id: "prop_empty_type",
      target: "some-target",
      type: "",
    });
    expect(result.success).toBe(false);
  });

  test("fails for numeric type value", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 0.5,
      proposal_id: "prop_numeric_type",
      target: "some-target",
      type: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe("LearningProposalSchema — out-of-range confidence", () => {
  test("fails when confidence is below 0", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: -0.1,
      proposal_id: "prop_low",
      target: "some-target",
      type: "new-convention",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is above 1", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: 1.1,
      proposal_id: "prop_high",
      target: "some-target",
      type: "new-convention",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is a string", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: "high",
      proposal_id: "prop_str_conf",
      target: "some-target",
      type: "new-convention",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is null", () => {
    const result = LearningProposalSchema.safeParse({
      confidence: null,
      proposal_id: "prop_null_conf",
      target: "some-target",
      type: "principle-revision",
    });
    expect(result.success).toBe(false);
  });
});
