/**
 * Janitor lock tests — PID+mtime lock file management
 *
 * Uses real temp directories for I/O correctness.
 * Tests cover: acquire, commit, release, getLastJanitorTimestamp.
 */

import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "../janitor-lock.ts";

const STALE_AFTER_MS = 5000; // 5 seconds for tests

let tmpDir: string;
let canonDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-lock-test-"));
  canonDir = tmpDir; // canonDir is the dir that holds janitor.lock
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

// acquireJanitorLock

describe("acquireJanitorLock", () => {
  test("succeeds on fresh directory — no existing lock", async () => {
    const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.previousMtime).toBeNull();
    }
  });

  test("sets lock file body to current PID", async () => {
    const { readFile } = await import("node:fs/promises");
    await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    const body = await readFile(join(canonDir, "janitor.lock"), "utf-8");
    expect(body).toBe(String(process.pid));
  });

  test("fails when lock already exists and is not stale", async () => {
    // Write a lock with the current process PID — it is guaranteed alive,
    // so the PID liveness check will not reclaim it.
    await writeFile(join(canonDir, "janitor.lock"), String(process.pid));

    const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.reason).toBe("already_locked");
    }
  });

  test("succeeds when existing lock is stale (mtime > staleAfterMs ago)", async () => {
    const lockPath = join(canonDir, "janitor.lock");
    await writeFile(lockPath, "99999");

    // Set mtime to 10 seconds ago — definitely stale for STALE_AFTER_MS=5000
    const staleMtime = new Date(Date.now() - 10_000);
    await utimes(lockPath, new Date(), staleMtime);

    const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(true);
  });

  test("returns previous mtime when reclaiming a stale lock", async () => {
    const lockPath = join(canonDir, "janitor.lock");
    await writeFile(lockPath, "99999");

    // Simulate a prior janitor run: set mtime 20 seconds ago
    const staleMtime = new Date(Date.now() - 20_000);
    await utimes(lockPath, new Date(), staleMtime);

    const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      // previousMtime should be close to the stale time we set
      expect(result.previousMtime).not.toBeNull();
      expect(typeof result.previousMtime).toBe("number");
      // Should be within 2 seconds of the stale mtime (OS precision)
      const diff = Math.abs(result.previousMtime! - staleMtime.getTime());
      expect(diff).toBeLessThan(2000);
    }
  });

  test("second acquire fails when first is non-stale (concurrent lock simulation)", async () => {
    const r1 = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(r1.acquired).toBe(true);

    // Second acquire should fail — lock exists and is fresh
    const r2 = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(r2.acquired).toBe(false);
    if (!r2.acquired) {
      expect(r2.reason).toBe("already_locked");
    }
  });

  // PID liveness tests

  test("dead PID (ESRCH) — lock is immediately reclaimable regardless of age", async () => {
    const lockPath = join(canonDir, "janitor.lock");
    // Write a lock with a fake PID that does not exist
    const deadPid = 99999999;
    await writeFile(lockPath, String(deadPid));

    // mtime = now (not stale) — without PID check this would block
    // With PID liveness check: ESRCH → immediately reclaimable
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === deadPid) {
        const err = Object.assign(new Error("No such process"), { code: "ESRCH" });
        throw err;
      }
      return true;
    });

    try {
      const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
      expect(result.acquired).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  test("alive PID within stale threshold — lock is not reclaimable", async () => {
    const lockPath = join(canonDir, "janitor.lock");
    const alivePid = process.pid; // current process is definitely alive
    await writeFile(lockPath, String(alivePid));
    // mtime = now (not stale)

    const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.reason).toBe("already_locked");
    }
  });

  test("EPERM on kill — treated as alive (conservative), lock not reclaimable", async () => {
    const lockPath = join(canonDir, "janitor.lock");
    const somePid = 1;
    await writeFile(lockPath, String(somePid));
    // mtime = now (not stale)

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === somePid) {
        const err = Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
        throw err;
      }
      return true;
    });

    try {
      const result = await acquireJanitorLock(canonDir, STALE_AFTER_MS);
      // EPERM means process exists but we can't signal it — treated as alive
      expect(result.acquired).toBe(false);
      if (!result.acquired) {
        expect(result.reason).toBe("already_locked");
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});

// commitJanitorLock

describe("commitJanitorLock", () => {
  test("writes timestamp to janitor.lastrun file", async () => {
    await acquireJanitorLock(canonDir, STALE_AFTER_MS);

    const before = Date.now();
    await commitJanitorLock(canonDir);
    const after = Date.now();

    const content = await readFile(join(canonDir, "janitor.lastrun"), "utf-8");
    const ts = parseInt(content.trim(), 10);

    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// releaseJanitorLock

describe("releaseJanitorLock", () => {
  test("removes lock file", async () => {
    const { access } = await import("node:fs/promises");
    await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    await releaseJanitorLock(canonDir);

    await expect(access(join(canonDir, "janitor.lock"))).rejects.toThrow();
  });

  test("does not throw when lock file does not exist (ENOENT is ignored)", async () => {
    await expect(releaseJanitorLock(canonDir)).resolves.not.toThrow();
  });
});

// getLastJanitorTimestamp

describe("getLastJanitorTimestamp", () => {
  test("returns null when no lastrun file exists", async () => {
    const result = await getLastJanitorTimestamp(canonDir);
    expect(result).toBeNull();
  });

  test("returns timestamp from lastrun file", async () => {
    const knownTs = Date.now() - 5_000;
    await writeFile(join(canonDir, "janitor.lastrun"), String(knownTs));

    const result = await getLastJanitorTimestamp(canonDir);
    expect(result).toBe(knownTs);
  });

  test("returns null for corrupt lastrun content", async () => {
    await writeFile(join(canonDir, "janitor.lastrun"), "not-a-number");

    const result = await getLastJanitorTimestamp(canonDir);
    expect(result).toBeNull();
  });

  test("persists across lock release", async () => {
    await acquireJanitorLock(canonDir, STALE_AFTER_MS);
    await commitJanitorLock(canonDir);
    await releaseJanitorLock(canonDir);

    const result = await getLastJanitorTimestamp(canonDir);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
  });
});
