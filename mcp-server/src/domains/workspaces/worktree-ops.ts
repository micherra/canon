/**
 * Worktree operations — worktree creation, sequential merging, and cleanup.
 *
 * All git operations go through gitExecAsync from the git-adapter-async adapter.
 * Never import node:child_process directly in this module (subprocess-isolation rule).
 *
 * Merge conflicts are returned as structured errors — not silently resolved
 * (no-silent-failures rule). Only cleanup is best-effort (non-critical).
 */

import { join } from "node:path";
import { gitExecAsync } from "@platform/adapters/git-adapter-async.ts";

export type WaveTask = {
  task_id: string;
  branch_prefix?: string;
};

export type WaveWorktreeResult = {
  task_id: string;
  worktree_path: string;
  branch: string;
};

export type CleanupResult = {
  removed: number;
  errors: string[];
};

// getProjectDir

/**
 * Derives the project directory from a workspace path.
 *
 * Canon workspaces live at `{projectDir}/.canon/workspaces/...`.
 * Strip the `.canon/workspaces/...` suffix to get the project root.
 *
 * If the canonical suffix is not found, returns the workspace path unchanged.
 */
export function getProjectDir(workspace: string): string {
  // Check both POSIX and Windows path separators for cross-platform support.
  const posixMarker = "/.canon/workspaces/";
  const windowsMarker = "\\.canon\\workspaces\\";

  let idx = workspace.indexOf(posixMarker);
  if (idx !== -1) {
    return workspace.slice(0, idx);
  }

  idx = workspace.indexOf(windowsMarker);
  if (idx !== -1) {
    return workspace.slice(0, idx);
  }

  return workspace;
}

// createWorktree / createWorktrees

/**
 * Sanitize a task_id for safe use in filesystem paths and git branch names.
 * Uses an allowlist: only alphanumeric, hyphens, underscores, and dots pass through.
 * Everything else (including characters invalid per git-check-ref-format like
 * colons, tildes, carets, and control chars) is replaced with a dash.
 * Also handles git-ref-format rules: no ".." sequences, no trailing dot/".lock".
 * Rejects dot-only segments (".", "..") to prevent path traversal.
 */
function sanitizeTaskId(taskId: string): string {
  let sanitized = taskId
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/\.lock$/i, "-lock")
    .replace(/\.$/, "-");
  if (sanitized === "" || sanitized === ".") {
    sanitized = "task-unnamed";
  }
  return sanitized;
}

/**
 * Create a git worktree for a single task.
 * Worktree path: `{projectDir}/.canon/worktrees/{task_id}`
 * Branch name:   `canon-task/{task_id}`
 * Throws on git failure.
 */
export async function createWorktree(
  task: WaveTask,
  projectDir: string,
  baseCwd?: string,
): Promise<WaveWorktreeResult> {
  const safeTaskId = sanitizeTaskId(task.task_id);
  const worktreePath = join(projectDir, ".canon", "worktrees", safeTaskId);
  const branchName = `canon-task/${safeTaskId}`;
  const gitBaseCwd = baseCwd ?? projectDir;

  const result = await gitExecAsync(
    ["worktree", "add", worktreePath, "-b", branchName, "HEAD"],
    gitBaseCwd,
  );

  if (!result.ok) {
    throw new Error(
      `Failed to create worktree for task ${task.task_id}: ${result.stderr || result.stdout}`,
    );
  }

  return {
    branch: branchName,
    task_id: task.task_id,
    worktree_path: worktreePath,
  };
}

// cleanupWorktrees

/**
 * Best-effort removal of worktrees and their tracking branches.
 *
 * Failures are logged in the returned `errors` array but do not throw.
 * Cleanup is non-critical — partial success is acceptable.
 */
export async function cleanupWorktrees(
  tasks: WaveWorktreeResult[],
  projectDir: string,
): Promise<CleanupResult> {
  let removed = 0;
  const errors: string[] = [];

  for (const task of tasks) {
    // Remove the worktree directory
    // biome-ignore lint/performance/noAwaitInLoops: best-effort cleanup with per-task error accumulation; sequential to avoid git lock contention
    const removeResult = await gitExecAsync(
      ["worktree", "remove", task.worktree_path, "--force"],
      projectDir,
    );

    if (!removeResult.ok) {
      errors.push(`worktree remove ${task.task_id}: ${removeResult.stderr || removeResult.stdout}`);
      // Try to delete branch even if worktree removal failed
      const branchResult = await gitExecAsync(["branch", "-d", task.branch], projectDir);
      if (!branchResult.ok) {
        errors.push(`branch delete ${task.branch}: ${branchResult.stderr || branchResult.stdout}`);
      }
      continue;
    }

    // Delete the tracking branch
    const branchResult = await gitExecAsync(["branch", "-d", task.branch], projectDir);

    if (!branchResult.ok) {
      // Non-critical: branch might already be merged or deleted
      errors.push(`branch delete ${task.branch}: ${branchResult.stderr || branchResult.stdout}`);
    }

    removed++;
  }

  return { errors, removed };
}
