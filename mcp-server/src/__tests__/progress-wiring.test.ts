/**
 * Progress.md end-to-end wiring — unit tests
 *
 * Covers:
 * 1. initWorkspaceFlow seeds progress.md on new workspace creation
 * 2. getSpawnPrompt resolves ${progress} when flow.progress exists and progress.md is on disk
 * 3. getSpawnPrompt resolves ${progress} to empty string when progress.md does not exist
 * 4. getSpawnPrompt leaves ${progress} as literal when flow has no progress field
 */

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mock for loadAndResolveFlow used by initWorkspaceFlow

vi.mock("../orchestration/flow-parser.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orchestration/flow-parser.ts")>();
  return {
    ...actual,
    loadAndResolveFlow: vi.fn(),
  };
});

import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "progress-wiring-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow for progress wiring",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: { implement: "Implement ${task}. Progress so far:\n${progress}" },
    states: {
      done: { type: "terminal" },
      implement: { agent: "canon-implementor", type: "single" },
    },
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// 1. initWorkspaceFlow seeds progress.md on new workspace creation

describe("initWorkspaceFlow — progress.md seeding", () => {
  it("creates progress.md with task header on new workspace creation", async () => {
    const projectDir = makeTmpDir();
    const pluginDir = makeTmpDir();

    // Provide a minimal resolved flow to the mock
    const flow = makeFlow();
    vi.mocked(loadAndResolveFlow).mockResolvedValue(flow);

    const result = await initWorkspaceFlow(
      {
        base_commit: "abc123",
        branch: "feat/test",
        flow_name: "test-flow",
        task: "Wire progress.md end-to-end",
        tier: "small",
      },
      projectDir,
      pluginDir,
    );

    expect(result.created).toBe(true);

    // Progress is stored in SQLite store, not on disk as progress.md
    const store = getExecutionStore(result.workspace);
    const progressContent = store.getProgress(100);
    expect(progressContent).toContain("## Progress: Wire progress.md end-to-end");
  });

  it("progress.md starts with just the header line (no prior entries)", async () => {
    const projectDir = makeTmpDir();
    const pluginDir = makeTmpDir();

    const flow = makeFlow();
    vi.mocked(loadAndResolveFlow).mockResolvedValue(flow);

    const result = await initWorkspaceFlow(
      {
        base_commit: "deadbeef",
        branch: "main",
        flow_name: "test-flow",
        task: "My task",
        tier: "medium",
      },
      projectDir,
      pluginDir,
    );

    // Progress is stored in SQLite store — only the header line should be present
    const store = getExecutionStore(result.workspace);
    const progressContent = store.getProgress(100);
    const lines = progressContent.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    // getProgress() prepends "- " to each stored line
    expect(lines[0]).toContain("## Progress: My task");
  });

  it("does not create a second progress.md when workspace is resumed (created: false)", async () => {
    const projectDir = makeTmpDir();
    const pluginDir = makeTmpDir();
    const flow = makeFlow();

    // First creation
    vi.mocked(loadAndResolveFlow).mockResolvedValue(flow);
    const first = await initWorkspaceFlow(
      {
        base_commit: "aaa",
        branch: "feat/resume",
        flow_name: "test-flow",
        task: "Resumed task",
        tier: "small",
      },
      projectDir,
      pluginDir,
    );
    expect(first.created).toBe(true);

    // Append a state line to simulate orchestrator progress (via store, not file)
    const storeForWorkspace = getExecutionStore(first.workspace);
    storeForWorkspace.appendProgress("- [implement] done: wired the thing");

    // Second call — same branch + task → resume
    const second = await initWorkspaceFlow(
      {
        base_commit: "aaa",
        branch: "feat/resume",
        flow_name: "test-flow",
        task: "Resumed task",
        tier: "small",
      },
      projectDir,
      pluginDir,
    );
    expect(second.created).toBe(false);

    // Progress entry must still be in the store — not overwritten
    const contents = getExecutionStore(second.workspace).getProgress(100);
    expect(contents).toContain("- [implement] done: wired the thing");
  });
});

// 2. getSpawnPrompt resolves ${progress} when flow.progress exists and file is on disk

describe("getSpawnPrompt — progress variable resolution", () => {
  it("injects progress.md contents as ${progress} when flow.progress path resolves to an existing file", async () => {
    const workspace = makeTmpDir();

    // Seed progress via store (getSpawnPrompt reads from store, not from file)
    // We need a valid store — seed with initExecution first
    const now = new Date().toISOString();
    const store = getExecutionStore(workspace);
    store.initExecution({
      base_commit: "abc123",
      branch: "main",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "main",
      slug: "test-slug",
      started: now,
      task: "my task",
      tier: "small",
    });
    store.appendProgress("## Progress: My task");
    store.appendProgress("- [research] done: found the solution");

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Implement the task.\n\nProgress:\n${progress}" },
    });

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].prompt).toContain("- [research] done: found the solution");
  });

  it("substitutes ${WORKSPACE} in the progress path before reading", async () => {
    const workspace = makeTmpDir();

    // Seed progress via store (getSpawnPrompt reads from store, not from file)
    const now = new Date().toISOString();
    const store = getExecutionStore(workspace);
    store.initExecution({
      base_commit: "abc123",
      branch: "main",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "main",
      slug: "test-slug",
      started: now,
      task: "test",
      tier: "small",
    });
    store.appendProgress("## Progress: Path substitution test");

    const flow = makeFlow({
      // Path uses ${WORKSPACE} placeholder — must be resolved before readFile
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Run: ${progress}" },
    });

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });

    expect(result.prompts[0].prompt).toContain("Path substitution test");
  });

  // 3. getSpawnPrompt resolves ${progress} to empty string when file missing

  it("resolves ${progress} to empty string when progress.md does not exist", async () => {
    const workspace = makeTmpDir();
    // Do NOT write progress.md — file is absent

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Status: '${progress}'" },
    });

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });

    // ${progress} substituted with empty string, not literal "${progress}"
    // The metrics footer is appended after the prompt body, so we check startsWith
    expect(result.prompts[0].prompt).toMatch(/^Status: ''/);
    expect(result.prompts[0].prompt).not.toContain("${progress}");
  });

  // 4. ${progress} is left as literal when flow has no progress field

  it("leaves ${progress} as literal text when flow has no progress field", async () => {
    const workspace = makeTmpDir();
    // Write a progress.md to confirm it's NOT being read
    await writeFile(join(workspace, "progress.md"), "## Progress: Should not appear\n", "utf-8");

    // Flow without progress field
    const flow = makeFlow({
      progress: undefined,
      spawn_instructions: { implement: "Current progress: ${progress}" },
    });

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });

    // Without flow.progress, ${progress} is never resolved — stays literal
    // The metrics footer is appended after the prompt body, so we check startsWith
    expect(result.prompts[0].prompt).toMatch(/^Current progress: \$\{progress\}/);
    expect(result.prompts[0].prompt).not.toContain("Should not appear");
  });
});
