/**
 * Unit tests for resolve-context.ts (Stage 1)
 *
 * Tests inject_context resolution with escapeDollarBrace at read boundary.
 * One behavior per test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";

// Hoist vi.mock calls to top — must come before any imports that use the mocks

vi.mock("../../orchestration/inject-context.ts", () => ({
  resolveContextInjections: vi.fn(),
}));

import { resolveContextInjections } from "../../orchestration/inject-context.ts";
import { resolveContext } from "../../tools/prompt-pipeline/resolve-context.ts";

function makeBoard(): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: "test",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
  };
}

function makeFlow(): ResolvedFlow {
  return {
    description: "test flow",
    entry: "start",
    name: "test",
    spawn_instructions: { start: "Do the thing" },
    states: {
      done: { type: "terminal" },
      start: { agent: "test-agent", type: "single" },
    },
  };
}

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  const state: StateDefinition = { agent: "test-agent", type: "single" };
  return {
    basePrompt: "",
    board: makeBoard(),
    input: {
      flow: makeFlow(),
      state_id: "start",
      variables: { task: "test task" },
      workspace: "/tmp/test-workspace",
    },
    mergedVariables: { task: "test task" },
    prompts: [],
    rawInstruction: "Do the thing",
    state,
    warnings: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveContext (Stage 1)", () => {
  it("returns ctx unchanged when state has no inject_context", async () => {
    const ctx = makeCtx();
    // State has no inject_context field
    const result = await resolveContext(ctx);
    expect(result).toBe(ctx); // same reference — not mutated
    expect(vi.mocked(resolveContextInjections)).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when inject_context is an empty array", async () => {
    const state: StateDefinition = { agent: "test-agent", inject_context: [], type: "single" };
    const ctx = makeCtx({ state });
    const result = await resolveContext(ctx);
    expect(result).toBe(ctx);
    expect(vi.mocked(resolveContextInjections)).not.toHaveBeenCalled();
  });

  it("merges injection variables into mergedVariables", async () => {
    const state: StateDefinition = {
      agent: "test-agent",
      inject_context: [{ as: "research_output", from: "research" }],
      type: "single",
    };
    const ctx = makeCtx({ state });

    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { research_output: "plain content without dollar braces" },
      warnings: [],
    });

    const result = await resolveContext(ctx);
    expect(result.mergedVariables.research_output).toBe("plain content without dollar braces");
    expect(result.mergedVariables.task).toBe("test task"); // preserved from original
  });

  it("escapes ${...} patterns in injected content (closes injection gap)", async () => {
    const state: StateDefinition = {
      agent: "test-agent",
      inject_context: [{ as: "research_output", from: "research" }],
      type: "single",
    };
    const ctx = makeCtx({ state });

    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { research_output: "Use ${WORKSPACE} for the path" },
      warnings: [],
    });

    const result = await resolveContext(ctx);
    // escapeDollarBrace must have run — ${WORKSPACE} becomes \${WORKSPACE}
    expect(result.mergedVariables.research_output).toBe("Use \\${WORKSPACE} for the path");
  });

  it("does not double-escape already-escaped content", async () => {
    // escapeDollarBrace is NOT idempotent — calling twice produces \\${
    // This test documents the current behavior (single escape at read boundary)
    const state: StateDefinition = {
      agent: "test-agent",
      inject_context: [{ as: "output", from: "research" }],
      type: "single",
    };
    const ctx = makeCtx({ state });

    // The raw content from inject-context has NO pre-escaping (per escaping-strategy-02)
    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { output: "Content with ${var} and more text" },
      warnings: [],
    });

    const result = await resolveContext(ctx);
    // escapeDollarBrace called exactly once — produces single backslash
    expect(result.mergedVariables.output).toBe("Content with \\${var} and more text");
    // Verify it does NOT double-escape (which would produce \\${)
    expect(result.mergedVariables.output).not.toContain("\\\\${");
  });

  it("sets skip_reason when HITL injection is required", async () => {
    const state: StateDefinition = {
      agent: "test-agent",
      inject_context: [{ as: "user_input", from: "user", prompt: "Please provide context" }],
      type: "single",
    };
    const ctx = makeCtx({ state });

    vi.mocked(resolveContextInjections).mockResolvedValue({
      hitl: { as: "user_input", prompt: "Please provide context" },
      variables: {},
      warnings: [],
    });

    const result = await resolveContext(ctx);
    expect(result.skip_reason).toBeDefined();
    expect(result.skip_reason).toContain("HITL");
    expect(result.skip_reason).toContain("Please provide context");
  });

  it("propagates injection warnings to ctx.warnings", async () => {
    const state: StateDefinition = {
      agent: "test-agent",
      inject_context: [{ as: "data", from: "research" }],
      type: "single",
    };
    const ctx = makeCtx({ state });

    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { data: "some content" },
      warnings: ["inject_context: artifact 'foo.md' not found"],
    });

    const result = await resolveContext(ctx);
    expect(result.warnings).toContain("inject_context: artifact 'foo.md' not found");
  });

  it("preserves existing ctx.warnings when adding new ones", async () => {
    const state: StateDefinition = {
      agent: "test-agent",
      inject_context: [{ as: "data", from: "research" }],
      type: "single",
    };
    const ctx = makeCtx({ state, warnings: ["pre-existing warning"] });

    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { data: "content" },
      warnings: ["new warning from injection"],
    });

    const result = await resolveContext(ctx);
    expect(result.warnings).toContain("pre-existing warning");
    expect(result.warnings).toContain("new warning from injection");
  });
});
