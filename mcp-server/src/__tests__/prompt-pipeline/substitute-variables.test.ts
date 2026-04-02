/**
 * Unit tests for substitute-variables.ts (Stage 4)
 *
 * Tests variable substitution and cache prefix prepend.
 * One behavior per test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptContext, SpawnPromptEntry } from "../../tools/prompt-pipeline/types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Hoist vi.mock — must come before module imports
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(),
}));

import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { substituteVariablesStage } from "../../tools/prompt-pipeline/substitute-variables.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "substitute-vars-test-"));
  tmpDirs.push(dir);
  return dir;
}

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

function makeCtx(rawInstruction: string, variables: Record<string, string> = {}): PromptContext {
  const state: StateDefinition = { type: "single", agent: "test-agent" };
  return {
    input: {
      workspace: "/tmp/test-workspace",
      state_id: "start",
      flow: makeFlow(),
      variables,
    },
    state,
    rawInstruction,
    board: makeBoard(),
    mergedVariables: variables,
    basePrompt: "",
    prompts: [],
    warnings: [],
  };
}

function makeStoreWith(getCachePrefix: () => string): unknown {
  return { getCachePrefix };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("substituteVariablesStage (Stage 4)", () => {
  it("substitutes known variables in rawInstruction", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>);
    const ctx = makeCtx("Do ${task} now", { task: "the thing" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do the thing now");
  });

  it("leaves unknown ${...} patterns unchanged", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>);
    const ctx = makeCtx("Do ${task} and ${unknown}", { task: "a task" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do a task and ${unknown}");
  });

  it("prepends cache prefix when store returns non-empty string", async () => {
    const prefix = "CACHED_CONTEXT: some cached data\n\n";
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWith(() => prefix) as ReturnType<typeof getExecutionStore>);
    const ctx = makeCtx("Do ${task}", { task: "the work" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe(`${prefix}Do the work`);
  });

  it("skips cache prefix when store returns empty string", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>);
    const ctx = makeCtx("Do ${task}", { task: "the work" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do the work");
    // No prefix prepended — just the substituted instruction
    expect(result.basePrompt.startsWith("Do the work")).toBe(true);
  });

  it("skips cache prefix when getCachePrefix is not available on store", async () => {
    // When parallel task adr006-03 hasn't added getCachePrefix yet, handle gracefully
    vi.mocked(getExecutionStore).mockReturnValue({} as ReturnType<typeof getExecutionStore>);
    const ctx = makeCtx("Do ${task}", { task: "something" });
    const result = await substituteVariablesStage(ctx);
    expect(result.basePrompt).toBe("Do something");
  });

  it("uses mergedVariables (not input.variables) for substitution", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWith(() => "") as ReturnType<typeof getExecutionStore>);
    const ctx = makeCtx("${injected} value", {});
    // Override mergedVariables with injected value (simulating stage 1 having run)
    const ctxWithMerged = { ...ctx, mergedVariables: { injected: "resolved" } };
    const result = await substituteVariablesStage(ctxWithMerged);
    expect(result.basePrompt).toBe("resolved value");
  });
});
