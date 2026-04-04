/**
 * Tests for ADR-003a agent performance metrics fields on StateMetricsSchema
 * and the new AgentMetricsSchema / AgentMetrics type export.
 */

import { describe, expect, it } from "vitest";
import type { AgentMetrics } from "../orchestration/flow-schema.ts";
import { AgentMetricsSchema, StateMetricsSchema } from "../orchestration/flow-schema.ts";

describe("StateMetricsSchema — backward-compatible optional fields", () => {
  it("parses empty object (all fields optional)", () => {
    const result = StateMetricsSchema.parse({});
    expect(result).toEqual({});
  });

  it("parses existing metrics shape without new fields", () => {
    const input = { duration_ms: 100, model: "opus", spawns: 1 };
    const result = StateMetricsSchema.parse(input);
    expect(result.duration_ms).toBe(100);
    expect(result.spawns).toBe(1);
    expect(result.model).toBe("opus");
  });

  it("parses new ADR-003a fields when provided", () => {
    const input = { tool_calls: 5, turns: 3 };
    const result = StateMetricsSchema.parse(input);
    expect(result.tool_calls).toBe(5);
    expect(result.turns).toBe(3);
  });

  it("parses all 7 new ADR-003a fields together", () => {
    const input = {
      cache_read_tokens: 2000,
      cache_write_tokens: 800,
      input_tokens: 5000,
      orientation_calls: 2,
      output_tokens: 1500,
      tool_calls: 12,
      turns: 7,
    };
    const result = StateMetricsSchema.parse(input);
    expect(result.tool_calls).toBe(12);
    expect(result.orientation_calls).toBe(2);
    expect(result.input_tokens).toBe(5000);
    expect(result.output_tokens).toBe(1500);
    expect(result.cache_read_tokens).toBe(2000);
    expect(result.cache_write_tokens).toBe(800);
    expect(result.turns).toBe(7);
  });

  it("rejects non-number value for tool_calls", () => {
    expect(() => StateMetricsSchema.parse({ tool_calls: "not a number" })).toThrow();
  });

  it("rejects non-number value for turns", () => {
    expect(() => StateMetricsSchema.parse({ turns: true })).toThrow();
  });

  it("parses combined existing and new fields", () => {
    const input = {
      cache_read_tokens: 500,
      cache_write_tokens: 200,
      duration_ms: 2500,
      input_tokens: 3000,
      model: "sonnet",
      orientation_calls: 1,
      output_tokens: 900,
      spawns: 3,
      tool_calls: 10,
      turns: 4,
    };
    const result = StateMetricsSchema.parse(input);
    expect(result.duration_ms).toBe(2500);
    expect(result.tool_calls).toBe(10);
    expect(result.turns).toBe(4);
  });
});

describe("AgentMetricsSchema — focused ADR-003a input validation schema", () => {
  it("parses empty object (all fields optional)", () => {
    const result = AgentMetricsSchema.parse({});
    expect(result).toEqual({});
  });

  it("validates all 8 ADR-003a fields", () => {
    const input = {
      cache_read_tokens: 2000,
      cache_write_tokens: 800,
      duration_ms: 3000,
      input_tokens: 5000,
      orientation_calls: 2,
      output_tokens: 1500,
      tool_calls: 12,
      turns: 7,
    };
    const result = AgentMetricsSchema.parse(input);
    expect(result.tool_calls).toBe(12);
    expect(result.orientation_calls).toBe(2);
    expect(result.input_tokens).toBe(5000);
    expect(result.output_tokens).toBe(1500);
    expect(result.cache_read_tokens).toBe(2000);
    expect(result.cache_write_tokens).toBe(800);
    expect(result.duration_ms).toBe(3000);
    expect(result.turns).toBe(7);
  });

  it("rejects string value for input_tokens", () => {
    expect(() => AgentMetricsSchema.parse({ input_tokens: "lots" })).toThrow();
  });

  it("rejects string value for cache_read_tokens", () => {
    expect(() => AgentMetricsSchema.parse({ cache_read_tokens: "big" })).toThrow();
  });

  it("parses partial input (subset of fields)", () => {
    const input = { duration_ms: 1200, tool_calls: 3 };
    const result = AgentMetricsSchema.parse(input);
    expect(result.tool_calls).toBe(3);
    expect(result.duration_ms).toBe(1200);
    expect(result.turns).toBeUndefined();
  });
});

describe("AgentMetrics type — structural type check", () => {
  it("AgentMetrics type has all 8 fields as optional", () => {
    // This is a compile-time check via assignment; if the type is wrong, TS will fail tsc --noEmit
    const metrics: AgentMetrics = {};
    expect(metrics).toBeDefined();

    const full: AgentMetrics = {
      cache_read_tokens: 5,
      cache_write_tokens: 6,
      duration_ms: 7,
      input_tokens: 3,
      orientation_calls: 2,
      output_tokens: 4,
      tool_calls: 1,
      turns: 8,
    };
    expect(full.tool_calls).toBe(1);
    expect(full.turns).toBe(8);
  });
});
