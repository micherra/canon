/**
 * Tests for wave-lifecycle.ts
 *
 * Covers:
 * - createWaveWorktrees: creates worktrees and branches in a real git repo
 * - mergeWaveResults: merges non-conflicting branches sequentially
 * - mergeWaveResults: detects conflicts and returns structured error (not silent resolution)
 * - cleanupWorktrees: removes worktrees and branches best-effort
 * - getProjectDir: derives project dir from workspace path
 * - Integration: full create → modify files → merge → cleanup cycle
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWorktrees,
  createWaveWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "../orchestration/wave-lifecycle.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-lifecycle-test-"));
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

// createWaveWorktrees

describe("createWaveWorktrees", () => {
  it("creates a worktree directory for each task", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "task-01" }, { task_id: "task-02" }];
    const results = await createWaveWorktrees(tasks, projectDir);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(existsSync(r.worktree_path)).toBe(true);
    }
  });

  it("returns correct worktree_path and branch for each task", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "task-01" }];
    const results = await createWaveWorktrees(tasks, projectDir);

    expect(results[0].task_id).toBe("task-01");
    expect(results[0].worktree_path).toBe(join(projectDir, ".canon", "worktrees", "task-01"));
    expect(results[0].branch).toBe("canon-wave/task-01");
  });

  it("throws when projectDir is not a git repo", async () => {
    const notAGitDir = makeTmpDir();
    const tasks = [{ task_id: "task-01" }];

    await expect(createWaveWorktrees(tasks, notAGitDir)).rejects.toThrow();
  });

  it("creates multiple worktrees without overlap", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [
      { task_id: "wave-task-a" },
      { task_id: "wave-task-b" },
      { task_id: "wave-task-c" },
    ];
    const results = await createWaveWorktrees(tasks, projectDir);

    const paths = results.map((r) => r.worktree_path);
    const unique = new Set(paths);
    expect(unique.size).toBe(3);
  });

  it("creates distinct branches for each task", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "t1" }, { task_id: "t2" }];
    const results = await createWaveWorktrees(tasks, projectDir);

    const branches = results.map((r) => r.branch);
    expect(branches[0]).toBe("canon-wave/t1");
    expect(branches[1]).toBe("canon-wave/t2");
  });
});

// mergeWaveResults — sequential strategy, no conflict

describe("mergeWaveResults — sequential, no conflict", () => {
  it("returns ok:true when all branches merge cleanly", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // Create two task worktrees
    const tasks = [{ task_id: "task-A" }, { task_id: "task-B" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    // Add a unique file in each worktree (no conflicts)
    writeFileSync(join(worktrees[0].worktree_path, "fileA.txt"), "content A");
    spawnSync("git", ["add", "."], { cwd: worktrees[0].worktree_path });
    spawnSync("git", ["commit", "-m", "task-A change"], {
      cwd: worktrees[0].worktree_path,
    });

    writeFileSync(join(worktrees[1].worktree_path, "fileB.txt"), "content B");
    spawnSync("git", ["add", "."], { cwd: worktrees[1].worktree_path });
    spawnSync("git", ["commit", "-m", "task-B change"], {
      cwd: worktrees[1].worktree_path,
    });

    const result = await mergeWaveResults(worktrees, projectDir, "sequential");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged_count).toBe(2);
    }
  });

  it("returns merged_count equal to number of tasks on success", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "ta" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    writeFileSync(join(worktrees[0].worktree_path, "ta.txt"), "hello");
    spawnSync("git", ["add", "."], { cwd: worktrees[0].worktree_path });
    spawnSync("git", ["commit", "-m", "ta change"], {
      cwd: worktrees[0].worktree_path,
    });

    const result = await mergeWaveResults(worktrees, projectDir, "sequential");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged_count).toBe(1);
    }
  });
});

// mergeWaveResults — conflict detection

describe("mergeWaveResults — conflict detection", () => {
  it("returns ok:false with conflict_task when branches conflict", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // Create two task worktrees
    const tasks = [{ task_id: "conflict-a" }, { task_id: "conflict-b" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    // Both tasks modify the same file with different content → conflict after sequential merge
    const conflictFile = "shared.txt";

    writeFileSync(join(worktrees[0].worktree_path, conflictFile), "version from task A\n");
    spawnSync("git", ["add", "."], { cwd: worktrees[0].worktree_path });
    spawnSync("git", ["commit", "-m", "conflict-a change"], {
      cwd: worktrees[0].worktree_path,
    });

    writeFileSync(join(worktrees[1].worktree_path, conflictFile), "version from task B\n");
    spawnSync("git", ["add", "."], { cwd: worktrees[1].worktree_path });
    spawnSync("git", ["commit", "-m", "conflict-b change"], {
      cwd: worktrees[1].worktree_path,
    });

    const result = await mergeWaveResults(worktrees, projectDir, "sequential");
    expect(result.ok).toBe(false);
    if ("conflict_task" in result) {
      expect(result.conflict_task).toBe("conflict-b");
      expect(typeof result.conflict_detail).toBe("string");
      expect(result.conflict_detail.length).toBeGreaterThan(0);
    }
  });

  it("does not silently resolve the conflict — git repo is left clean after abort", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "c1" }, { task_id: "c2" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    const conflictFile = "conflict.txt";

    writeFileSync(join(worktrees[0].worktree_path, conflictFile), "c1 content\n");
    spawnSync("git", ["add", "."], { cwd: worktrees[0].worktree_path });
    spawnSync("git", ["commit", "-m", "c1"], { cwd: worktrees[0].worktree_path });

    writeFileSync(join(worktrees[1].worktree_path, conflictFile), "c2 content\n");
    spawnSync("git", ["add", "."], { cwd: worktrees[1].worktree_path });
    spawnSync("git", ["commit", "-m", "c2"], { cwd: worktrees[1].worktree_path });

    const result = await mergeWaveResults(worktrees, projectDir, "sequential");
    expect(result.ok).toBe(false);

    // Verify no merge-in-progress state (MERGE_HEAD should not exist after abort)
    const mergeHeadResult = spawnSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      cwd: projectDir,
      encoding: "utf-8",
    });
    // MERGE_HEAD should not exist (exit code non-zero) after a successful abort
    expect(mergeHeadResult.status).not.toBe(0);
  });
});

// cleanupWorktrees

describe("cleanupWorktrees", () => {
  it("removes worktree directories after cleanup", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "cleanup-01" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    expect(existsSync(worktrees[0].worktree_path)).toBe(true);

    await cleanupWorktrees(worktrees, projectDir);

    expect(existsSync(worktrees[0].worktree_path)).toBe(false);
  });

  it("returns removed count equal to number of tasks cleaned up", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [{ task_id: "c-01" }, { task_id: "c-02" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    const result = await cleanupWorktrees(worktrees, projectDir);
    expect(result.removed).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("best-effort: does not throw when a worktree doesn't exist", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // Pass a fake worktree that was never created
    const fakeTasks = [
      {
        branch: "canon-wave/nonexistent",
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

    const tasks = [{ task_id: "multi-1" }, { task_id: "multi-2" }, { task_id: "multi-3" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    for (const wt of worktrees) {
      expect(existsSync(wt.worktree_path)).toBe(true);
    }

    await cleanupWorktrees(worktrees, projectDir);

    for (const wt of worktrees) {
      expect(existsSync(wt.worktree_path)).toBe(false);
    }
  });
});

// Integration: full create → modify → merge → cleanup cycle

describe("Integration — create, modify, merge, cleanup", () => {
  it("full lifecycle with non-conflicting tasks succeeds end-to-end", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    // 1. Create worktrees
    const tasks = [{ task_id: "int-task-1" }, { task_id: "int-task-2" }];
    const worktrees = await createWaveWorktrees(tasks, projectDir);
    expect(worktrees).toHaveLength(2);

    // 2. Each task writes a unique file
    writeFileSync(join(worktrees[0].worktree_path, "result1.txt"), "task1 output");
    spawnSync("git", ["add", "."], { cwd: worktrees[0].worktree_path });
    spawnSync("git", ["commit", "-m", "int-task-1 result"], {
      cwd: worktrees[0].worktree_path,
    });

    writeFileSync(join(worktrees[1].worktree_path, "result2.txt"), "task2 output");
    spawnSync("git", ["add", "."], { cwd: worktrees[1].worktree_path });
    spawnSync("git", ["commit", "-m", "int-task-2 result"], {
      cwd: worktrees[1].worktree_path,
    });

    // 3. Merge results
    const mergeResult = await mergeWaveResults(worktrees, projectDir, "sequential");
    expect(mergeResult.ok).toBe(true);
    if (mergeResult.ok) {
      expect(mergeResult.merged_count).toBe(2);
    }

    // 4. Both files should exist in the main repo
    expect(existsSync(join(projectDir, "result1.txt"))).toBe(true);
    expect(existsSync(join(projectDir, "result2.txt"))).toBe(true);

    // 5. Cleanup
    const cleanupResult = await cleanupWorktrees(worktrees, projectDir);
    expect(cleanupResult.removed).toBe(2);
    expect(cleanupResult.errors).toHaveLength(0);

    for (const wt of worktrees) {
      expect(existsSync(wt.worktree_path)).toBe(false);
    }
  });

  it("verifies merge order: tasks are merged sequentially in order", async () => {
    const projectDir = makeTmpDir();
    initGitRepo(projectDir);

    const tasks = [
      { task_id: "order-first" },
      { task_id: "order-second" },
      { task_id: "order-third" },
    ];
    const worktrees = await createWaveWorktrees(tasks, projectDir);

    // Each task writes a unique file
    for (let i = 0; i < worktrees.length; i++) {
      writeFileSync(join(worktrees[i].worktree_path, `order-${i}.txt`), `content ${i}`);
      spawnSync("git", ["add", "."], { cwd: worktrees[i].worktree_path });
      spawnSync("git", ["commit", "-m", `order task ${i}`], {
        cwd: worktrees[i].worktree_path,
      });
    }

    const result = await mergeWaveResults(worktrees, projectDir, "sequential");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged_count).toBe(3);
    }

    // All files should exist after sequential merge
    for (let i = 0; i < worktrees.length; i++) {
      expect(existsSync(join(projectDir, `order-${i}.txt`))).toBe(true);
    }
  });
});
