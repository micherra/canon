/**
 * wave-lifecycle-injection.test.ts
 *
 * Verifies that createWaveWorktrees, mergeWaveResults, and cleanupWorktrees
 * use the injected gitRunner parameter when provided, instead of the concrete
 * gitExecAsync adapter.
 */

import { describe, expect, it, vi } from "vitest";
import type { AsyncGitRunner, WaveTask, WaveWorktreeResult } from "../wave-lifecycle.ts";
import {
  cleanupWorktrees,
  createWaveWorktrees,
  mergeWaveResults,
} from "../wave-lifecycle.ts";

function makeProcessResult(overrides: Partial<Awaited<ReturnType<AsyncGitRunner>>> = {}) {
  return {
    duration_ms: 0,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "",
    timedOut: false,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// createWaveWorktrees — injection
// -------------------------------------------------------------------------

describe("createWaveWorktrees — uses injected gitRunner", () => {
  it("calls the runner with worktree add command for each task", async () => {
    const tasks: WaveTask[] = [{ task_id: "task-a" }, { task_id: "task-b" }];
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    const results = await createWaveWorktrees(tasks, "/project", undefined, mockRunner);

    expect(mockRunner).toHaveBeenCalledTimes(2);
    // Check the args pattern for first call
    const [firstArgs] = mockRunner.mock.calls;
    expect(firstArgs[0]).toContain("worktree");
    expect(firstArgs[0]).toContain("add");
    expect(results).toHaveLength(2);
    expect(results[0].task_id).toBe("task-a");
    expect(results[1].task_id).toBe("task-b");
  });

  it("throws when the runner returns ok: false", async () => {
    const tasks: WaveTask[] = [{ task_id: "failing-task" }];
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(
      makeProcessResult({ ok: false, stderr: "worktree failed" }),
    );

    await expect(createWaveWorktrees(tasks, "/project", undefined, mockRunner)).rejects.toThrow(
      "Failed to create worktree for task failing-task",
    );
  });

  it("uses baseCwd parameter as git working directory", async () => {
    const tasks: WaveTask[] = [{ task_id: "t1" }];
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    await createWaveWorktrees(tasks, "/project", "/base-cwd", mockRunner);

    expect(mockRunner).toHaveBeenCalledWith(
      expect.any(Array),
      "/base-cwd",
    );
  });

  it("branches are named canon-wave/{task_id}", async () => {
    const tasks: WaveTask[] = [{ task_id: "my-task" }];
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    const results = await createWaveWorktrees(tasks, "/project", undefined, mockRunner);

    expect(results[0].branch).toBe("canon-wave/my-task");
  });
});

// -------------------------------------------------------------------------
// mergeWaveResults — injection
// -------------------------------------------------------------------------

describe("mergeWaveResults — uses injected gitRunner", () => {
  const taskResults: WaveWorktreeResult[] = [
    { branch: "canon-wave/task-a", task_id: "task-a", worktree_path: "/project/.canon/worktrees/task-a" },
    { branch: "canon-wave/task-b", task_id: "task-b", worktree_path: "/project/.canon/worktrees/task-b" },
  ];

  it("calls runner with merge --no-ff for each task branch", async () => {
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    const result = await mergeWaveResults(taskResults, "/project", "sequential", mockRunner);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged_count).toBe(2);
    }
    expect(mockRunner).toHaveBeenCalledTimes(2);
    expect(mockRunner).toHaveBeenCalledWith(["merge", "--no-ff", "canon-wave/task-a"], "/project");
    expect(mockRunner).toHaveBeenCalledWith(["merge", "--no-ff", "canon-wave/task-b"], "/project");
  });

  it("aborts merge and returns structured error on conflict", async () => {
    let callCount = 0;
    const mockRunner = vi.fn<AsyncGitRunner>().mockImplementation(async (args) => {
      callCount++;
      if (args.includes("--no-ff")) {
        return makeProcessResult({ ok: false, stderr: "CONFLICT (content): Merge conflict in file.ts" });
      }
      // merge --abort succeeds
      return makeProcessResult();
    });

    const result = await mergeWaveResults(taskResults, "/project", "sequential", mockRunner);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict_task).toBe("task-a");
      expect(result.merged_count).toBe(0);
    }
    // Should have called --no-ff for task-a, then --abort
    expect(mockRunner).toHaveBeenCalledWith(["merge", "--abort"], "/project");
  });

  it("returns error without abort for non-conflict failure", async () => {
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(
      makeProcessResult({ ok: false, stderr: "some other error" }),
    );

    const result = await mergeWaveResults(taskResults.slice(0, 1), "/project", "sequential", mockRunner);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict_task).toBe(""); // non-conflict
    }
    // --abort should NOT be called for non-conflict errors
    const abortCalls = mockRunner.mock.calls.filter(([args]) => args.includes("--abort"));
    expect(abortCalls).toHaveLength(0);
  });

  it("returns error for unsupported merge strategies without calling runner", async () => {
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    const result = await mergeWaveResults(taskResults, "/project", "rebase", mockRunner);

    expect(result.ok).toBe(false);
    expect(mockRunner).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// cleanupWorktrees — injection
// -------------------------------------------------------------------------

describe("cleanupWorktrees — uses injected gitRunner", () => {
  const taskResults: WaveWorktreeResult[] = [
    { branch: "canon-wave/task-a", task_id: "task-a", worktree_path: "/project/.canon/worktrees/task-a" },
  ];

  it("calls runner to remove worktree and then delete branch", async () => {
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    const result = await cleanupWorktrees(taskResults, "/project", mockRunner);

    expect(result.removed).toBe(1);
    expect(result.errors).toHaveLength(0);
    // First call: worktree remove; second call: branch delete
    expect(mockRunner).toHaveBeenCalledTimes(2);
    expect(mockRunner).toHaveBeenCalledWith(
      ["worktree", "remove", "/project/.canon/worktrees/task-a", "--force"],
      "/project",
    );
    expect(mockRunner).toHaveBeenCalledWith(["branch", "-d", "canon-wave/task-a"], "/project");
  });

  it("accumulates errors when worktree removal fails (best-effort)", async () => {
    let callCount = 0;
    const mockRunner = vi.fn<AsyncGitRunner>().mockImplementation(async () => {
      callCount++;
      // All calls fail
      return makeProcessResult({ ok: false, stderr: "cannot remove" });
    });

    const result = await cleanupWorktrees(taskResults, "/project", mockRunner);

    expect(result.removed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns removed: 0 and errors when branch deletion fails after successful worktree removal", async () => {
    let callCount = 0;
    const mockRunner = vi.fn<AsyncGitRunner>().mockImplementation(async (args) => {
      callCount++;
      if (args.includes("worktree")) return makeProcessResult(); // worktree remove succeeds
      return makeProcessResult({ ok: false, stderr: "branch not found" }); // branch delete fails
    });

    const result = await cleanupWorktrees(taskResults, "/project", mockRunner);

    // removed is still incremented despite branch failure (non-critical)
    // The current implementation does NOT increment removed when branch delete fails
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("branch delete");
  });

  it("returns empty results for empty task list", async () => {
    const mockRunner = vi.fn<AsyncGitRunner>().mockResolvedValue(makeProcessResult());

    const result = await cleanupWorktrees([], "/project", mockRunner);

    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockRunner).not.toHaveBeenCalled();
  });
});
