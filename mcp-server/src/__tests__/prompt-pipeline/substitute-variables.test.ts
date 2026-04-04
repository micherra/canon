/**
 * Unit tests for substitute-variables.ts (Stage 4)
 *
 * Tests variable substitution and cache prefix prepend.
 * One behavior per test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";

// Hoist vi.mock — must come before module imports

vi.mock("../../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(),
}));

import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { substituteVariablesStage } from "../../tools/prompt-pipeline/substitute-variables.ts";

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

function makeCtx(rawInstruction: string, variables: Record<string, string> = {}): PromptContext {
  const state: StateDefinition = { agent: "test-agent", type: "single" };
  return {
    basePrompt: "",
    board: makeBoard(),
    input: {
      flow: makeFlow(),
      state_id: "start",
      variables,
      workspace: "/tmp/test-workspace",
    },
    mergedVariables: variables,
    prompts: [],
    rawInstruction,
    state,
    warnings: [],
  };
}

function makeStoreWith(getCachePrefix: () => string): unknown {
  return { getCachePrefix };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("substituteVariablesStage (Stage 4)", () => {
  it("substitutes known variables in rawInstruction", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(
      makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>,
    );
    const ctx = makeCtx("Do ${task} now", { task: "the thing" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do the thing now");
  });

  it("leaves unknown ${...} patterns unchanged", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(
      makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>,
    );
    const ctx = makeCtx("Do ${task} and ${unknown}", { task: "a task" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do a task and ${unknown}");
  });

  it("prepends cache prefix when store returns non-empty string", async () => {
    const prefix = "CACHED_CONTEXT: some cached data\n\n";
    vi.mocked(getExecutionStore).mockReturnValue(
      makeStoreWith(() => prefix) as ReturnType<typeof getExecutionStore>,
    );
    const ctx = makeCtx("Do ${task}", { task: "the work" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe(`${prefix}\n\n---\n\nDo the work`);
  });

  it("skips cache prefix when store returns empty string", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(
      makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>,
    );
    const ctx = makeCtx("Do ${task}", { task: "the work" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do the work");
    // No prefix prepended — just the substituted instruction
    expect(result.basePrompt.startsWith("Do the work")).toBe(true);
  });

  it("sets cachePrefix to undefined when store returns empty string", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(
      makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>,
    );
    const ctx = makeCtx("Do ${task}", { task: "something" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do something");
    expect(result.cachePrefix).toBeUndefined();
  });

  it("uses mergedVariables (not input.variables) for substitution", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(
      makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>,
    );
    const ctx = makeCtx("${injected} value", {});
    // Override mergedVariables with injected value (simulating stage 1 having run)
    const ctxWithMerged = { ...ctx, mergedVariables: { injected: "resolved" } };
    const result = await substituteVariablesStage(ctxWithMerged);
    expect(result.basePrompt).toBe("resolved value");
  });
});
