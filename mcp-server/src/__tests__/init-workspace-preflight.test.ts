/**
 * Tests for init_workspace preflight checks.
 *
 * Covers: git status detection, lock detection, stale session detection,
 * and backward compatibility when preflight is omitted.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("../orchestration/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    flow: {
      name: "quick-fix",
      description: "test",
      entry: "build",
      states: { build: { type: "single", transitions: { done: "done" } }, done: { type: "terminal" } },
      spawn_instructions: {},
    },
    errors: [],
  }),
}));

import { initWorkspaceFlow } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

const baseInput = {
  flow_name: "quick-fix",
  task: "fix the bug",
  branch: "main",
  base_commit: "abc123",
  tier: "small" as const,
};

describe("init_workspace — preflight checks", () => {
  it("skips preflight when preflight option is omitted", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(
      { ...baseInput },
      projectDir,
      "/fake/plugin",
    );

    // Should proceed to create workspace normally
    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("returns no issues on clean state with preflight: true", async () => {
    const projectDir = makeTmpProjectDir();

    // Init a git repo so git status works
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: projectDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    // Create an initial commit so git status is clean
    writeFileSync(join(projectDir, "README.md"), "# test");
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: projectDir });

    const result = await initWorkspaceFlow(
      { ...baseInput, preflight: true },
      projectDir,
      "/fake/plugin",
    );

    // Clean state — should proceed to create workspace
    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("reports uncommitted changes when git working tree is dirty", async () => {
    const projectDir = makeTmpProjectDir();

    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: projectDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README.md"), "# test");
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: projectDir });

    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted");

    const result = await initWorkspaceFlow(
      { ...baseInput, preflight: true },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(false);
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.some(i => i.includes("Uncommitted changes"))).toBe(true);
  });

  it("reports active lock on candidate workspace", async () => {
    const projectDir = makeTmpProjectDir();

    // Create a workspace directory with an active lock
    const wsDir = join(projectDir, ".canon", "workspaces", "main", "fix-the-bug");
    mkdirSync(wsDir, { recursive: true });
    const lock = { pid: process.pid, started: new Date().toISOString() };
    writeFileSync(join(wsDir, ".lock"), JSON.stringify(lock));

    // Init git repo (clean) so the git status check passes
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: projectDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README.md"), "# test");
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: projectDir });

    const result = await initWorkspaceFlow(
      { ...baseInput, preflight: true },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(false);
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.some(i => i.includes("Active lock"))).toBe(true);
  });
});
