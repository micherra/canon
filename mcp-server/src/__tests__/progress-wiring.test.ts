/**
 * Progress.md end-to-end wiring — unit tests
 *
 * Covers:
 * 1. initWorkspaceFlow seeds progress.md on new workspace creation
 * 2. getSpawnPrompt resolves ${progress} when flow.progress exists and progress.md is on disk
 * 3. getSpawnPrompt resolves ${progress} to empty string when progress.md does not exist
 * 4. getSpawnPrompt leaves ${progress} as literal when flow has no progress field
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Hoist mock for loadAndResolveFlow used by initWorkspaceFlow
// ---------------------------------------------------------------------------

vi.mock("../orchestration/flow-parser.js", () => ({
  loadAndResolveFlow: vi.fn(),
}));

import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
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
    vi.mocked(loadAndResolveFlow).mockResolvedValue({ flow, errors: [] });

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

    const progressPath = join(result.workspace, "progress.md");
    const contents = await readFile(progressPath, "utf-8");
    expect(contents).toContain("## Progress: Wire progress.md end-to-end");
  });

  it("progress.md starts with just the header line (no prior entries)", async () => {
    const projectDir = makeTmpDir();
    const pluginDir = makeTmpDir();

    const flow = makeFlow();
    vi.mocked(loadAndResolveFlow).mockResolvedValue({ flow, errors: [] });

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

    const progressPath = join(result.workspace, "progress.md");
    const contents = await readFile(progressPath, "utf-8");
    // Only one non-blank line — the header — no state entries yet
    const lines = contents.split("\n").filter(l => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("## Progress: My task");
  });

  it("does not create a second progress.md when workspace is resumed (created: false)", async () => {
    const projectDir = makeTmpDir();
    const pluginDir = makeTmpDir();
    const flow = makeFlow();

    // First creation
    vi.mocked(loadAndResolveFlow).mockResolvedValue({ flow, errors: [] });
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

    // Append a state line to simulate orchestrator progress
    const progressPath = join(first.workspace, "progress.md");
    await writeFile(progressPath, "## Progress: Resumed task\n\n- [implement] done: wired the thing\n", "utf-8");

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

    // progress.md must still contain the state line — not overwritten
    const contents = await readFile(progressPath, "utf-8");
    expect(contents).toContain("- [implement] done: wired the thing");
  });
});

// ---------------------------------------------------------------------------
// 2. getSpawnPrompt resolves ${progress} when flow.progress exists and file is on disk
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — progress variable resolution", () => {
  it("injects progress.md contents as ${progress} when flow.progress path resolves to an existing file", async () => {
    const workspace = makeTmpDir();

    const progressContent = "## Progress: My task\n\n- [research] done: found the solution\n";
    await writeFile(join(workspace, "progress.md"), progressContent, "utf-8");

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
    expect(result.prompts[0].prompt).toContain(progressContent.trim());
  });

  it("substitutes ${WORKSPACE} in the progress path before reading", async () => {
    const workspace = makeTmpDir();

    // Write progress.md at the workspace root
    await writeFile(join(workspace, "progress.md"), "## Progress: Path substitution test\n", "utf-8");

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
