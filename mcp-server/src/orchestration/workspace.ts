/**
 * Workspace utilities — creates directory structures and generates slug/branch helpers.
 *
 * File locking (acquireLock, releaseLock, withBoardLock) and session persistence
 * (writeSession) have been removed — SQLite WAL handles write serialization.
 */

import { access, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Sanitize a git branch name into a filesystem-safe string.
 * Replaces `/` with `--`, spaces with `-`, strips non-alphanumeric/hyphen chars,
 * lowercases, and truncates to 80 characters.
 */
export function sanitizeBranch(branch: string): string {
  return branch
    .replace(/\//g, "--")
    .replace(/\s/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase()
    .slice(0, 80);
}

/**
 * Generate a URL-style slug from a task description.
 * Lowercases, replaces spaces with hyphens, strips non-alphanumeric/hyphen chars,
 * collapses multiple hyphens, trims leading/trailing hyphens, truncates to 40 chars.
 */
export function generateSlug(task: string): string {
  return task
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Check if a slug already exists under the given parent directory and return
 * a unique variant by appending `-2`, `-3`, etc. if needed.
 *
 * Used to deduplicate both workspace directories (under branch dir) and
 * plan directories (under workspace/plans/).
 */
export async function checkSlugCollision(parentDir: string, slug: string): Promise<string> {
  const exists = async (candidate: string): Promise<boolean> => {
    try {
      await access(path.join(parentDir, candidate));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  };

  if (!(await exists(slug))) return slug;

  let counter = 2;
  while (await exists(`${slug}-${counter}`)) {
    if (counter > 999) {
      throw new Error(`Slug collision limit exceeded for "${slug}"`);
    }
    counter++;
  }
  return `${slug}-${counter}`;
}

/**
 * Create the canonical workspace directory structure under
 * `projectDir/.canon/workspaces/<sanitized>/`.
 * Returns the workspace root path.
 */
export async function initWorkspace(projectDir: string, sanitized: string): Promise<string> {
  const workspace = path.join(projectDir, ".canon", "workspaces", sanitized);
  const subdirs = ["research", "decisions", "plans", "reviews", "transcripts", "handoffs"];
  await Promise.all(subdirs.map((dir) => mkdir(path.join(workspace, dir), { recursive: true })));
  return workspace;
}
