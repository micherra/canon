/**
 * Learn lock — .canon/learn.lock management
 *
 * The lock file body is the current process PID.
 * The lock file mtime tracks the last successful learn run timestamp.
 *
 * Acquire uses exclusive create (O_EXCL) to prevent TOCTOU races.
 * Stale locks (mtime + staleAfterMs < now) are reclaimed atomically.
 */

import { stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

type LockAcquireResult =
  | { acquired: true; previousMtime: number | null }
  | { acquired: false; reason: "already_locked" | "stale_reclaim_failed" };

const lockFileName = "learn.lock";

const lockPath = (canonDir: string): string => join(canonDir, lockFileName);

/**
 * Acquire learn lock. Body = PID, mtime = last successful run.
 * Reclaims stale locks (mtime older than staleAfterMs).
 * Returns { acquired: false, reason } for expected failure cases.
 */
export const acquireLearnLock = async (
  canonDir: string,
  staleAfterMs: number,
): Promise<LockAcquireResult> => {
  const path = lockPath(canonDir);

  // Attempt exclusive create — fails with EEXIST if lock exists
  try {
    await writeFile(path, String(process.pid), { flag: "wx" });
    return { acquired: true, previousMtime: null };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }

  // Lock exists — check staleness
  let previousMtime: number;
  try {
    const st = await stat(path);
    previousMtime = st.mtime.getTime();
    const age = Date.now() - previousMtime;
    if (age <= staleAfterMs) {
      // Not stale — another process holds the lock
      return { acquired: false, reason: "already_locked" };
    }
  } catch {
    // stat failed — lock may have been released concurrently; report locked
    return { acquired: false, reason: "already_locked" };
  }

  // Lock is stale — unlink and retry exclusive create
  try {
    await unlink(path);
  } catch {
    // Someone else reclaimed it first
    return { acquired: false, reason: "stale_reclaim_failed" };
  }

  try {
    await writeFile(path, String(process.pid), { flag: "wx" });
    return { acquired: true, previousMtime };
  } catch {
    // Lost the race to reclaim
    return { acquired: false, reason: "stale_reclaim_failed" };
  }
};

/**
 * Rollback lock mtime to pre-acquire value on learner failure.
 * If previousMtime is null (no prior learn run), remove the lock entirely.
 */
export const rollbackLearnLock = async (
  canonDir: string,
  previousMtime: number | null,
): Promise<void> => {
  const path = lockPath(canonDir);
  if (previousMtime === null) {
    try {
      await unlink(path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  await utimes(path, new Date(), new Date(previousMtime));
};

/**
 * Update lock mtime to now after a successful learner run.
 */
export const commitLearnLock = async (canonDir: string): Promise<void> => {
  const path = lockPath(canonDir);
  const now = new Date();
  await utimes(path, now, now);
};

/**
 * Remove the lock file entirely. Ignores ENOENT.
 */
export const releaseLearnLock = async (canonDir: string): Promise<void> => {
  const path = lockPath(canonDir);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

/**
 * Read lock mtime (= last successful learn timestamp).
 * Returns null if no lock file exists.
 */
export const getLastLearnTimestamp = async (canonDir: string): Promise<number | null> => {
  const path = lockPath(canonDir);
  try {
    const st = await stat(path);
    return st.mtime.getTime();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};
