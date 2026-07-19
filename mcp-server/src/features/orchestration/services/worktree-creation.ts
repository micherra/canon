/**
 * Fail-closed worktree creation for `init_workspace` (Approach B, DESIGN.md).
 *
 * `createWorktree` guarantees that success is never returned without the
 * worktree directory existing on disk. Any `git worktree add` failure, or a
 * git-reported success that produced nothing on disk (phantom success), is
 * returned as a typed `WORKTREE_CREATE_FAILED` error — never a throw
 * (ADR-002), never a silent empty object.
 */

import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { gitWorktreeAdd } from "@platform/adapters/git-adapter.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

export type WorktreeInfo = { worktree_path: string; worktree_branch: string };

/** Injectable seam for tests — default is the real adapter. Never `vi.mock`-ed. */
type CreateWorktreeDeps = {
  gitWorktreeAdd?: typeof gitWorktreeAdd;
};

/**
 * Create the build worktree fail-closed.
 *
 * Success GUARANTEES the directory exists on disk (dc-03 existence assertion).
 * Failure returns a `WORKTREE_CREATE_FAILED` error naming the git operation,
 * the branch, the path, the exit code, timeout status, and stderr (or an
 * explicit no-stderr-captured marker when stderr is empty).
 */
export function createWorktree(
  opts: {
    workspace: string;
    slug: string;
    baseCommit: string;
    projectDir: string;
  },
  deps: CreateWorktreeDeps = {},
): ToolResult<WorktreeInfo> {
  const { workspace, slug, baseCommit, projectDir } = opts;
  const worktreeAdd = deps.gitWorktreeAdd ?? gitWorktreeAdd;

  const worktreePath = join(workspace, "worktree");
  const worktreeBranch = `canon/${slug}`;

  const wtResult = worktreeAdd(worktreePath, projectDir, {
    baseCommit,
    branchName: worktreeBranch,
  });

  const context = {
    base_commit: baseCommit,
    exit_code: wtResult.exitCode,
    stderr: wtResult.stderr,
    timed_out: wtResult.timedOut,
    worktree_branch: worktreeBranch,
    worktree_path: worktreePath,
  };

  if (!wtResult.ok) {
    const stderr = wtResult.stderr.trim();
    const message =
      `git worktree add failed for branch "${worktreeBranch}" at ${worktreePath} ` +
      `(exit ${wtResult.exitCode}${wtResult.timedOut ? ", timed out" : ""}): ` +
      `${stderr || "<no stderr captured — possible spawn failure or timeout>"}`;
    return toolError("WORKTREE_CREATE_FAILED", message, true, context);
  }

  if (!existsSync(worktreePath)) {
    return toolError(
      "WORKTREE_CREATE_FAILED",
      `git worktree add reported success but the worktree directory does not exist on disk: ${worktreePath}`,
      false,
      context,
    );
  }

  linkWorktreeNodeModules(worktreePath, projectDir); // Guard 2 non-circular by construction

  return toolOk({ worktree_branch: worktreeBranch, worktree_path: worktreePath });
}

/**
 * Best-effort: symlink the worktree's mcp-server/node_modules to the main checkout's
 * resolved mcp-server/node_modules so the agent LSP tool resolves zod/vitest/.ts imports.
 * Lives in gitignored .canon/** — never enters the package (see ADR-0011). Non-blocking:
 * on any failure the build proceeds (LSP degrades). Skips if main node_modules is absent
 * or a node_modules already exists at the link site.
 *
 * Guard 2 (non-circular): target is realpathSync(main node_modules), which resolves to
 * an absolute path outside the worktree subtree — never circular.
 *
 * Relocated verbatim from tools/init-workspace.ts; re-exported there for the existing
 * symlink-test import.
 */
export function linkWorktreeNodeModules(worktreePath: string, projectDir: string): void {
  try {
    const mainNm = join(projectDir, "mcp-server", "node_modules");
    if (!existsSync(mainNm)) return; // main deps not installed → no-op
    const target = realpathSync(mainNm); // resolved, outside the worktree → non-circular (Guard 2)
    const linkSite = join(worktreePath, "mcp-server", "node_modules");
    try {
      // lstatSync does not follow symlinks — check if anything already exists at link site
      lstatSync(linkSite);
      return; // already present → do not clobber
    } catch {
      // ENOENT — link site does not exist, safe to create
    }
    symlinkSync(target, linkSite, "dir");
  } catch (err) {
    console.warn(
      "[init-workspace] node_modules symlink skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}
