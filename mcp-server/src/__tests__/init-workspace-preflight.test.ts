/**
 * Tests for init_workspace preflight checks.
 *
 * Covers: git status detection, stale session detection,
 * and backward compatibility when preflight is omitted.
 *
 * Note: .lock file detection removed 2026-03-30 — SQLite WAL handles
 * write serialization; file-based locking is no longer used.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("../orchestration/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    name: "quick-fix",
    description: "test",
    entry: "build",
    states: { build: { type: "single", transitions: { done: "done" } }, done: { type: "terminal" } },
    spawn_instructions: {},
  }),
}));

import { initWorkspaceFlow } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Create a tmp dir with an initialized git repo (clean working tree). */
async function makeTmpGitRepo(): Promise<string> {
  const projectDir = makeTmpProjectDir();
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init"], { cwd: projectDir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
  writeFileSync(join(projectDir, "README.md"), "# test");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: projectDir });
  return projectDir;
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
    const result = await initWorkspaceFlow({ ...baseInput }, projectDir, "/fake/plugin");

    // Should proceed to create workspace normally
    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("returns no issues on clean state with preflight: true", async () => {
    const projectDir = await makeTmpGitRepo();

    const result = await initWorkspaceFlow({ ...baseInput, preflight: true }, projectDir, "/fake/plugin");

    // Clean state — should proceed to create workspace
    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("reports uncommitted changes when git working tree is dirty", async () => {
    const projectDir = await makeTmpGitRepo();

    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted");

    const result = await initWorkspaceFlow({ ...baseInput, preflight: true }, projectDir, "/fake/plugin");

    expect(result.created).toBe(false);
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.some((i) => i.includes("Uncommitted changes"))).toBe(true);
  });

  it("returns empty workspace and candidate_workspace when preflight has issues", async () => {
    const projectDir = await makeTmpGitRepo();

    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted");

    const result = await initWorkspaceFlow({ ...baseInput, preflight: true }, projectDir, "/fake/plugin");

    // workspace must be empty string (not a real path) when preflight fails
    expect(result.workspace).toBe("");
    // candidate_workspace holds the would-be path
    expect(result.candidate_workspace).toBeDefined();
    expect(result.candidate_workspace).toContain("fix-the-bug");
    // preflight_issues explains why
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.length).toBeGreaterThan(0);
  });

  it("workspace contains path and candidate_workspace is undefined when preflight passes", async () => {
    const projectDir = await makeTmpGitRepo();

    const result = await initWorkspaceFlow({ ...baseInput, preflight: true }, projectDir, "/fake/plugin");

    // When preflight passes, workspace is set and candidate_workspace is not
    expect(result.workspace).toBeTruthy();
    expect(result.candidate_workspace).toBeUndefined();
    expect(result.created).toBe(true);
  });

  it("does not report a lock issue even when .lock file exists (SQLite handles concurrency)", async () => {
    const projectDir = makeTmpProjectDir();

    // Create a workspace directory with a .lock file (legacy artifact)
    const wsDir = join(projectDir, ".canon", "workspaces", "main", "fix-the-bug");
    mkdirSync(wsDir, { recursive: true });
    const lock = { pid: process.pid, started: new Date().toISOString() };
    writeFileSync(join(wsDir, ".lock"), JSON.stringify(lock));

    // Init git repo (clean) so the git status check passes
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: projectDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["commit", "-m", "init", "--allow-empty"], { cwd: projectDir });

    const result = await initWorkspaceFlow({ ...baseInput, preflight: true }, projectDir, "/fake/plugin");

    // .lock file is ignored — SQLite WAL handles concurrency
    // The workspace may be created (no lock issues reported)
    expect(result.preflight_issues?.some(i => i.includes("lock"))).toBeFalsy();
  });
});
