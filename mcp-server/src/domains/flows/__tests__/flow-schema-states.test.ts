/**
 * Tests for discriminated union state schemas in flow-schema.ts (ADR-004)
 *
 * File 2 of 2: FragmentStateDefinitionSchema, ToolOverridesSchema,
 *              tool_overrides on state schemas, ADR-004 acceptance tests
 */

import { describe, expect, it } from "vitest";
import {
  FragmentStateDefinitionSchema,
  ParallelPerStateSchema,
  ParallelStateSchema,
  SingleStateSchema,
  StateDefinitionSchema,
  TerminalStateSchema,
  ToolOverridesSchema,
  WaveStateSchema,
} from "../flow-definition-schemas.ts";

// FragmentStateDefinitionSchema — relaxed numeric fields

describe("FragmentStateDefinitionSchema", () => {
  it("accepts single fragment state with string max_iterations placeholder", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      max_iterations: "${max_iter}",
      type: "single",
    });
    expect(result.type).toBe("single");
    expect((result as Record<string, unknown>).max_iterations).toBe("${max_iter}");
  });

  it("accepts single fragment state with numeric max_iterations", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      max_iterations: 3,
      type: "single",
    });
    expect((result as Record<string, unknown>).max_iterations).toBe(3);
  });

  it("accepts wave fragment state", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      type: "wave",
    });
    expect(result.type).toBe("wave");
  });

  it("accepts parallel fragment state", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agents: ["canon:canon-implementor"],
      type: "parallel",
    });
    expect(result.type).toBe("parallel");
  });

  it("accepts parallel-per fragment state with string iterate_on", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      iterate_on: "${tasks}",
      type: "parallel-per",
    });
    expect((result as Record<string, unknown>).iterate_on).toBe("${tasks}");
  });

  it("accepts terminal fragment state", () => {
    const result = FragmentStateDefinitionSchema.parse({
      type: "terminal",
    });
    expect(result.type).toBe("terminal");
  });

  it("accepts string large_diff_threshold placeholder", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      large_diff_threshold: "${threshold}",
      type: "single",
    });
    expect((result as Record<string, unknown>).large_diff_threshold).toBe("${threshold}");
  });

  it("rejects unknown type literal", () => {
    expect(() =>
      FragmentStateDefinitionSchema.parse({
        agent: "canon:canon-implementor",
        type: "bogus",
      }),
    ).toThrow();
  });
});

// ToolOverridesSchema

describe("ToolOverridesSchema", () => {
  it("accepts empty object {}", () => {
    const result = ToolOverridesSchema.parse({});
    expect(result).toBeDefined();
  });

  it("accepts undefined (optional)", () => {
    const result = ToolOverridesSchema.parse(undefined);
    expect(result).toBeUndefined();
  });

  it("accepts allow array", () => {
    const result = ToolOverridesSchema.parse({ allow: ["Bash", "Read"] });
    expect(result?.allow).toEqual(["Bash", "Read"]);
  });

  it("accepts deny array", () => {
    const result = ToolOverridesSchema.parse({ deny: ["Bash"] });
    expect(result?.deny).toEqual(["Bash"]);
  });

  it("accepts replace array", () => {
    const result = ToolOverridesSchema.parse({ replace: ["Read", "Write"] });
    expect(result?.replace).toEqual(["Read", "Write"]);
  });

  it("accepts all valid permission_mode values", () => {
    for (const mode of ["auto", "prompt", "deny_unknown"] as const) {
      const result = ToolOverridesSchema.parse({ permission_mode: mode });
      expect(result?.permission_mode).toBe(mode);
    }
  });

  it("rejects invalid permission_mode value", () => {
    expect(() => ToolOverridesSchema.parse({ permission_mode: "allow_all" })).toThrow();
  });
});

// tool_overrides on per-type state schemas

describe("tool_overrides on state schemas (ADR-014)", () => {
  it("SingleStateSchema accepts tool_overrides with allow array", () => {
    const result = SingleStateSchema.parse({
      agent: "canon:canon-implementor",
      tool_overrides: { allow: ["Read", "Write", "Bash"] },
      type: "single",
    });
    expect(result.tool_overrides?.allow).toEqual(["Read", "Write", "Bash"]);
  });

  it("WaveStateSchema accepts tool_overrides with deny array", () => {
    const result = WaveStateSchema.parse({
      agent: "canon:canon-implementor",
      tool_overrides: { deny: ["Write"] },
      type: "wave",
    });
    expect(result.tool_overrides?.deny).toEqual(["Write"]);
  });

  it("ParallelStateSchema accepts tool_overrides with replace array", () => {
    const result = ParallelStateSchema.parse({
      agents: ["canon:canon-implementor", "canon:canon-tester"],
      tool_overrides: { replace: ["Bash", "Read"] },
      type: "parallel",
    });
    expect(result.tool_overrides?.replace).toEqual(["Bash", "Read"]);
  });

  it("ParallelPerStateSchema accepts tool_overrides with permission_mode", () => {
    const result = ParallelPerStateSchema.parse({
      agent: "canon:canon-implementor",
      iterate_on: "${tasks}",
      tool_overrides: { permission_mode: "deny_unknown" },
      type: "parallel-per",
    });
    expect(result.tool_overrides?.permission_mode).toBe("deny_unknown");
  });

  it("TerminalStateSchema accepts tool_overrides", () => {
    const result = TerminalStateSchema.parse({
      tool_overrides: { allow: ["Read"] },
      type: "terminal",
    });
    expect(result.tool_overrides?.allow).toEqual(["Read"]);
  });

  it("SingleStateSchema parses without tool_overrides (backward compat)", () => {
    const result = SingleStateSchema.parse({
      agent: "canon:canon-implementor",
      type: "single",
    });
    expect(result.tool_overrides).toBeUndefined();
  });

  it("WaveStateSchema parses without tool_overrides (backward compat)", () => {
    const result = WaveStateSchema.parse({
      agent: "canon:canon-implementor",
      type: "wave",
    });
    expect(result.tool_overrides).toBeUndefined();
  });

  it("ParallelStateSchema parses without tool_overrides (backward compat)", () => {
    const result = ParallelStateSchema.parse({
      type: "parallel",
    });
    expect(result.tool_overrides).toBeUndefined();
  });

  it("ParallelPerStateSchema parses without tool_overrides (backward compat)", () => {
    const result = ParallelPerStateSchema.parse({
      agent: "canon:canon-implementor",
      iterate_on: "${tasks}",
      type: "parallel-per",
    });
    expect(result.tool_overrides).toBeUndefined();
  });

  it("TerminalStateSchema parses without tool_overrides (backward compat)", () => {
    const result = TerminalStateSchema.parse({
      type: "terminal",
    });
    expect(result.tool_overrides).toBeUndefined();
  });

  it("FragmentSingleStateSchema accepts tool_overrides", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      tool_overrides: { allow: ["Read"] },
      type: "single",
    });
    expect((result as Record<string, unknown>).tool_overrides).toBeDefined();
  });

  it("FragmentWaveStateSchema accepts tool_overrides", () => {
    const result = FragmentStateDefinitionSchema.parse({
      agent: "canon:canon-implementor",
      tool_overrides: { deny: ["Bash"] },
      type: "wave",
    });
    expect((result as Record<string, unknown>).tool_overrides).toBeDefined();
  });
});

// ADR-004 acceptance: discriminated union type safety (dc-02)

describe("ADR-004 acceptance: discriminated union state schemas (dc-02)", () => {
  it("rejects a wave state with iterate_on (belongs to parallel-per)", () => {
    // iterate_on is a parallel-per field; WaveStateSchema does not accept it.
    // The discriminated union should route type:"wave" to WaveStateSchema, which
    // strips iterate_on (Zod default) or rejects it if strict.
    // The test verifies that iterate_on is NOT propagated into a wave state.
    const result = StateDefinitionSchema.parse({
      agent: "test",
      iterate_on: "items",
      type: "wave",
    });
    // Zod strips unknown fields — iterate_on must not appear on the parsed result
    expect(result.type).toBe("wave");
    expect((result as Record<string, unknown>).iterate_on).toBeUndefined();
  });

  it("accepts wave state with wave_policy (dc-02 positive case)", () => {
    const result = StateDefinitionSchema.parse({
      agent: "test",
      type: "wave",
      wave_policy: { isolation: "branch", merge_strategy: "squash" },
    });
    expect(result.type).toBe("wave");
    if (result.type === "wave") {
      expect(result.wave_policy?.isolation).toBe("branch");
      expect(result.wave_policy?.merge_strategy).toBe("squash");
    }
  });

  it("wave state without wave_policy gets undefined wave_policy (dc-07: optional with defaults applied on access)", () => {
    const result = StateDefinitionSchema.parse({
      agent: "test",
      type: "wave",
    });
    expect(result.type).toBe("wave");
    // wave_policy is optional — absent when not provided
    if (result.type === "wave") {
      expect(result.wave_policy).toBeUndefined();
    }
  });

  it("wave state with empty wave_policy object gets WavePolicySchema defaults (dc-07)", () => {
    const result = StateDefinitionSchema.parse({
      agent: "test",
      type: "wave",
      wave_policy: {},
    });
    expect(result.type).toBe("wave");
    if (result.type === "wave") {
      expect(result.wave_policy?.isolation).toBe("worktree");
      expect(result.wave_policy?.merge_strategy).toBe("sequential");
      expect(result.wave_policy?.on_conflict).toBe("hitl");
    }
  });

  it("parallel-per state accepts iterate_on (correct field placement)", () => {
    const result = StateDefinitionSchema.parse({
      agent: "test",
      iterate_on: "items",
      type: "parallel-per",
    });
    expect(result.type).toBe("parallel-per");
    if (result.type === "parallel-per") {
      expect(result.iterate_on).toBe("items");
    }
  });
});
