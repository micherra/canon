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
