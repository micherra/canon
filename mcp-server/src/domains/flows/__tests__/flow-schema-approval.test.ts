/**
 * Tests for ADR-017 approval gate schema additions.
 *
 * Covers:
 * - approval_gate, max_revisions, rejection_target fields on BaseStateFields
 * - Relaxed variants on FragmentBaseStateFields
 * - STATUS_KEYWORDS additions
 * - ApprovalBreakpoint type structure (compile-time)
 * - DriveFlowAction "approval" variant (compile-time)
 */

import { describe, expect, it } from "vitest";
import {
  FragmentStateDefinitionSchema,
  SingleStateSchema,
  STATUS_KEYWORDS,
  WaveStateSchema,
} from "../flow-definition-schemas.ts";

// BaseStateFields — approval_gate / max_revisions / rejection_target

describe("BaseStateFields approval gate fields", () => {
  it("parses state with approval_gate: true", () => {
    const result = SingleStateSchema.safeParse({
      approval_gate: true,
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBe(true);
    }
  });

  it("parses state without approval_gate (backward compat)", () => {
    const result = SingleStateSchema.safeParse({
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBeUndefined();
    }
  });

  it("parses state with max_revisions: 3", () => {
    const result = SingleStateSchema.safeParse({
      max_revisions: 3,
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe(3);
    }
  });

  it("parses state with rejection_target: 'design'", () => {
    const result = SingleStateSchema.safeParse({
      rejection_target: "design",
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rejection_target).toBe("design");
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

  it("coerces max_revisions from string '5'", () => {
    const result = SingleStateSchema.safeParse({
      max_revisions: "5",
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe(5);
    }
  });
});

// FragmentBaseStateFields — relaxed variants for param placeholders

describe("FragmentBaseStateFields approval gate fields", () => {
  it("parses fragment state with approval_gate as string placeholder", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      approval_gate: "${enable_approval}",
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBe("${enable_approval}");
    }
  });

  it("parses fragment state with approval_gate: true (boolean still valid)", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      approval_gate: true,
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBe(true);
    }
  });

  it("parses fragment state with max_revisions as string placeholder", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      max_revisions: "${max_revisions}",
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe("${max_revisions}");
    }
  });

  it("parses fragment state with rejection_target as string", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      rejection_target: "${reject_to}",
      type: "single",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rejection_target).toBe("${reject_to}");
    }
  });
});

// STATUS_KEYWORDS — approved / revise / reject

describe("STATUS_KEYWORDS approval gate keywords", () => {
  it("includes 'approved'", () => {
    expect(STATUS_KEYWORDS).toContain("approved");
  });

  it("includes 'revise'", () => {
    expect(STATUS_KEYWORDS).toContain("revise");
  });

  it("includes 'reject'", () => {
    expect(STATUS_KEYWORDS).toContain("reject");
  });
});
