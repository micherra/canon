import { describe, expect, it } from "vitest";
import {
  FragmentStateDefinitionSchema,
  SingleStateSchema,
  STATUS_KEYWORDS,
  WaveStateSchema,
} from "../flow-definition-schemas.ts";

describe("BaseStateFields approval gate fields", () => {
  it.each([
    {
      desc: "approval_gate: true",
      expected: true,
      field: "approval_gate",
      input: { approval_gate: true, type: "single" },
    },
    {
      desc: "approval_gate absent (backward compat)",
      expected: undefined,
      field: "approval_gate",
      input: { type: "single" },
    },
    {
      desc: "max_revisions: 3",
      expected: 3,
      field: "max_revisions",
      input: { max_revisions: 3, type: "single" },
    },
    {
      desc: "max_revisions coerced from string '5'",
      expected: 5,
      field: "max_revisions",
      input: { max_revisions: "5", type: "single" },
    },
    {
      desc: "rejection_target: 'design'",
      expected: "design",
      field: "rejection_target",
      input: { rejection_target: "design", type: "single" },
    },
  ])("parses SingleState with $desc", ({ expected, field, input }) => {
    const result = SingleStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[field as keyof typeof result.data]).toBe(expected);
    }
  });

  it("parses wave state with all approval gate fields", () => {
    const result = WaveStateSchema.safeParse({
      approval_gate: true,
      max_revisions: 2,
      rejection_target: "research",
      type: "wave",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBe(true);
      expect(result.data.max_revisions).toBe(2);
      expect(result.data.rejection_target).toBe("research");
    }
  });
});

describe("FragmentBaseStateFields approval gate fields", () => {
  it.each([
    {
      desc: "approval_gate as string placeholder",
      expected: "${enable_approval}",
      field: "approval_gate",
      input: { approval_gate: "${enable_approval}", type: "single" },
    },
    {
      desc: "approval_gate: true (boolean still valid)",
      expected: true,
      field: "approval_gate",
      input: { approval_gate: true, type: "single" },
    },
    {
      desc: "max_revisions as string placeholder",
      expected: "${max_revisions}",
      field: "max_revisions",
      input: { max_revisions: "${max_revisions}", type: "single" },
    },
    {
      desc: "rejection_target as string placeholder",
      expected: "${reject_to}",
      field: "rejection_target",
      input: { rejection_target: "${reject_to}", type: "single" },
    },
  ])("parses fragment state with $desc", ({ expected, field, input }) => {
    const result = FragmentStateDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[field as keyof typeof result.data]).toBe(expected);
    }
  });
});

describe("STATUS_KEYWORDS approval gate keywords", () => {
  it.each(["approved", "revise", "reject"])("includes '%s'", (keyword) => {
    expect(STATUS_KEYWORDS).toContain(keyword);
  });
});
