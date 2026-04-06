/**
 * Tests for allowed_insertions field on FlowDefinitionSchema (ADR-012 / fe-01)
 *
 * Covers:
 * - Field is optional (absent → undefined, not [])
 * - Explicit empty array is accepted
 * - Array of state IDs is accepted and round-trips
 * - Non-array value is rejected
 * - Non-string array elements are rejected
 * - FlowDefinition type includes allowed_insertions
 */

import { describe, expect, it } from "vitest";
import { FlowDefinitionSchema } from "../flow-schema.ts";

const MINIMAL_FLOW = {
  description: "test flow",
  name: "test",
  states: {
    done: { type: "terminal" },
  },
};

describe("FlowDefinitionSchema — allowed_insertions", () => {
  it("is optional — absent field produces undefined", () => {
    const result = FlowDefinitionSchema.parse(MINIMAL_FLOW);
    expect(result.allowed_insertions).toBeUndefined();
  });

  it("accepts explicit empty array", () => {
    const result = FlowDefinitionSchema.parse({ ...MINIMAL_FLOW, allowed_insertions: [] });
    expect(result.allowed_insertions).toEqual([]);
  });

  it("accepts an array of state ID strings", () => {
    const result = FlowDefinitionSchema.parse({
      ...MINIMAL_FLOW,
      allowed_insertions: ["hotfix", "patch-review"],
    });
    expect(result.allowed_insertions).toEqual(["hotfix", "patch-review"]);
  });

  it("rejects a non-array value (string)", () => {
    expect(() =>
      FlowDefinitionSchema.parse({ ...MINIMAL_FLOW, allowed_insertions: "hotfix" }),
    ).toThrow();
  });

  it("rejects an array containing non-string elements", () => {
    expect(() =>
      FlowDefinitionSchema.parse({ ...MINIMAL_FLOW, allowed_insertions: [42] }),
    ).toThrow();
  });
});
