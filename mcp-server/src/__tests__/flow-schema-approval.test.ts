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

import { describe, it, expect } from "vitest";
import {
  SingleStateSchema,
  WaveStateSchema,
  FragmentStateDefinitionSchema,
  STATUS_KEYWORDS,
} from "../orchestration/flow-schema.ts";
import type { ApprovalBreakpoint, DriveFlowAction } from "../orchestration/drive-flow-types.ts";

// ---------------------------------------------------------------------------
// BaseStateFields — approval_gate / max_revisions / rejection_target
// ---------------------------------------------------------------------------

describe("BaseStateFields approval gate fields", () => {
  it("parses state with approval_gate: true", () => {
    const result = SingleStateSchema.safeParse({
      type: "single",
      approval_gate: true,
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
      type: "single",
      max_revisions: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe(3);
    }
  });

  it("parses state with rejection_target: 'design'", () => {
    const result = SingleStateSchema.safeParse({
      type: "single",
      rejection_target: "design",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rejection_target).toBe("design");
    }
  });

  it("parses wave state with all approval gate fields", () => {
    const result = WaveStateSchema.safeParse({
      type: "wave",
      approval_gate: true,
      max_revisions: 2,
      rejection_target: "research",
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
      type: "single",
      max_revisions: "5",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// FragmentBaseStateFields — relaxed variants for param placeholders
// ---------------------------------------------------------------------------

describe("FragmentBaseStateFields approval gate fields", () => {
  it("parses fragment state with approval_gate as string placeholder", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      type: "single",
      approval_gate: "${enable_approval}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBe("${enable_approval}");
    }
  });

  it("parses fragment state with approval_gate: true (boolean still valid)", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      type: "single",
      approval_gate: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approval_gate).toBe(true);
    }
  });

  it("parses fragment state with max_revisions as string placeholder", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      type: "single",
      max_revisions: "${max_revisions}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe("${max_revisions}");
    }
  });

  it("parses fragment state with rejection_target as string", () => {
    const result = FragmentStateDefinitionSchema.safeParse({
      type: "single",
      rejection_target: "${reject_to}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rejection_target).toBe("${reject_to}");
    }
  });
});

// ---------------------------------------------------------------------------
// STATUS_KEYWORDS — approved / revise / reject
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ApprovalBreakpoint type — compile-time structural check
// ---------------------------------------------------------------------------

describe("ApprovalBreakpoint interface", () => {
  it("accepts a structurally correct ApprovalBreakpoint value", () => {
    // This is a compile-time check — if the type is wrong, TS will error at build time.
    const breakpoint: ApprovalBreakpoint = {
      state_id: "implement",
      agent_type: "canon:canon-implementor",
      artifacts: ["/workspace/plans/task-01-SUMMARY.md"],
      summary: "Implemented approval gate schema fields",
      options: ["approved", "revise", "reject"],
    };
    expect(breakpoint.state_id).toBe("implement");
    expect(breakpoint.options).toEqual(["approved", "revise", "reject"]);
  });
});

// ---------------------------------------------------------------------------
// DriveFlowAction "approval" variant — compile-time structural check
// ---------------------------------------------------------------------------

describe("DriveFlowAction approval variant", () => {
  it("accepts an 'approval' action with ApprovalBreakpoint", () => {
    const action: DriveFlowAction = {
      action: "approval",
      breakpoint: {
        state_id: "design",
        agent_type: "canon:canon-architect",
        artifacts: [],
        summary: "Design complete",
        options: ["approved", "revise", "reject"],
      },
    };
    expect(action.action).toBe("approval");
  });

  it("existing 'spawn' variant still compiles", () => {
    const action: DriveFlowAction = {
      action: "spawn",
      requests: [],
    };
    expect(action.action).toBe("spawn");
  });

  it("existing 'hitl' variant still compiles", () => {
    const action: DriveFlowAction = {
      action: "hitl",
      breakpoint: { reason: "needs input", context: "some context" },
    };
    expect(action.action).toBe("hitl");
  });

  it("existing 'done' variant still compiles", () => {
    const action: DriveFlowAction = {
      action: "done",
      terminal_state: "complete",
      summary: "All done",
    };
    expect(action.action).toBe("done");
  });
});
