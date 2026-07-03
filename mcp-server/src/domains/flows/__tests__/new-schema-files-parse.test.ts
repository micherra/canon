/**
 * Tests for the bounded-context schema files.
 *
 * Verifies the CONTRACT of live schema files:
 *   - schemas parse valid inputs correctly
 *   - schemas reject invalid inputs
 *   - Cross-file imports (board-state-schemas → flow-definition-schemas) produce
 *     correct parse behaviour for fields that cross the boundary
 */

import { describe, expect, it } from "vitest";
// --- board-state-schemas.ts imports --------------------------------------------
import {
  AgentMetricsSchema,
  BoardSchema,
  BoardStateEntrySchema,
  SessionSchema,
} from "../board-state-schemas.ts";
// --- flow-definition-schemas.ts imports ----------------------------------------
import { DiscoveredGateSchema, GateResultSchema } from "../flow-definition-schemas.ts";
// --- transcript-schemas.ts imports --------------------------------------------------
import { TranscriptEntrySchema } from "../transcript-schemas.ts";

// =============================================================================
// flow-definition-schemas.ts
// =============================================================================

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
// transcript-schemas.ts — TranscriptEntrySchema
// =============================================================================

describe("transcript-schemas.ts — TranscriptEntrySchema", () => {
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
});
