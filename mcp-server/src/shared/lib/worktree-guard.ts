import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "./tool-result.ts";

/**
 * Pure helper: returns true when `targetPath` is logically contained within `containerDir`.
 * Handles `..` traversal by normalising with `resolve` before comparing.
 */
export const isPathContained = (containerDir: string, targetPath: string): boolean => {
  const resolvedContainer = resolve(containerDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedContainer, resolvedTarget);
  // When containerDir === targetPath, relative() returns "" (empty string).
  // An empty string passes both checks (does not start with ".." or "/"),
  // so same-path is intentionally treated as contained (returns true).
  return !rel.startsWith("..") && !rel.startsWith("/");
};

/**
 * Filesystem-aware guard: checks that `filePath` is genuinely inside `worktreePath`,
 * following two layers of validation:
 *   1. Logical containment (no `..` traversal)
 *   2. Symlink resolution via `realpath` (no symlink escapes)
 *
 * Returns `ToolResult<{ contained: true }>` — callers must check `result.ok`.
 */
export const isPathInWorktree = async (
  filePath: string,
  worktreePath: string,
): Promise<ToolResult<{ contained: true }>> => {
  const resolvedWorktree = resolve(worktreePath);
  const resolvedTarget = resolve(filePath);

  // Layer 1: logical containment
  if (!isPathContained(resolvedWorktree, resolvedTarget)) {
    return toolError(
      "INVALID_INPUT",
      `Path "${filePath}" is outside worktree "${worktreePath}"`,
      false,
    );
  }

  // Layer 2: symlink resolution
  try {
    const realWorktree = await realpath(resolvedWorktree);
    const realTarget = await realpath(resolvedTarget);
    if (!isPathContained(realWorktree, realTarget)) {
      return toolError(
        "INVALID_INPUT",
        `Path "${filePath}" escapes worktree "${worktreePath}" via symlink`,
        false,
      );
    }
  } catch {
    // Parent-directory fallback: when the file doesn't exist, check if its
    // parent directory is a symlink escape (ADR-014a tightening).
    try {
      const parentDir = dirname(resolvedTarget);
      const realParent = await realpath(parentDir);
      const realWorktree = await realpath(resolvedWorktree);
      if (!isPathContained(realWorktree, realParent)) {
        return toolError(
          "INVALID_INPUT",
          `Path "${filePath}" escapes worktree "${worktreePath}" via symlink`,
          false,
        );
      }
    } catch {
      // Parent doesn't exist either — fall through to generic error
    }
    return toolError(
      "INVALID_INPUT",
      `Path "${filePath}" could not be resolved within worktree "${worktreePath}"`,
      false,
    );
  }

  return toolOk({ contained: true as const });
};

/**
 * Symlink-safe containment check composed over a caller-supplied `realpath`
 * resolver, for seam-injected callers that cannot use `isPathInWorktree`'s
 * direct `node:fs/promises` call — e.g. a module whose filesystem access is
 * fully seam-injected so its unit tests can supply fully in-memory fakes
 * (whose fixture paths never exist on real disk). Same two-layer shape as
 * `isPathInWorktree`: logical containment first, then symlink resolution
 * via the resolver. A resolver failure (either path doesn't exist) fails
 * closed — `false`, never a thrown error.
 */
export const isPathContainedViaResolver = async (
  containerDir: string,
  targetDir: string,
  resolvePath: (path: string) => Promise<string>,
): Promise<boolean> => {
  if (!isPathContained(containerDir, targetDir)) return false;
  try {
    const realContainer = await resolvePath(containerDir);
    const realTarget = await resolvePath(targetDir);
    return isPathContained(realContainer, realTarget);
  } catch {
    return false;
  }
};

/**
 * Symlink-safe containment check for a write target that may legitimately
 * not exist YET — the caller is about to create it (e.g. a project's first
 * `.canon/` directory, or its first `learning.jsonl` file inside one). This
 * is the ONE shared primitive for that shape of check, used by every caller
 * that must both (a) tolerate a not-yet-created target and (b) reject a
 * symlink escape — replaces two independently-drifted call-site idioms that
 * caused a real defect (a `project_dir`-level containment fix left the
 * `project_dir/.canon` subpath unchecked one level down, round-2 adversarial
 * review on ADR-0058).
 *
 * Distinct from both siblings above by design, not oversight:
 * - `isPathInWorktree` / `isPathContainedViaResolver` both fail CLOSED the
 *   instant `resolvePath(targetPath)` throws (path doesn't exist) — correct
 *   for validating a path that must already exist, wrong for a path the
 *   caller is about to create (it would reject every legitimate first run).
 * - This function instead walks UP from `targetPath` to the nearest
 *   EXISTING ancestor and requires *that* to be contained. A not-yet-created
 *   `.canon/learning.jsonl` resolves its existing ancestor (`.canon/`, or
 *   `project_dir` itself on a true first run) and passes when that ancestor
 *   is genuinely inside `containerDir`; a `.canon` that DOES exist but is a
 *   symlink resolving outside `containerDir` is caught directly (no walk
 *   needed — its own resolution already fails containment).
 *
 * A resolver failure at every ancestor up to and including `containerDir`
 * itself fails closed (`false`) — this can only happen if `containerDir`
 * itself does not resolve, which should never occur for an already-validated
 * caller scope.
 */
export const isPathContainedResolvingAncestor = async (
  containerDir: string,
  targetPath: string,
  resolvePath: (path: string) => Promise<string>,
): Promise<boolean> => {
  if (!isPathContained(containerDir, targetPath)) return false;

  let resolvedContainer: string;
  try {
    resolvedContainer = await resolvePath(containerDir);
  } catch {
    return false;
  }

  let candidate = targetPath;
  for (;;) {
    try {
      const resolvedCandidate = await resolvePath(candidate);
      return isPathContained(resolvedContainer, resolvedCandidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate || !isPathContained(containerDir, parent)) return false;
      candidate = parent;
    }
  }
};
