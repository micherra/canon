/**
 * Integration tests for the 3 new bounded-context schema files introduced in ddd-01.
 *
 * The completeness test (schema-split-completeness.test.ts) verifies that all exports
 * exist. These tests verify the CONTRACT of the new files:
 *   - schemas parse valid inputs correctly
 *   - schemas reject invalid inputs
 *   - BaseStateFields is usable as a plain-object spread (not a Zod schema instance)
 *   - Cross-file imports (board-state-schemas → flow-definition-schemas) produce
 *     correct parse behaviour for fields that cross the boundary
 *
 * All imports target the new files directly — not the legacy flow-schema.ts.
 */

import { describe, expect, it } from "vitest";

// --- flow-definition-schemas.ts imports ----------------------------------------
import {
  BaseStateFields,
  DiscoveredGateSchema,
  FlowDefinitionSchema,
  FragmentBaseStateFields,
  GateResultSchema,
  RequiredArtifactSchema,
  SingleStateSchema,
  STATUS_ALIASES,
  STATUS_KEYWORDS,
} from "../flow-definition-schemas.ts";

// --- board-state-schemas.ts imports --------------------------------------------
import {
  AgentMetricsSchema,
  BoardSchema,
  BoardStateEntrySchema,
  SessionSchema,
  WorktreeEntrySchema,
} from "../board-state-schemas.ts";

// --- event-schemas.ts imports --------------------------------------------------
import { TranscriptEntrySchema } from "../event-schemas.ts";

// =============================================================================
// flow-definition-schemas.ts
// =============================================================================

describe("flow-definition-schemas.ts — STATUS_KEYWORDS / STATUS_ALIASES", () => {
  it("STATUS_KEYWORDS is a non-empty tuple", () => {
    expect(STATUS_KEYWORDS.length).toBeGreaterThan(0);
    expect(STATUS_KEYWORDS).toContain("done");
    expect(STATUS_KEYWORDS).toContain("blocked");
    expect(STATUS_KEYWORDS).toContain("all_passing");
    expect(STATUS_KEYWORDS).toContain("implementation_issue");
  });

  it("STATUS_ALIASES maps known aliases to canonical statuses", () => {
    expect(STATUS_ALIASES["approve"]).toBe("approved");
    expect(STATUS_ALIASES["done_with_concerns"]).toBe("done");
    expect(STATUS_ALIASES["fixed"]).toBe("done");
    expect(STATUS_ALIASES["needs_context"]).toBe("hitl");
  });
});

describe("flow-definition-schemas.ts — GateResultSchema", () => {
  it("accepts a minimal gate result (required fields only)", () => {
    const result = GateResultSchema.parse({ gate: "npm test", passed: true });
    expect(result.gate).toBe("npm test");
    expect(result.passed).toBe(true);
    expect(result.command).toBeUndefined();
    expect(result.exitCode).toBeUndefined();
  });

  it("accepts a full gate result", () => {
    const result = GateResultSchema.parse({
      command: "npx vitest run",
      exitCode: 0,
      gate: "vitest",
      output: "All tests passed",
      passed: true,
    });
    expect(result.command).toBe("npx vitest run");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("All tests passed");
  });

  it("accepts a failed gate result with non-zero exit code", () => {
    const result = GateResultSchema.parse({
      exitCode: 1,
      gate: "tsc",
      output: "2 errors",
      passed: false,
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("rejects when required 'gate' field is missing", () => {
    expect(() => GateResultSchema.parse({ passed: true })).toThrow();
  });

  it("rejects when required 'passed' field is missing", () => {
    expect(() => GateResultSchema.parse({ gate: "npm test" })).toThrow();
  });
});

describe("flow-definition-schemas.ts — DiscoveredGateSchema", () => {
  it("accepts a valid discovered gate", () => {
    const result = DiscoveredGateSchema.parse({ command: "npx vitest run", source: "tester" });
    expect(result.command).toBe("npx vitest run");
    expect(result.source).toBe("tester");
  });

  it("rejects when 'command' is missing", () => {
    expect(() => DiscoveredGateSchema.parse({ source: "tester" })).toThrow();
  });

  it("rejects when 'source' is missing", () => {
    expect(() => DiscoveredGateSchema.parse({ command: "npx vitest run" })).toThrow();
  });
});

describe("flow-definition-schemas.ts — RequiredArtifactSchema", () => {
  it("accepts a valid artifact with safe filename", () => {
    const result = RequiredArtifactSchema.parse({ name: "SUMMARY.md", type: "summary" });
    expect(result.name).toBe("SUMMARY.md");
    expect(result.type).toBe("summary");
  });

  it("accepts filenames with dots, dashes, underscores", () => {
    const result = RequiredArtifactSchema.parse({ name: "test-report_v2.md", type: "report" });
    expect(result.name).toBe("test-report_v2.md");
  });

  it("rejects names with path separators", () => {
    expect(() =>
      RequiredArtifactSchema.parse({ name: "path/to/file.md", type: "summary" }),
    ).toThrow();
  });

  it("rejects name '.' (dot-only)", () => {
    expect(() => RequiredArtifactSchema.parse({ name: ".", type: "summary" })).toThrow();
  });

  it("rejects name '..' (double-dot)", () => {
    expect(() => RequiredArtifactSchema.parse({ name: "..", type: "summary" })).toThrow();
  });
});

describe("flow-definition-schemas.ts — FlowDefinitionSchema", () => {
  it("accepts a minimal flow definition (name + description required)", () => {
    const result = FlowDefinitionSchema.parse({ description: "A test flow", name: "test-flow" });
    expect(result.name).toBe("test-flow");
    expect(result.description).toBe("A test flow");
  });

  it("accepts a flow with states and transitions", () => {
    const result = FlowDefinitionSchema.parse({
      description: "Feature flow",
      name: "feature",
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon:canon-implementor", type: "single" },
      },
    });
    expect(Object.keys(result.states ?? {})).toContain("implement");
    expect(Object.keys(result.states ?? {})).toContain("done");
  });

  it("rejects a flow definition missing 'name'", () => {
    expect(() => FlowDefinitionSchema.parse({ description: "Missing name" })).toThrow();
  });

  it("rejects a flow definition missing 'description'", () => {
    expect(() => FlowDefinitionSchema.parse({ name: "no-desc" })).toThrow();
  });

  it("rejects invalid 'tier' value", () => {
    expect(() =>
      FlowDefinitionSchema.parse({ description: "d", name: "n", tier: "xlarge" }),
    ).toThrow();
  });
});

describe("flow-definition-schemas.ts — BaseStateFields usability", () => {
  it("BaseStateFields is a plain object (not a Zod schema instance)", () => {
    // BaseStateFields must be spreadable into z.object() calls, not itself a Zod schema
    expect(typeof BaseStateFields).toBe("object");
    expect(BaseStateFields).not.toBeNull();
    // It should not have a Zod .parse() method — it's a raw field map
    expect((BaseStateFields as Record<string, unknown>).parse).toBeUndefined();
  });

  it("BaseStateFields has expected keys", () => {
    const keys = Object.keys(BaseStateFields);
    expect(keys).toContain("agent");
    expect(keys).toContain("max_iterations");
    expect(keys).toContain("stuck_when");
    expect(keys).toContain("tool_overrides");
    expect(keys).toContain("transitions");
  });

  it("FragmentBaseStateFields is a plain object spreadable into z.object()", () => {
    expect(typeof FragmentBaseStateFields).toBe("object");
    expect(FragmentBaseStateFields).not.toBeNull();
    expect((FragmentBaseStateFields as Record<string, unknown>).parse).toBeUndefined();
  });

  it("SingleStateSchema (which spreads BaseStateFields) parses the base fields correctly", () => {
    // Verifies that BaseStateFields spread into SingleStateSchema works as intended
    const result = SingleStateSchema.parse({
      agent: "canon:canon-implementor",
      max_iterations: 5,
      stuck_when: "same_violations",
      tool_overrides: { allow: ["Read"] },
      transitions: { done: "next-state" },
      type: "single",
    });
    expect(result.agent).toBe("canon:canon-implementor");
    expect(result.max_iterations).toBe(5);
    expect(result.stuck_when).toBe("same_violations");
    expect(result.tool_overrides?.allow).toEqual(["Read"]);
    expect(result.transitions?.done).toBe("next-state");
  });
});

// =============================================================================
// board-state-schemas.ts — cross-file import correctness
// =============================================================================

describe("board-state-schemas.ts — AgentMetricsSchema", () => {
  it("accepts an empty metrics object (all optional)", () => {
    const result = AgentMetricsSchema.parse({});
    expect(result).toBeDefined();
  });

  it("accepts a full metrics object", () => {
    const result = AgentMetricsSchema.parse({
      cache_read_tokens: 100,
      cache_write_tokens: 200,
      duration_ms: 5000,
      input_tokens: 300,
      orientation_calls: 3,
      output_tokens: 400,
      tool_calls: 12,
      turns: 6,
    });
    expect(result.tool_calls).toBe(12);
    expect(result.orientation_calls).toBe(3);
    expect(result.turns).toBe(6);
  });

  it("rejects non-numeric values for numeric fields", () => {
    expect(() => AgentMetricsSchema.parse({ tool_calls: "twelve" })).toThrow();
  });
});

describe("board-state-schemas.ts — BoardStateEntrySchema (cross-file: GateResultSchema from flow-definition-schemas)", () => {
  it("accepts a minimal board state entry", () => {
    const result = BoardStateEntrySchema.parse({ status: "pending" });
    expect(result.status).toBe("pending");
    expect(result.entries).toBe(0); // default
  });

  it("accepts gate_results from cross-file GateResultSchema dependency", () => {
    // gate_results uses GateResultSchema imported from flow-definition-schemas.ts
    const result = BoardStateEntrySchema.parse({
      gate_results: [{ gate: "npm test", passed: true }],
      status: "done",
    });
    expect(result.gate_results).toHaveLength(1);
    expect(result.gate_results?.[0].gate).toBe("npm test");
    expect(result.gate_results?.[0].passed).toBe(true);
  });

  it("accepts discovered_gates from cross-file DiscoveredGateSchema dependency", () => {
    // discovered_gates uses DiscoveredGateSchema imported from flow-definition-schemas.ts
    const result = BoardStateEntrySchema.parse({
      discovered_gates: [{ command: "npx vitest run", source: "tester" }],
      status: "in_progress",
    });
    expect(result.discovered_gates?.[0].command).toBe("npx vitest run");
  });

  it("rejects invalid status value", () => {
    expect(() => BoardStateEntrySchema.parse({ status: "unknown_status" })).toThrow();
  });

  it("accepts all valid status values", () => {
    for (const status of ["pending", "in_progress", "done", "skipped", "blocked"] as const) {
      const result = BoardStateEntrySchema.parse({ status });
      expect(result.status).toBe(status);
    }
  });
});

describe("board-state-schemas.ts — WorktreeEntrySchema", () => {
  it("accepts a valid worktree entry", () => {
    const result = WorktreeEntrySchema.parse({
      branch: "feat/my-feature",
      task_id: "ddd-01",
      worktree_path: "/tmp/worktrees/ddd-01",
    });
    expect(result.branch).toBe("feat/my-feature");
    expect(result.status).toBe("active"); // default
  });

  it("accepts non-default status values", () => {
    const result = WorktreeEntrySchema.parse({
      branch: "feat/done",
      status: "merged",
      task_id: "t1",
      worktree_path: "/tmp/t1",
    });
    expect(result.status).toBe("merged");
  });

  it("rejects invalid status", () => {
    expect(() =>
      WorktreeEntrySchema.parse({
        branch: "b",
        status: "abandoned",
        task_id: "t",
        worktree_path: "/tmp/t",
      }),
    ).toThrow();
  });
});

describe("board-state-schemas.ts — SessionSchema", () => {
  const validSession = {
    branch: "main",
    created: "2026-01-01T00:00:00Z",
    flow: "feature",
    sanitized: "add-dark-mode",
    slug: "add-dark-mode-abc123",
    status: "active" as const,
    task: "Add dark mode support",
    tier: "medium" as const,
  };

  it("accepts a valid session", () => {
    const result = SessionSchema.parse(validSession);
    expect(result.flow).toBe("feature");
    expect(result.status).toBe("active");
    expect(result.tier).toBe("medium");
  });

  it("accepts all valid status values", () => {
    for (const status of ["active", "completed", "aborted", "rolled_back"] as const) {
      const result = SessionSchema.parse({ ...validSession, status });
      expect(result.status).toBe(status);
    }
  });

  it("accepts all valid tier values", () => {
    for (const tier of ["small", "medium", "large"] as const) {
      const result = SessionSchema.parse({ ...validSession, tier });
      expect(result.tier).toBe(tier);
    }
  });

  it("rejects invalid status value", () => {
    expect(() => SessionSchema.parse({ ...validSession, status: "running" })).toThrow();
  });

  it("rejects invalid tier value", () => {
    expect(() => SessionSchema.parse({ ...validSession, tier: "xlarge" })).toThrow();
  });

  it("rejects missing required field 'branch'", () => {
    const { branch: _omit, ...rest } = validSession;
    expect(() => SessionSchema.parse(rest)).toThrow();
  });
});

describe("board-state-schemas.ts — BoardSchema", () => {
  const validBoard = {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "feature",
    iterations: {},
    last_updated: "2026-01-01T00:00:00Z",
    skipped: [],
    started: "2026-01-01T00:00:00Z",
    states: {
      implement: { entries: 1, status: "in_progress" },
    },
    task: "Add dark mode",
  };

  it("accepts a minimal valid board", () => {
    const result = BoardSchema.parse(validBoard);
    expect(result.flow).toBe("feature");
    expect(result.blocked).toBeNull();
    expect(result.current_state).toBe("implement");
  });

  it("accepts blocked as non-null object", () => {
    const result = BoardSchema.parse({
      ...validBoard,
      blocked: { reason: "Waiting for input", since: "2026-01-01T00:00:00Z", state: "implement" },
    });
    expect(result.blocked?.reason).toBe("Waiting for input");
  });

  it("rejects missing required 'base_commit'", () => {
    const { base_commit: _omit, ...rest } = validBoard;
    expect(() => BoardSchema.parse(rest)).toThrow();
  });

  it("rejects missing required 'flow'", () => {
    const { flow: _omit, ...rest } = validBoard;
    expect(() => BoardSchema.parse(rest)).toThrow();
  });
});

// =============================================================================
// event-schemas.ts — TranscriptEntrySchema
// =============================================================================

describe("event-schemas.ts — TranscriptEntrySchema", () => {
  it("accepts a minimal transcript entry", () => {
    const result = TranscriptEntrySchema.parse({
      content: "Hello",
      role: "user",
      timestamp: "2026-01-01T00:00:00Z",
      turn_number: 1,
    });
    expect(result.role).toBe("user");
    expect(result.turn_number).toBe(1);
  });

  it("accepts all valid role values", () => {
    const roles = ["system", "user", "assistant", "tool_use", "tool_result"] as const;
    for (const role of roles) {
      const result = TranscriptEntrySchema.parse({
        content: "test",
        role,
        timestamp: "2026-01-01T00:00:00Z",
        turn_number: 1,
      });
      expect(result.role).toBe(role);
    }
  });

  it("accepts optional token fields", () => {
    const result = TranscriptEntrySchema.parse({
      content: "tool result here",
      cumulative_tokens: 5000,
      role: "tool_result",
      timestamp: "2026-01-01T00:00:00Z",
      tokens: 42,
      tool_name: "Bash",
      turn_number: 3,
    });
    expect(result.tokens).toBe(42);
    expect(result.cumulative_tokens).toBe(5000);
    expect(result.tool_name).toBe("Bash");
  });

  it("rejects invalid role value", () => {
    expect(() =>
      TranscriptEntrySchema.parse({
        content: "test",
        role: "bot",
        timestamp: "2026-01-01T00:00:00Z",
        turn_number: 1,
      }),
    ).toThrow();
  });

  it("rejects missing required 'content'", () => {
    expect(() =>
      TranscriptEntrySchema.parse({
        role: "user",
        timestamp: "2026-01-01T00:00:00Z",
        turn_number: 1,
      }),
    ).toThrow();
  });

  it("rejects missing required 'turn_number'", () => {
    expect(() =>
      TranscriptEntrySchema.parse({
        content: "hello",
        role: "user",
        timestamp: "2026-01-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects missing required 'timestamp'", () => {
    expect(() =>
      TranscriptEntrySchema.parse({
        content: "hello",
        role: "user",
        turn_number: 1,
      }),
    ).toThrow();
  });
});
