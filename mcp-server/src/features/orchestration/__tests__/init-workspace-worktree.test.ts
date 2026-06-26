/**
 * Tests for init_workspace worktree creation.
 *
 * Covers:
 * - New workspace creation returns worktree_path and worktree_branch
 * - Resume with existing worktree returns the path
 * - Resume with missing worktree returns undefined
 * - Preflight-only calls do NOT create worktrees
 * - Worktree creation failure falls back gracefully (no worktree_path)
 * - Backward compat: existing callers that don't use worktree_path still work
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("@domains/flows/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    description: "test",
    entry: "build",
    name: "fast-path",
    spawn_instructions: {},
    states: {
      build: { transitions: { done: "done" }, type: "single" },
      done: { type: "terminal" },
    },
  }),
}));

import { initWorkspaceFlow } from "../tools/init-workspace.ts";

// Scope: Tests worktree creation, resume detection, legacy path fallback, preflight-skips-worktree, and graceful failure when not in a git repo.

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-ws-worktree-test-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): string {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

  // Get HEAD commit
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return result.stdout.trim();
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

const baseInput = {
  base_commit: "abc123",
  branch: "main",
  flow_name: "fast-path",
  // Real single-session id so create-then-resume re-acquires its own mutex
  // (same-session re-entry); omitted ids no longer match (workspace-lock P1 #2).
  session_id: "session-fixture",
  task: "fix the bug",
  tier: "small" as const,
};

// New workspace: worktree creation

describe("initWorkspaceFlow — worktree creation on new workspace", () => {
  it("returns worktree_path pointing inside {workspace}/worktree", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.worktree_path).toBeDefined();
    // New path: {workspace}/worktree (not .canon/worktrees/{slug})
    expect(result.worktree_path).toContain("/worktree");
    expect(result.worktree_path).toContain(result.workspace);
    expect(result.worktree_path).not.toContain(".canon/worktrees/");
  });

  it("returns worktree_branch matching canon/{slug}", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.worktree_branch).toBe(`canon/${result.slug}`);
  });

  it("actually creates the worktree directory on disk", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.worktree_path).toBeDefined();
    expect(existsSync(result.worktree_path!)).toBe(true);
  });

  it("persists worktree_path and worktree_branch in session metadata", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.session.worktree_path).toBe(result.worktree_path);
    expect(result.session.worktree_branch).toBe(result.worktree_branch);
  });
});

// Resume: worktree detection

describe("initWorkspaceFlow — resume with existing worktree", () => {
  it("returns worktree_path when worktree still exists", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    // Create workspace first
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(first.created).toBe(true);
    expect(first.worktree_path).toBeDefined();

    // Resume — worktree should still exist
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeDefined();
    expect(second.worktree_path).toBe(first.worktree_path);
  });

  it("returns undefined worktree_path when worktree has been deleted", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    // Create workspace first
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(first.created).toBe(true);

    // Forcibly remove the worktree directory (simulating manual removal)
    if (first.worktree_path && existsSync(first.worktree_path)) {
      // We need to remove the worktree properly to avoid git worktree list issues
      spawnSync("git", ["worktree", "remove", "--force", first.worktree_path], { cwd: projectDir });
    }

    // Resume — worktree should be detected as missing
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeUndefined();
    expect(second.worktree_branch).toBeUndefined();
  });
});

// Preflight-only: no worktree creation

describe("initWorkspaceFlow — preflight skips worktree creation", () => {
  it("does not create a worktree when preflight returns issues", async () => {
    const projectDir = makeTmpProjectDir();

    // Set up a dirty git repo so preflight returns issues
    spawnSync("git", ["init"], { cwd: projectDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README.md"), "# test");
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: projectDir });
    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted change");

    const result = await initWorkspaceFlow(
      { ...baseInput, preflight: true },
      projectDir,
      "/fake/plugin",
    );

    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.length).toBeGreaterThan(0);

    // No worktree should exist at new path (preflight returns empty workspace path)
    // When preflight fails, result.workspace is "" — so we just verify worktree_path is absent
    expect(result.worktree_path).toBeUndefined();
  });
});

// Graceful fallback when worktree creation fails

describe("initWorkspaceFlow — worktree creation failure fallback", () => {
  it("returns result without worktree_path when not in a git repo", async () => {
    // projectDir has no git repo — worktree add will fail
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    // Workspace should be created normally
    expect(result.created).toBe(true);
    expect(result.workspace).toBeTruthy();
    expect(result.board).toBeDefined();
    expect(result.session).toBeDefined();

    // Worktree creation silently failed — no worktree_path returned
    expect(result.worktree_path).toBeUndefined();
    expect(result.worktree_branch).toBeUndefined();
  });
});

// Backward compat: existing behavior preserved

describe("initWorkspaceFlow — backward compat", () => {
  it("returns all existing fields regardless of worktree presence", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    // Original fields still present
    expect(result.workspace).toBeTruthy();
    expect(result.slug).toBeTruthy();
    expect(result.board).toBeDefined();
    expect(result.session).toBeDefined();
    expect(result.created).toBe(true);

    // worktree_path is optional — callers that ignore it still work
    // (value may be string or undefined — both acceptable)
    expect(typeof result.worktree_path === "string" || result.worktree_path === undefined).toBe(
      true,
    );
  });
});

// New worktree path: {workspace}/worktree

describe("initWorkspaceFlow — worktree at {workspace}/worktree (new location)", () => {
  it("places worktree inside workspace directory, not .canon/worktrees/", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.worktree_path).toBeDefined();
    // Must be inside the workspace directory
    expect(result.worktree_path).toContain(result.workspace);
    // Must end with /worktree
    expect(result.worktree_path).toBe(join(result.workspace, "worktree"));
    // Must NOT use old .canon/worktrees/ path
    expect(result.worktree_path).not.toContain(".canon/worktrees/");
  });

  it("actually creates the worktree directory at {workspace}/worktree", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.worktree_path).toBeDefined();
    expect(existsSync(result.worktree_path!)).toBe(true);
    expect(result.worktree_path).toBe(join(result.workspace, "worktree"));
  });

  it("resume finds worktree at {workspace}/worktree (new location)", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    // Create workspace first
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(first.created).toBe(true);
    expect(first.worktree_path).toBe(join(first.workspace, "worktree"));

    // Resume — should find the worktree at {workspace}/worktree
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeDefined();
    expect(second.worktree_path).toBe(join(second.workspace, "worktree"));
    expect(second.worktree_path).toBe(first.worktree_path);
  });

  it("resume falls back to .canon/worktrees/{slug} for old workspaces", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitRepo(projectDir);

    // Create workspace at new location first, then simulate an "old" workspace
    // by creating a worktree at the legacy path and pointing the session there
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(first.created).toBe(true);

    // Simulate old path: move the worktree from new to old location
    // Remove new worktree and create one at the legacy path
    const legacyPath = join(projectDir, ".canon", "worktrees", first.slug);
    if (first.worktree_path && existsSync(first.worktree_path)) {
      spawnSync("git", ["worktree", "remove", "--force", first.worktree_path], { cwd: projectDir });
    }
    // Create legacy worktree manually at old path
    const { mkdirSync } = await import("node:fs");
    mkdirSync(legacyPath, { recursive: true });
    spawnSync("git", ["worktree", "add", "--detach", legacyPath, baseCommit], { cwd: projectDir });

    // Clear the persisted worktree_path from the session (simulate old workspace with no persisted path)
    const { getExecutionStore } = await import("@domains/workspaces/execution-store-cache.ts");
    const store = getExecutionStore(first.workspace);
    store.updateExecution({
      worktree_branch: null as unknown as string,
      worktree_path: null as unknown as string,
    });

    // Resume — should fall back to legacy path
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeDefined();
    expect(second.worktree_path).toBe(legacyPath);
  });
});
