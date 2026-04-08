/**
 * Learn lock tests — PID+mtime lock file management
 *
 * Uses real temp directories for I/O correctness.
 * Tests cover: acquire, rollback, commit, release, getLastLearnTimestamp.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acquireLearnLock,
  commitLearnLock,
  getLastLearnTimestamp,
  releaseLearnLock,
  rollbackLearnLock,
} from "../learn-lock.ts";

const STALE_AFTER_MS = 5000; // 5 seconds for tests

let tmpDir: string;
let canonDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "learn-lock-test-"));
  canonDir = tmpDir; // canonDir is the dir that holds learn.lock
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

// acquireLearnLock

describe("acquireLearnLock", () => {
  test("succeeds on fresh directory — no existing lock", async () => {
    const result = await acquireLearnLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.previousMtime).toBeNull();
    }
  });

  test("sets lock file body to current PID", async () => {
    const { readFile } = await import("node:fs/promises");
    await acquireLearnLock(canonDir, STALE_AFTER_MS);
    const body = await readFile(join(canonDir, "learn.lock"), "utf-8");
    expect(body).toBe(String(process.pid));
  });

  test("fails when lock already exists and is not stale", async () => {
    // Write a lock that is not stale (mtime = now)
    await writeFile(join(canonDir, "learn.lock"), "99999");

    const result = await acquireLearnLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.reason).toBe("already_locked");
    }
  });

  test("succeeds when existing lock is stale (mtime > staleAfterMs ago)", async () => {
    const lockPath = join(canonDir, "learn.lock");
    await writeFile(lockPath, "99999");

    // Set mtime to 10 seconds ago — definitely stale for STALE_AFTER_MS=5000
    const staleMtime = new Date(Date.now() - 10_000);
    await utimes(lockPath, new Date(), staleMtime);

    const result = await acquireLearnLock(canonDir, STALE_AFTER_MS);
    expect(result.acquired).toBe(true);
  });

  test("returns previous mtime when reclaiming a stale lock", async () => {
    const lockPath = join(canonDir, "learn.lock");
    await writeFile(lockPath, "99999");

    // Simulate a prior learn run: set mtime 20 seconds ago
    const staleMtime = new Date(Date.now() - 20_000);
    await utimes(lockPath, new Date(), staleMtime);

    const result = await acquireLearnLock(canonDir, STALE_AFTER_MS);
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
    const r1 = await acquireLearnLock(canonDir, STALE_AFTER_MS);
    expect(r1.acquired).toBe(true);

    // Second acquire should fail — lock exists and is fresh
    const r2 = await acquireLearnLock(canonDir, STALE_AFTER_MS);
    expect(r2.acquired).toBe(false);
    if (!r2.acquired) {
      expect(r2.reason).toBe("already_locked");
    }
  });
});

// rollbackLearnLock

describe("rollbackLearnLock", () => {
  test("removes lock when previousMtime is null (no prior run)", async () => {
    const { access } = await import("node:fs/promises");
    await acquireLearnLock(canonDir, STALE_AFTER_MS);
    await rollbackLearnLock(canonDir, null);

    // Lock should be gone
    await expect(access(join(canonDir, "learn.lock"))).rejects.toThrow();
  });

  test("restores previous mtime when previousMtime is non-null", async () => {
    const lockPath = join(canonDir, "learn.lock");
    await writeFile(lockPath, "99999");

    // Set a known mtime 20 seconds ago
    const previousTime = Date.now() - 20_000;
    await utimes(lockPath, new Date(), new Date(previousTime));

    // Acquire (reclaims stale lock, captures previousMtime)
    await acquireLearnLock(canonDir, STALE_AFTER_MS);

    // Rollback should restore the mtime
    await rollbackLearnLock(canonDir, previousTime);

    const st = await stat(lockPath);
    const diff = Math.abs(st.mtime.getTime() - previousTime);
    expect(diff).toBeLessThan(2000); // OS mtime precision tolerance
  });
});

// commitLearnLock

describe("commitLearnLock", () => {
  test("sets mtime to approximately now after commit", async () => {
    await acquireLearnLock(canonDir, STALE_AFTER_MS);

    // Sleep briefly to ensure time moves forward enough to be measurable
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = Date.now();
    await commitLearnLock(canonDir);
    const after = Date.now();

    const st = await stat(join(canonDir, "learn.lock"));
    const mtime = st.mtime.getTime();

    // mtime should be >= before and close to after (within 2 seconds for OS precision)
    expect(mtime).toBeGreaterThanOrEqual(before - 2000);
    expect(mtime).toBeLessThanOrEqual(after + 2000);
  });
});

// releaseLearnLock

describe("releaseLearnLock", () => {
  test("removes lock file", async () => {
    const { access } = await import("node:fs/promises");
    await acquireLearnLock(canonDir, STALE_AFTER_MS);
    await releaseLearnLock(canonDir);

    await expect(access(join(canonDir, "learn.lock"))).rejects.toThrow();
  });

  test("does not throw when lock file does not exist (ENOENT is ignored)", async () => {
    await expect(releaseLearnLock(canonDir)).resolves.not.toThrow();
  });
});

// getLastLearnTimestamp

describe("getLastLearnTimestamp", () => {
  test("returns null when no lock file exists", async () => {
    const result = await getLastLearnTimestamp(canonDir);
    expect(result).toBeNull();
  });

  test("returns mtime of lock file when it exists", async () => {
    const lockPath = join(canonDir, "learn.lock");
    await writeFile(lockPath, String(process.pid));

    // Set a known mtime
    const knownTime = new Date(Date.now() - 5_000);
    await utimes(lockPath, new Date(), knownTime);

    const result = await getLastLearnTimestamp(canonDir);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");

    // Should match the mtime we set (within 2 seconds for OS precision)
    const diff = Math.abs(result! - knownTime.getTime());
    expect(diff).toBeLessThan(2000);
  });
});
