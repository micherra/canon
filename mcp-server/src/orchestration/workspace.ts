/**
 * Workspace initialization and management — creates directory structures,
 * manages session files, and handles workspace-level locking.
 */

import { access, mkdir, open, readFile, rename, unlink } from "fs/promises";
import path from "path";
import type { Session } from "./flow-schema.ts";
import { atomicWriteFile } from "../utils/atomic-write.ts";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Check whether a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
export async function checkSlugCollision(
  parentDir: string,
  slug: string,
): Promise<string> {
  const exists = async (candidate: string): Promise<boolean> => {
    try {
      await access(path.join(parentDir, candidate));
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
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
export async function initWorkspace(
  projectDir: string,
  sanitized: string,
): Promise<string> {
  const workspace = path.join(projectDir, ".canon", "workspaces", sanitized);
  const subdirs = ["research", "decisions", "plans", "reviews"];
  await Promise.all(
    subdirs.map((dir) => mkdir(path.join(workspace, dir), { recursive: true })),
  );
  return workspace;
}

/**
 * Persist a Session object as `session.json` inside the workspace directory.
 */
export async function writeSession(
  workspace: string,
  session: Session,
): Promise<void> {
  const filePath = path.join(workspace, "session.json");
  await atomicWriteFile(filePath, JSON.stringify(session, null, 2) + "\n");
}

/**
 * Attempt to acquire a workspace-level lock.
 *
 * The read-then-delete of stale/dead locks is an optimistic cleanup step.
 * Two processes may both detect and delete a stale lock concurrently — this
 * is safe because the true serialization point is the O_EXCL file creation
 * below, which atomically fails if another process wins the race.
 *
 * Stale locks (older than 2 hours) and dead-process locks are automatically removed.
 */
export async function acquireLock(
  workspace: string,
): Promise<{ acquired: boolean; reason?: string }> {
  const lockPath = path.join(workspace, ".lock");

  // Check for existing lock
  try {
    const raw = await readFile(lockPath, "utf-8");
    const lock = JSON.parse(raw) as { pid: number; started: string };
    const started = new Date(lock.started).getTime();
    const age = Date.now() - started;

    // If process is dead, remove stale lock regardless of age
    if (!isProcessAlive(lock.pid)) {
      try { await unlink(lockPath); } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
    } else if (age < TWO_HOURS_MS) {
      return {
        acquired: false,
        reason: `Another build is active (pid ${lock.pid}, started ${lock.started})`,
      };
    } else {
      // Stale lock from a live process (hung?) — remove it
      try { await unlink(lockPath); } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    // No lock file — proceed to create one
  }

  // Atomically create the lock file using O_EXCL (fails if file already exists)
  const newLock = { pid: process.pid, started: new Date().toISOString() };
  const data = JSON.stringify(newLock, null, 2) + "\n";

  try {
    const fh = await open(lockPath, "wx"); // O_WRONLY | O_CREAT | O_EXCL
    try {
      await fh.writeFile(data, "utf-8");
    } finally {
      await fh.close();
    }
    return { acquired: true };
  } catch (err: any) {
    if (err.code === "EEXIST") {
      return {
        acquired: false,
        reason: "Lock was acquired by another process between check and create",
      };
    }
    throw err;
  }
}

/**
 * Release the workspace lock. Only removes the lock if it is owned by the
 * current process (matching PID). Silently ignores missing lock files and
 * locks owned by other processes.
 *
 * Uses rename-then-verify to avoid TOCTOU: atomically moves the lock to a
 * temp path, verifies ownership, then deletes. If ownership doesn't match,
 * restores the original lock file.
 */
export async function releaseLock(workspace: string): Promise<void> {
  const lockPath = path.join(workspace, ".lock");
  const tempPath = path.join(workspace, `.lock.release.${process.pid}`);

  // Atomically move the lock file — if this succeeds, no other process can
  // see or delete the lock while we verify ownership.
  try {
    await rename(lockPath, tempPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return; // No lock file — nothing to release
    throw err;
  }

  // Read and verify ownership from the moved file
  try {
    const raw = await readFile(tempPath, "utf-8");
    const lock = JSON.parse(raw) as { pid: number };
    if (lock.pid !== process.pid) {
      // Not our lock — restore it
      try { await rename(tempPath, lockPath); } catch (e: any) {
        // If restore fails because someone else created a new lock, just
        // clean up our temp file
        if (e.code === "ENOENT") return;
        try { await unlink(tempPath); } catch { /* best effort */ }
      }
      return;
    }
    // Our lock — delete the temp file
    await unlink(tempPath);
  } catch (err: any) {
    // If JSON parse fails the lock is corrupt — safe to remove
    if (err instanceof SyntaxError) {
      try { await unlink(tempPath); } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      return;
    }
    if (err.code === "ENOENT") return;
    throw err;
  }
}

/**
 * Execute a function while holding the workspace lock.
 * Acquires the lock before calling `fn`, releases it on completion or error.
 * Throws if the lock cannot be acquired.
 */
export async function withBoardLock<T>(
  workspace: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { acquired, reason } = await acquireLock(workspace);
  if (!acquired) {
    throw new Error(`Cannot acquire workspace lock: ${reason}`);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(workspace);
  }
}
