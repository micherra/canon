/**
 * Janitor lock — .canon/janitor.lock management
 *
 * The lock file body is the current process PID. Lock file mtime is used
 * only for crash-recovery staleness detection. The last successful run
 * timestamp is persisted separately in janitor.lastrun.
 *
 * Acquire uses exclusive create (O_EXCL) to prevent TOCTOU races.
 * Stale locks (mtime + staleAfterMs < now) are reclaimed atomically.
 */

import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANON_FILES } from "@shared/constants.ts";

export type JanitorLockResult =
  | { acquired: true; previousMtime: number | null }
  | { acquired: false; reason: "already_locked" | "stale_reclaim_failed" };

const lockFileName = "janitor.lock";

const lockPath = (canonDir: string): string => join(canonDir, lockFileName);

/**
 * Acquire janitor lock. Body = PID, mtime = last successful run.
 * Reclaims stale locks (mtime older than staleAfterMs).
 * Returns { acquired: false, reason } for expected failure cases.
 *
 * ## TOCTOU note (Advisory 2)
 *
 * The stale-lock reclaim path has an inherent TOCTOU window between the `unlink`
 * and the subsequent exclusive `writeFile(..., { flag: "wx" })`:
 *
 *   1. Process A: reads lock, detects stale → calls unlink
 *   2. Process B: also detects stale → calls unlink (may get ENOENT, returns stale_reclaim_failed)
 *   3. Process A: calls writeFile with O_EXCL → succeeds
 *   4. Process B: calls writeFile with O_EXCL → gets EEXIST → returns stale_reclaim_failed
 *
 * Mitigation: O_EXCL on the re-create step ensures only one racer wins; the loser
 * receives EEXIST and returns `stale_reclaim_failed` (fail-safe, not fail-open).
 * The 1-hour default stale threshold makes the window vanishingly unlikely in practice.
 *
 * Acceptable risk: Canon is a single-process CLI tool. Multi-process deployments
 * (e.g. multiple MCP server instances) would require advisory file locks (fcntl/flock)
 * for stronger guarantees, which are outside the scope of this implementation.
 */

/** Check if a PID is alive via process.kill(pid, 0) probe. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM = process exists but we cannot signal it — treat as alive
    return true;
  }
}

/** Attempt to reclaim a lock: unlink then exclusive create. */
async function reclaimLock(path: string, previousMtime: number): Promise<JanitorLockResult> {
  try {
    await unlink(path);
  } catch {
    return { acquired: false, reason: "stale_reclaim_failed" };
  }
  try {
    await writeFile(path, String(process.pid), { flag: "wx" });
    return { acquired: true, previousMtime };
  } catch {
    return { acquired: false, reason: "stale_reclaim_failed" };
  }
}

export const acquireJanitorLock = async (
  canonDir: string,
  staleAfterMs: number,
): Promise<JanitorLockResult> => {
  const path = lockPath(canonDir);

  // Attempt exclusive create — fails with EEXIST if lock exists
  try {
    await writeFile(path, String(process.pid), { flag: "wx" });
    return { acquired: true, previousMtime: null };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Lock exists — read PID for liveness check, then check staleness
  let previousMtime: number;
  try {
    const [st, body] = await Promise.all([stat(path), readFile(path, "utf-8")]);
    previousMtime = st.mtime.getTime();

    // Check PID liveness — dead process means immediately reclaimable
    const pid = parseInt(body.trim(), 10);
    if (!Number.isNaN(pid) && pid > 0 && !isPidAlive(pid)) {
      return reclaimLock(path, previousMtime);
    }

    if (Date.now() - previousMtime <= staleAfterMs) {
      return { acquired: false, reason: "already_locked" };
    }
  } catch {
    return { acquired: false, reason: "already_locked" };
  }

  // Lock is stale — reclaim
  return reclaimLock(path, previousMtime);
};

/**
 * Record a successful janitor run timestamp to a separate lastrun file.
 * The lock file is transient (deleted on release); the timestamp must persist.
 */
export const commitJanitorLock = async (canonDir: string): Promise<void> => {
  const lastrunPath = join(canonDir, CANON_FILES.JANITOR_LASTRUN);
  await writeFile(lastrunPath, String(Date.now()));
};

/**
 * Remove the lock file entirely. Ignores ENOENT.
 */
export const releaseJanitorLock = async (canonDir: string): Promise<void> => {
  const path = lockPath(canonDir);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

/**
 * Read last successful janitor run timestamp from the lastrun file.
 * Returns null if no lastrun file exists.
 */
export const getLastJanitorTimestamp = async (canonDir: string): Promise<number | null> => {
  const lastrunPath = join(canonDir, CANON_FILES.JANITOR_LASTRUN);
  try {
    const content = await readFile(lastrunPath, "utf-8");
    const ts = parseInt(content.trim(), 10);
    return Number.isNaN(ts) ? null : ts;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};
