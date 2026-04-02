/**
 * Unit tests for resolve-context.ts (Stage 1)
 *
 * Tests inject_context resolution with escapeDollarBrace at read boundary.
 * One behavior per test.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Hoist vi.mock calls to top — must come before any imports that use the mocks
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/inject-context.ts", () => ({
  resolveContextInjections: vi.fn(),
}));

import { resolveContextInjections } from "../../orchestration/inject-context.ts";
import { resolveContext } from "../../tools/prompt-pipeline/resolve-context.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBoard(): Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

function makeFlow(): ResolvedFlow {
  return {
    name: "test",
    description: "test flow",
    entry: "start",
    states: {
      start: { type: "single", agent: "test-agent" },
      done: { type: "terminal" },
    },
    spawn_instructions: { start: "Do the thing" },
  };
}

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  const state: StateDefinition = { type: "single", agent: "test-agent" };
  return {
    input: {
      workspace: "/tmp/test-workspace",
      state_id: "start",
      flow: makeFlow(),
      variables: { task: "test task" },
    },
    state,
    rawInstruction: "Do the thing",
    board: makeBoard(),
    mergedVariables: { task: "test task" },
    basePrompt: "",
    prompts: [],
    warnings: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveContext (Stage 1)", () => {
  it("returns ctx unchanged when state has no inject_context", async () => {
    const ctx = makeCtx();
    // State has no inject_context field
    const result = await resolveContext(ctx);
    expect(result).toBe(ctx); // same reference — not mutated
    expect(vi.mocked(resolveContextInjections)).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when inject_context is an empty array", async () => {
    const state: StateDefinition = { type: "single", agent: "test-agent", inject_context: [] };
    const ctx = makeCtx({ state });
    const result = await resolveContext(ctx);
    expect(result).toBe(ctx);
    expect(vi.mocked(resolveContextInjections)).not.toHaveBeenCalled();
  });

  it("merges injection variables into mergedVariables", async () => {
    const state: StateDefinition = {
      type: "single",
      agent: "test-agent",
      inject_context: [{ from: "research", as: "research_output" }],
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
      type: "single",
      agent: "test-agent",
      inject_context: [{ from: "research", as: "research_output" }],
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
      type: "single",
      agent: "test-agent",
      inject_context: [{ from: "research", as: "output" }],
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
      type: "single",
      agent: "test-agent",
      inject_context: [{ from: "user", as: "user_input", prompt: "Please provide context" }],
    };
    const ctx = makeCtx({ state });

    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: {},
      hitl: { prompt: "Please provide context", as: "user_input" },
      warnings: [],
    });

    const result = await resolveContext(ctx);
    expect(result.skip_reason).toBeDefined();
    expect(result.skip_reason).toContain("HITL");
    expect(result.skip_reason).toContain("Please provide context");
  });

  it("propagates injection warnings to ctx.warnings", async () => {
    const state: StateDefinition = {
      type: "single",
      agent: "test-agent",
      inject_context: [{ from: "research", as: "data" }],
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
      type: "single",
      agent: "test-agent",
      inject_context: [{ from: "research", as: "data" }],
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
