/**
 * Wave lifecycle — worktree creation, sequential merging, and cleanup.
 *
 * All git operations go through gitExecAsync from the git-adapter-async adapter.
 * Never import node:child_process directly in this module (subprocess-isolation rule).
 *
 * Merge conflicts are returned as structured errors — not silently resolved
 * (no-silent-failures rule). Only cleanup is best-effort (non-critical).
 */

import { join } from "node:path";
import { gitExecAsync } from "../adapters/git-adapter-async.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaveTask {
  task_id: string;
  branch_prefix?: string;
}

export interface WaveWorktreeResult {
  task_id: string;
  worktree_path: string;
  branch: string;
}

export type MergeStrategy = "sequential" | "rebase" | "squash";

export type MergeWaveResult =
  | { ok: true; merged_count: number }
  | {
      ok: false;
      merged_count: number;
      conflict_task: string;
      conflict_detail: string;
    };

export interface CleanupResult {
  removed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// getProjectDir
// ---------------------------------------------------------------------------

/**
 * Derives the project directory from a workspace path.
 *
 * Canon workspaces live at `{projectDir}/.canon/workspaces/...`.
 * Strip the `.canon/workspaces/...` suffix to get the project root.
 *
 * If the canonical suffix is not found, returns the workspace path unchanged.
 */
export function getProjectDir(workspace: string): string {
  const marker = "/.canon/workspaces/";
  const idx = workspace.indexOf(marker);
  if (idx === -1) {
    return workspace;
  }
  return workspace.slice(0, idx);
}

// ---------------------------------------------------------------------------
// createWaveWorktrees
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for each task in the wave.
 *
 * Worktree path: `{projectDir}/.canon/worktrees/{task_id}`
 * Branch name:   `canon-wave/{task_id}`
 *
 * Throws on git failure so the caller can surface the error immediately.
 */
export async function createWaveWorktrees(
  tasks: WaveTask[],
  projectDir: string
): Promise<WaveWorktreeResult[]> {
  const results: WaveWorktreeResult[] = [];

  for (const task of tasks) {
    const worktreePath = join(projectDir, ".canon", "worktrees", task.task_id);
    const branchName = `canon-wave/${task.task_id}`;

    const result = await gitExecAsync(
      ["worktree", "add", worktreePath, "-b", branchName, "HEAD"],
      projectDir
    );

    if (!result.ok) {
      throw new Error(
        `Failed to create worktree for task ${task.task_id}: ${result.stderr || result.stdout}`
      );
    }

    results.push({
      task_id: task.task_id,
      worktree_path: worktreePath,
      branch: branchName,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// mergeWaveResults
// ---------------------------------------------------------------------------

/**
 * Sequentially merge completed wave task branches into the current HEAD.
 *
 * On merge conflict: aborts the merge and returns a structured error.
 * Does NOT silently resolve conflicts.
 *
 * Currently only "sequential" strategy is implemented. The `mergeStrategy`
 * parameter is accepted for forward compatibility.
 */
export async function mergeWaveResults(
  tasks: WaveWorktreeResult[],
  projectDir: string,
  mergeStrategy: MergeStrategy
): Promise<MergeWaveResult> {
  let mergedCount = 0;

  for (const task of tasks) {
    const mergeResult = await gitExecAsync(
      ["merge", "--no-ff", task.branch],
      projectDir
    );

    if (!mergeResult.ok) {
      // Detect conflict vs. other failure
      const isConflict =
        mergeResult.stderr.includes("CONFLICT") ||
        mergeResult.stdout.includes("CONFLICT") ||
        mergeResult.stderr.includes("Automatic merge failed") ||
        mergeResult.stdout.includes("Automatic merge failed");

      if (isConflict) {
        // Abort the merge to leave the repo in a clean state
        await gitExecAsync(["merge", "--abort"], projectDir);
      }

      return {
        ok: false,
        merged_count: mergedCount,
        conflict_task: task.task_id,
        conflict_detail: mergeResult.stderr || mergeResult.stdout,
      };
    }

    mergedCount++;
  }

  return { ok: true, merged_count: mergedCount };
}

// ---------------------------------------------------------------------------
// cleanupWorktrees
// ---------------------------------------------------------------------------

/**
 * Best-effort removal of worktrees and their tracking branches.
 *
 * Failures are logged in the returned `errors` array but do not throw.
 * Cleanup is non-critical — partial success is acceptable.
 */
export async function cleanupWorktrees(
  tasks: WaveWorktreeResult[],
  projectDir: string
): Promise<CleanupResult> {
  let removed = 0;
  const errors: string[] = [];

  for (const task of tasks) {
    // Remove the worktree directory
    const removeResult = await gitExecAsync(
      ["worktree", "remove", task.worktree_path, "--force"],
      projectDir
    );

    if (!removeResult.ok) {
      errors.push(
        `worktree remove ${task.task_id}: ${removeResult.stderr || removeResult.stdout}`
      );
      // Try to delete branch even if worktree removal failed
      const branchResult = await gitExecAsync(
        ["branch", "-d", task.branch],
        projectDir
      );
      if (!branchResult.ok) {
        errors.push(
          `branch delete ${task.branch}: ${branchResult.stderr || branchResult.stdout}`
        );
      }
      continue;
    }

    // Delete the tracking branch
    const branchResult = await gitExecAsync(
      ["branch", "-d", task.branch],
      projectDir
    );

    if (!branchResult.ok) {
      // Non-critical: branch might already be merged or deleted
      errors.push(
        `branch delete ${task.branch}: ${branchResult.stderr || branchResult.stdout}`
      );
    }

    removed++;
  }

  return { removed, errors };
}
