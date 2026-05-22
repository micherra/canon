/**
 * Tests for worktree-ops.ts
 *
 * Covers:
 * - createWorktree: creates a single worktree and branch for one task
 * - cleanupWorktrees: removes worktrees and branches best-effort
 * - getProjectDir: derives project dir from workspace path
 * - Integration: full create → modify files → cleanup cycle
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktrees, createWorktree, getProjectDir } from "../worktree-ops.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktree-ops-test-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test repo");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// getProjectDir

describe("getProjectDir", () => {
  it("strips .canon/workspaces/... suffix from workspace path", () => {
    const workspace = "/Users/alice/myproject/.canon/workspaces/feat--my-branch/slug-abc";
    expect(getProjectDir(workspace)).toBe("/Users/alice/myproject");
  });

  it("works with deeply nested .canon/workspaces paths", () => {
    const workspace = "/home/user/projects/deep/.canon/workspaces/wave-001/task-01-slug";
    expect(getProjectDir(workspace)).toBe("/home/user/projects/deep");
  });

  it("returns the path unchanged if .canon/workspaces not found", () => {
    const workspace = "/some/unrelated/path";
    expect(getProjectDir(workspace)).toBe("/some/unrelated/path");
  });
});

// createWorktree (single-task)

describe("createWorktree", () => {
  it("creates a worktree directory for the task", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const task = { task_id: "single-task-01" };
    const result = await createWorktree(task, projectDir);

    expect(existsSync(result.worktree_path)).toBe(true);
  });

  it("returns correct worktree_path and branch for the task", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const task = { task_id: "single-task-01" };
    const result = await createWorktree(task, projectDir);

    expect(result.task_id).toBe("single-task-01");
    expect(result.worktree_path).toBe(join(projectDir, ".canon", "worktrees", "single-task-01"));
    expect(result.branch).toBe("canon-task/single-task-01");
  });

  it("returns a single WaveWorktreeResult (not an array)", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const task = { task_id: "single-task-01" };
    const result = await createWorktree(task, projectDir);

    // Must be an object, not an array
    expect(Array.isArray(result)).toBe(false);
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("task_id");
    expect(result).toHaveProperty("worktree_path");
    expect(result).toHaveProperty("branch");
  });

  it("sanitizes task_id with special characters in branch name", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // Slashes in task_id would break git branch names — must be sanitized
    const task = { task_id: "task/with/slashes" };
    const result = await createWorktree(task, projectDir);

    expect(result.branch).toBe("canon-task/task-with-slashes");
    expect(result.worktree_path).toBe(join(projectDir, ".canon", "worktrees", "task-with-slashes"));
    expect(existsSync(result.worktree_path)).toBe(true);
  });

  it("sanitizes dot-dot sequences to prevent path traversal and invalid refs", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const task = { task_id: "a..b" };
    const result = await createWorktree(task, projectDir);

    expect(result.branch).toBe("canon-task/a-b");
    expect(result.worktree_path).toBe(join(projectDir, ".canon", "worktrees", "a-b"));
    expect(existsSync(result.worktree_path)).toBe(true);
  });

  it("throws on git failure (not a git repo)", async () => {
    const notAGitDir = makeTmpDir();
    const task = { task_id: "task-01" };

    await expect(createWorktree(task, notAGitDir)).rejects.toThrow(
      /Failed to create worktree for task task-01/,
    );
  });
});

// cleanupWorktrees

describe("cleanupWorktrees", () => {
  it("removes worktree directories after cleanup", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const worktree = await createWorktree({ task_id: "cleanup-01" }, projectDir);

    expect(existsSync(worktree.worktree_path)).toBe(true);

    await cleanupWorktrees([worktree], projectDir);

    expect(existsSync(worktree.worktree_path)).toBe(false);
  });

  it("returns removed count equal to number of tasks cleaned up", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const wt1 = await createWorktree({ task_id: "c-01" }, projectDir);
    const wt2 = await createWorktree({ task_id: "c-02" }, projectDir);

    const result = await cleanupWorktrees([wt1, wt2], projectDir);
    expect(result.removed).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("best-effort: does not throw when a worktree doesn't exist", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // Pass a fake worktree that was never created
    const fakeTasks = [
      {
        branch: "canon-task/nonexistent",
        task_id: "nonexistent",
        worktree_path: join(projectDir, ".canon", "worktrees", "nonexistent"),
      },
    ];

    // Should not throw
    const result = await cleanupWorktrees(fakeTasks, projectDir);
    // At minimum one error (worktree removal failed). Branch deletion may also fail.
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // removed can be 0 since it failed
    expect(result.removed).toBe(0);
  });

  it("cleans up multiple worktrees", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const wt1 = await createWorktree({ task_id: "multi-1" }, projectDir);
    const wt2 = await createWorktree({ task_id: "multi-2" }, projectDir);
    const wt3 = await createWorktree({ task_id: "multi-3" }, projectDir);
    const worktrees = [wt1, wt2, wt3];

    for (const wt of worktrees) {
      expect(existsSync(wt.worktree_path)).toBe(true);
    }

    await cleanupWorktrees(worktrees, projectDir);

    for (const wt of worktrees) {
      expect(existsSync(wt.worktree_path)).toBe(false);
    }
  });
});

// Integration: full create → modify → cleanup cycle

describe("Integration — create, modify, cleanup", () => {
  it("full lifecycle: create worktree, write files, cleanup", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // 1. Create worktree
    const worktree = await createWorktree({ task_id: "int-task-1" }, projectDir);
    expect(existsSync(worktree.worktree_path)).toBe(true);

    // 2. Write a file in the worktree
    writeFileSync(join(worktree.worktree_path, "result.txt"), "task output");
    expect(existsSync(join(worktree.worktree_path, "result.txt"))).toBe(true);

    // 3. Cleanup
    const cleanupResult = await cleanupWorktrees([worktree], projectDir);
    expect(cleanupResult.removed).toBe(1);
    expect(cleanupResult.errors).toHaveLength(0);

    expect(existsSync(worktree.worktree_path)).toBe(false);
  });
});
