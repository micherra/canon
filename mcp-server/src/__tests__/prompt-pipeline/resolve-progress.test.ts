/**
 * Unit tests for resolve-progress.ts (Stage 2)
 *
 * Tests progress variable resolution with escapeDollarBrace at read boundary.
 * One behavior per test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStoreCache, getExecutionStore } from "../../orchestration/execution-store.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import { resolveProgress } from "../../tools/prompt-pipeline/resolve-progress.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "resolve-progress-test-"));
  tmpDirs.push(dir);
  return dir;
}

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

function makeFlow(progress?: string): ResolvedFlow {
  return {
    description: "test flow",
    entry: "start",
    name: "test",
    progress,
    spawn_instructions: { start: "Do the thing" },
    states: {
      done: { type: "terminal" },
      start: { agent: "test-agent", type: "single" },
    },
  };
}

function makeCtx(workspace: string, overrides: Partial<PromptContext> = {}): PromptContext {
  const state: StateDefinition = { agent: "test-agent", type: "single" };
  const flow = makeFlow();
  return {
    basePrompt: "",
    board: makeBoard(),
    input: {
      flow,
      state_id: "start",
      variables: { task: "test task" },
      workspace,
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
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("resolveProgress (Stage 2)", () => {
  it("returns ctx unchanged when flow.progress is falsy (undefined)", async () => {
    const workspace = makeTmpDir();
    const ctx = makeCtx(workspace); // flow has no progress field
    const result = await resolveProgress(ctx);
    expect(result).toBe(ctx); // same reference
    expect(result.mergedVariables.progress).toBeUndefined();
  });

  it("returns ctx unchanged when flow.progress is empty string", async () => {
    const workspace = makeTmpDir();
    const flow = makeFlow("");
    const ctx = makeCtx(workspace, {
      input: { flow, state_id: "start", variables: {}, workspace },
    });
    const result = await resolveProgress(ctx);
    expect(result).toBe(ctx);
    expect(result.mergedVariables.progress).toBeUndefined();
  });

  it("reads progress from ExecutionStore and sets mergedVariables.progress", async () => {
    const workspace = makeTmpDir();
    const now = new Date().toISOString();
    const store = getExecutionStore(workspace);
    store.initExecution({
      base_commit: "abc",
      branch: "main",
      created: now,
      current_state: "start",
      entry: "start",
      flow: "test",
      flow_name: "test",
      last_updated: now,
      sanitized: "main",
      slug: "test-slug",
      started: now,
      task: "test",
      tier: "small",
    });
    store.appendProgress("## Progress: test");
    store.appendProgress("- [research] done: found something");

    const flow = makeFlow("${WORKSPACE}/progress.md");
    const ctx = makeCtx(workspace, {
      input: { flow, state_id: "start", variables: {}, workspace },
    });

    const result = await resolveProgress(ctx);
    expect(result.mergedVariables.progress).toContain("## Progress: test");
    expect(result.mergedVariables.progress).toContain("- [research] done: found something");
  });

  it("escapes ${...} patterns in progress content", async () => {
    const workspace = makeTmpDir();
    const now = new Date().toISOString();
    const store = getExecutionStore(workspace);
    store.initExecution({
      base_commit: "abc",
      branch: "main",
      created: now,
      current_state: "start",
      entry: "start",
      flow: "test",
      flow_name: "test",
      last_updated: now,
      sanitized: "main",
      slug: "test-slug",
      started: now,
      task: "test",
      tier: "small",
    });
    // Progress content contains ${WORKSPACE} which could cause re-expansion
    store.appendProgress("Use ${WORKSPACE} for the path");

    const flow = makeFlow("${WORKSPACE}/progress.md");
    const ctx = makeCtx(workspace, {
      input: { flow, state_id: "start", variables: {}, workspace },
    });

    const result = await resolveProgress(ctx);
    // escapeDollarBrace must have run — ${WORKSPACE} becomes \${WORKSPACE}
    expect(result.mergedVariables.progress).toContain("\\${WORKSPACE}");
    expect(result.mergedVariables.progress).not.toMatch(/(?<!\\)\$\{WORKSPACE\}/);
  });

  it("sets mergedVariables.progress to empty string when store has no entries", async () => {
    const workspace = makeTmpDir();
    // Do NOT init the store — no progress entries

    const flow = makeFlow("${WORKSPACE}/progress.md");
    const ctx = makeCtx(workspace, {
      input: { flow, state_id: "start", variables: {}, workspace },
    });

    const result = await resolveProgress(ctx);
    // When store returns empty string, progress is set to empty string (not undefined)
    expect(result.mergedVariables.progress).toBe("");
  });
});
