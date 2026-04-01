/**
 * Progress.md end-to-end wiring — unit tests
 *
 * Covers:
 * 1. initWorkspaceFlow seeds progress.md on new workspace creation
 * 2. getSpawnPrompt resolves ${progress} when flow.progress exists and progress.md is on disk
 * 3. getSpawnPrompt resolves ${progress} to empty string when progress.md does not exist
 * 4. getSpawnPrompt leaves ${progress} as literal when flow has no progress field
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Hoist mock for loadAndResolveFlow used by initWorkspaceFlow
// ---------------------------------------------------------------------------

vi.mock("../orchestration/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn(),
}));

import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import { getExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "progress-wiring-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow for progress wiring",
    entry: "implement",
    states: {
      implement: { type: "single", agent: "canon-implementor" },
      done: { type: "terminal" },
    },
    spawn_instructions: { implement: "Implement ${task}. Progress so far:\n${progress}" },
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. initWorkspaceFlow seeds progress.md on new workspace creation
// ---------------------------------------------------------------------------

describe("initWorkspaceFlow — progress.md seeding", () => {
  it("creates progress.md with task header on new workspace creation", async () => {
    const projectDir = makeTmpDir();
    const pluginDir = makeTmpDir();

    // Provide a minimal resolved flow to the mock
    const flow = makeFlow();
    vi.mocked(loadAndResolveFlow).mockResolvedValue(flow);

    const result = await initWorkspaceFlow(
      {
        flow_name: "test-flow",
        task: "Wire progress.md end-to-end",
        branch: "feat/test",
        base_commit: "abc123",
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
        flow_name: "test-flow",
        task: "My task",
        branch: "main",
        base_commit: "deadbeef",
        tier: "medium",
      },
      projectDir,
      pluginDir,
    );

    // Progress is stored in SQLite store — only the header line should be present
    const store = getExecutionStore(result.workspace);
    const progressContent = store.getProgress(100);
    const lines = progressContent.split("\n").filter(l => l.trim() !== "");
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
        flow_name: "test-flow",
        task: "Resumed task",
        branch: "feat/resume",
        base_commit: "aaa",
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
        flow_name: "test-flow",
        task: "Resumed task",
        branch: "feat/resume",
        base_commit: "aaa",
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

// ---------------------------------------------------------------------------
// 2. getSpawnPrompt resolves ${progress} when flow.progress exists and file is on disk
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — progress variable resolution", () => {
  it("injects progress.md contents as ${progress} when flow.progress path resolves to an existing file", async () => {
    const workspace = makeTmpDir();

    // Seed progress via store (getSpawnPrompt reads from store, not from file)
    // We need a valid store — seed with initExecution first
    const now = new Date().toISOString();
    const store = getExecutionStore(workspace);
    store.initExecution({
      flow: "test-flow", task: "my task", entry: "implement", current_state: "implement",
      base_commit: "abc123", started: now, last_updated: now,
      branch: "main", sanitized: "main", created: now, tier: "small",
      flow_name: "test-flow", slug: "test-slug",
    });
    store.appendProgress("## Progress: My task");
    store.appendProgress("- [research] done: found the solution");

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Implement the task.\n\nProgress:\n${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
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
      flow: "test-flow", task: "test", entry: "implement", current_state: "implement",
      base_commit: "abc123", started: now, last_updated: now,
      branch: "main", sanitized: "main", created: now, tier: "small",
      flow_name: "test-flow", slug: "test-slug",
    });
    store.appendProgress("## Progress: Path substitution test");

    const flow = makeFlow({
      // Path uses ${WORKSPACE} placeholder — must be resolved before readFile
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Run: ${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.prompts[0].prompt).toContain("Path substitution test");
  });

  // -------------------------------------------------------------------------
  // 3. getSpawnPrompt resolves ${progress} to empty string when file missing
  // -------------------------------------------------------------------------

  it("resolves ${progress} to empty string when progress.md does not exist", async () => {
    const workspace = makeTmpDir();
    // Do NOT write progress.md — file is absent

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Status: '${progress}'" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    // ${progress} substituted with empty string, not literal "${progress}"
    expect(result.prompts[0].prompt).toBe("Status: ''");
  });

  // -------------------------------------------------------------------------
  // 4. ${progress} is left as literal when flow has no progress field
  // -------------------------------------------------------------------------

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
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    // Without flow.progress, ${progress} is never resolved — stays literal
    expect(result.prompts[0].prompt).toBe("Current progress: ${progress}");
  });
});
