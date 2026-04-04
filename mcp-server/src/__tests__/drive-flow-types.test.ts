/**
 * drive-flow-types — Zod schema validation tests
 *
 * Tests that DriveFlowInput Zod schema accepts valid inputs and rejects invalid ones.
 */

import { describe, expect, test } from "vitest";
import type {
  DriveFlowAction,
  HitlBreakpoint,
  SpawnRequest,
} from "../orchestration/drive-flow-types.ts";
import { DriveFlowInputSchema } from "../orchestration/drive-flow-types.ts";

// Minimal ResolvedFlow for testing
const MINIMAL_FLOW = {
  description: "test",
  entry: "start",
  name: "test-flow",
  spawn_instructions: { start: "Do the thing" },
  states: {
    end: { type: "terminal" as const },
    start: { agent: "agent-a", transitions: { done: "end" }, type: "single" as const },
  },
};

describe("DriveFlowInputSchema", () => {
  test("accepts valid minimal input (workspace + flow only)", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
      workspace: "/some/workspace",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid input with result", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
      result: {
        agent_session_id: "sess_abc123",
        artifacts: ["path/to/file.ts"],
        state_id: "start",
        status: "done",
      },
      workspace: "/some/workspace",
    });
    expect(result.success).toBe(true);
  });

  test("accepts result with parallel_results", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
      result: {
        parallel_results: [
          { artifacts: ["file.ts"], item: "task-01", status: "done" },
          { item: "task-02", status: "done_with_concerns" },
        ],
        state_id: "start",
        status: "done",
      },
      workspace: "/some/workspace",
    });
    expect(result.success).toBe(true);
  });

  test("accepts result with metrics", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
      result: {
        metrics: { tool_calls: 10, turns: 5 },
        state_id: "start",
        status: "done",
      },
      workspace: "/some/workspace",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing workspace", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing flow", () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: "/some/workspace",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty string workspace", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
      workspace: "",
    });
    expect(result.success).toBe(false);
  });

  test("result is optional (omitting it is valid)", () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
      workspace: "/workspace",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toBeUndefined();
    }
  });
});

describe("DriveFlowAction discriminated union types", () => {
  test("spawn action has correct shape", () => {
    const action: DriveFlowAction = {
      action: "spawn",
      requests: [
        {
          agent_type: "canon:canon-implementor",
          isolation: "worktree",
          prompt: "Implement the feature",
          task_id: "task-01",
        },
      ],
    };
    expect(action.action).toBe("spawn");
    expect(action.requests).toHaveLength(1);
  });

  test("hitl action has correct shape", () => {
    const action: DriveFlowAction = {
      action: "hitl",
      breakpoint: {
        context: "The PR has conflicts that need manual resolution",
        options: ["merge", "rebase", "abort"],
        reason: "Needs human decision",
      },
    };
    expect(action.action).toBe("hitl");
    expect(action.breakpoint.options).toHaveLength(3);
  });

  test("done action has correct shape", () => {
    const action: DriveFlowAction = {
      action: "done",
      summary: "All tasks completed successfully",
      terminal_state: "complete",
    };
    expect(action.action).toBe("done");
    expect(action.terminal_state).toBe("complete");
  });

  test("SpawnRequest supports continue_from", () => {
    const request: SpawnRequest = {
      agent_type: "canon:canon-fixer",
      continue_from: {
        agent_id: "agent-123",
        context_summary: "Previously fixed 3/5 test failures",
      },
      isolation: "none",
      prompt: "Fix the test failures",
    };
    expect(request.continue_from?.agent_id).toBe("agent-123");
  });

  test("HitlBreakpoint options field is optional", () => {
    const bp: HitlBreakpoint = {
      context: "Some context here",
      reason: "Need input",
    };
    expect(bp.options).toBeUndefined();
  });
});
