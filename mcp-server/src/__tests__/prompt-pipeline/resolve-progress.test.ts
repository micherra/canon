/**
 * Unit tests for resolve-progress.ts (Stage 2)
 *
 * Tests progress variable resolution with escapeDollarBrace at read boundary.
 * One behavior per test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import { getExecutionStore, clearStoreCache } from "../../orchestration/execution-store.ts";

import { resolveProgress } from "../../tools/prompt-pipeline/resolve-progress.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "resolve-progress-test-"));
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

function makeFlow(progress?: string): ResolvedFlow {
  return {
    name: "test",
    description: "test flow",
    entry: "start",
    states: {
      start: { type: "single", agent: "test-agent" },
      done: { type: "terminal" },
    },
    spawn_instructions: { start: "Do the thing" },
    progress,
  };
}

function makeCtx(workspace: string, overrides: Partial<PromptContext> = {}): PromptContext {
  const state: StateDefinition = { type: "single", agent: "test-agent" };
  const flow = makeFlow();
  return {
    input: {
      workspace,
      state_id: "start",
      flow,
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
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
      input: { workspace, state_id: "start", flow, variables: {} },
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
      flow: "test", task: "test", entry: "start", current_state: "start",
      base_commit: "abc", started: now, last_updated: now,
      branch: "main", sanitized: "main", created: now, tier: "small",
      flow_name: "test", slug: "test-slug",
    });
    store.appendProgress("## Progress: test");
    store.appendProgress("- [research] done: found something");

    const flow = makeFlow("${WORKSPACE}/progress.md");
    const ctx = makeCtx(workspace, {
      input: { workspace, state_id: "start", flow, variables: {} },
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
      flow: "test", task: "test", entry: "start", current_state: "start",
      base_commit: "abc", started: now, last_updated: now,
      branch: "main", sanitized: "main", created: now, tier: "small",
      flow_name: "test", slug: "test-slug",
    });
    // Progress content contains ${WORKSPACE} which could cause re-expansion
    store.appendProgress("Use ${WORKSPACE} for the path");

    const flow = makeFlow("${WORKSPACE}/progress.md");
    const ctx = makeCtx(workspace, {
      input: { workspace, state_id: "start", flow, variables: {} },
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
      input: { workspace, state_id: "start", flow, variables: {} },
    });

    const result = await resolveProgress(ctx);
    // When store returns empty string, progress is set to empty string (not undefined)
    expect(result.mergedVariables.progress).toBe("");
  });
});
