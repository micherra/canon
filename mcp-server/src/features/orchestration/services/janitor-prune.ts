/**
 * Janitor prune helpers — orphaned agent-worktree pruning + empty husk-dir removal.
 *
 * Relocated out of janitor.ts (line-count remediation, decisions-corpus build,
 * ADR-0040) — a pure move, no behavior change. Covers:
 *   - prune_worktrees: remove orphaned agent isolation worktrees from .claude/worktrees/
 *   - prune_husk_dirs: remove empty top-level branch directories under .canon/workspaces/
 *
 * `listDir` and `buildPruneResult` are also used by janitor.ts's prune_workspaces
 * task (findPruneCandidates / cleanupEmptyBranchDir) — exported here rather than
 * duplicated.
 *
 * Canon principles:
 *   - no-silent-failures: every task records its outcome with status and detail
 *   - define-errors-out-of-existence: missing dir = skip
 */

import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import type { JanitorTaskResult } from "./janitor.ts";

/**
 * Parse git worktree list output into a Set of absolute worktree paths.
 *
 * `git worktree list` outputs lines like:
 *   /path/to/worktree  <hash>  [branch]
 *   /path/to/worktree  <hash>  (detached HEAD)
 *
 * We extract only the first field (the path) from each line.
 */
export function parseWorktreePaths(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // First whitespace-delimited token is the path
    const spaceIdx = trimmed.search(/\s/);
    const worktreePath = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    if (worktreePath) paths.add(worktreePath);
  }
  return paths;
}

/**
 * List directory entries under a given path.
 * Returns null when the directory does not exist or cannot be read.
 * Treats ENOENT as expected (returns null); re-throws unexpected errors.
 */
export function listDir(dirPath: string): string[] | null {
  try {
    return readdirSync(dirPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function removeEntries(
  targetDir: string,
  shouldRemove: (entry: string, entryPath: string) => boolean,
): { pruned: number; errors: string[] } {
  const pruned = { errors: [] as string[], pruned: 0 };
  const entries = listDir(targetDir);
  if (entries === null) return pruned;

  for (const entry of entries) {
    const entryPath = join(targetDir, entry);
    if (!shouldRemove(entry, entryPath)) continue;
    try {
      rmSync(entryPath, { force: true, recursive: true });
      pruned.pruned++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pruned.errors.push(`${entry}: ${message}`);
    }
  }
  return pruned;
}

export function buildPruneResult(
  pruned: number,
  errors: string[],
  noun: string,
  noneMessage: string,
): JanitorTaskResult {
  if (errors.length > 0 && pruned === 0) {
    return { detail: errors.join("; "), status: "error" };
  }
  if (pruned === 0) {
    return { detail: noneMessage, status: "skipped" };
  }
  const base = `pruned ${pruned} ${noun}`;
  return {
    detail: errors.length > 0 ? `${base}; errors: ${errors.join("; ")}` : base,
    status: "success",
  };
}

export function pruneWorktreesTask(projectDir: string): JanitorTaskResult {
  const agentWorktreesDir = join(projectDir, ".claude", "worktrees");

  if (listDir(agentWorktreesDir) === null) {
    return { detail: "no agent worktrees directory or empty", status: "skipped" };
  }

  const listResult = gitExec(["worktree", "list"], projectDir);
  if (!listResult.ok) {
    return { detail: `git worktree list failed: ${listResult.stderr.trim()}`, status: "error" };
  }

  const validPaths = parseWorktreePaths(listResult.stdout);
  const { pruned, errors } = removeEntries(
    agentWorktreesDir,
    (_entry, entryPath) => !validPaths.has(entryPath),
  );

  return buildPruneResult(pruned, errors, "worktree(s)", "no orphaned agent worktrees found");
}

/**
 * Prune completely empty top-level branch directories under `.canon/workspaces/`.
 *
 * These are "husk" directories left behind after all their slug workspaces were
 * previously removed (e.g., by `finalize_workspace` or prior janitor runs). They
 * contain zero entries and are safe to delete — an empty directory cannot be an
 * ancestor of any git-registered worktree.
 *
 * Removal uses `rmdirSync` — the kernel-level empty-directory primitive that
 * atomically fails ENOTEMPTY when the directory is non-empty (TOCTOU safety).
 */

/** Returns true when `entryPath` is an empty directory (a husk candidate). */
export function isEmptyBranchDir(entryPath: string): boolean {
  let isDir: boolean;
  try {
    isDir = lstatSync(entryPath).isDirectory();
  } catch {
    return false;
  }
  if (!isDir) return false;
  const contents = listDir(entryPath);
  return contents !== null && contents.length === 0;
}

export function pruneHuskDirsTask(canonDir: string): JanitorTaskResult {
  const canonWorkspacesDir = join(canonDir, "workspaces");
  const branchEntries = listDir(canonWorkspacesDir);
  if (branchEntries === null) {
    return { detail: "no workspaces directory or empty", status: "skipped" };
  }

  let pruned = 0;
  const errors: string[] = [];

  for (const entry of branchEntries) {
    const entryPath = join(canonWorkspacesDir, entry);
    if (!isEmptyBranchDir(entryPath)) continue;

    try {
      rmdirSync(entryPath);
      pruned++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${entry}: ${message}`);
    }
  }

  return buildPruneResult(pruned, errors, "empty branch dir(s)", "no empty branch dirs found");
}
