/**
 * LearningProposalSchema Tests
 *
 * Tests Zod schema validation for learning proposal frontmatter.
 * All tests use safeParse to match real usage at validation boundaries.
 */

import { describe, expect, test } from "vitest";
import {
  LearningProposalSchema,
  type LearningProposal,
} from "../learning-proposal-schema.ts";

describe("LearningProposalSchema — valid parsing", () => {
  test("parses a valid proposal with all fields", () => {
    const input = {
      proposal_id: "prop_abc123",
      type: "new-convention",
      confidence: 0.85,
      target: "deep-modules",
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
        proposal_id: "prop_test",
        type,
        confidence: 0.5,
        target: "some-principle",
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts confidence at boundary 0", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_boundary_low",
      type: "stale-removal",
      confidence: 0,
      target: "old-principle",
    });
    expect(result.success).toBe(true);
  });

  test("accepts confidence at boundary 1", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_boundary_high",
      type: "severity-change",
      confidence: 1,
      target: "strong-principle",
    });
    expect(result.success).toBe(true);
  });

  test("strips extra fields (Zod default strip behavior)", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_extra",
      type: "new-convention",
      confidence: 0.7,
      target: "some-target",
      extra_field: "should be stripped",
      another: 42,
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
      type: "new-convention",
      confidence: 0.8,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when type is missing", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_123",
      confidence: 0.8,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is missing", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_123",
      type: "new-convention",
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when target is missing", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_123",
      type: "new-convention",
      confidence: 0.8,
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
      proposal_id: "prop_bad_type",
      type: "unknown-type",
      confidence: 0.5,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails for empty string type", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_empty_type",
      type: "",
      confidence: 0.5,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails for numeric type value", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_numeric_type",
      type: 42,
      confidence: 0.5,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });
});

describe("LearningProposalSchema — out-of-range confidence", () => {
  test("fails when confidence is below 0", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_low",
      type: "new-convention",
      confidence: -0.1,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is above 1", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_high",
      type: "new-convention",
      confidence: 1.1,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is a string", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_str_conf",
      type: "new-convention",
      confidence: "high",
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });

  test("fails when confidence is null", () => {
    const result = LearningProposalSchema.safeParse({
      proposal_id: "prop_null_conf",
      type: "principle-revision",
      confidence: null,
      target: "some-target",
    });
    expect(result.success).toBe(false);
  });
});
