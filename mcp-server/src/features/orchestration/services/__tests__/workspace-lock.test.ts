/**
 * TDD tests for workspace-lock.ts — written first, before implementation.
 *
 * Contract under test:
 *   acquireLock, releaseLock, readLock, isStale
 *
 * All FS and clock operations are injected via LockSeams for determinism.
 */

import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCK_TTL_MS,
  acquireLock,
  isStale,
  readLock,
  releaseLock,
  type LockRecord,
  type LockSeams,
} from "../workspace-lock.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh LockRecord with controlled timestamps and PIDs. */
function makeLockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    job_id: "job-abc123",
    pid: process.pid,
    session_id: "session-aaa",
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Seams that use the real process.pid and real Date.now(). */
const realSeams: LockSeams = {
  now: () => Date.now(),
  pid: () => process.pid,
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "workspace-lock-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// isStale — pure function, no FS needed
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("returns false when age is within TTL", () => {
    const record = makeLockRecord({ started_at: new Date(Date.now() - 1000).toISOString() });
    expect(isStale(record, Date.now(), DEFAULT_LOCK_TTL_MS)).toBe(false);
  });

  it("returns true when age exceeds TTL", () => {
    const twoHoursAgo = Date.now() - DEFAULT_LOCK_TTL_MS - 1;
    const record = makeLockRecord({ started_at: new Date(twoHoursAgo).toISOString() });
    expect(isStale(record, Date.now(), DEFAULT_LOCK_TTL_MS)).toBe(true);
  });

  it("treats NaN started_at as stale (reclaimable)", () => {
    const record = makeLockRecord({ started_at: "not-a-date" });
    expect(isStale(record, Date.now(), DEFAULT_LOCK_TTL_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acquireLock — tests 1-5 + 9
// ---------------------------------------------------------------------------

describe("acquireLock", () => {
  // Test 1: clean workspace → acquired; .lock exists with our record
  it("acquires lock on a clean workspace and writes the record", () => {
    const owner = { session_id: "session-001", job_id: "job-001" };
    const outcome = acquireLock(tmpDir, owner, { seams: realSeams });

    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return; // narrow type

    expect(outcome.record.session_id).toBe("session-001");
    expect(outcome.record.job_id).toBe("job-001");
    expect(outcome.record.pid).toBe(process.pid);
    expect(outcome.record.started_at).toBeTruthy();

    // Lock file must exist on disk
    const lockPath = join(tmpDir, ".lock");
    expect(existsSync(lockPath)).toBe(true);
    const stored = JSON.parse(readFileSync(lockPath, "utf-8")) as LockRecord;
    expect(stored.session_id).toBe("session-001");
  });

  // Test 2: second acquire (live lock, fresh started_at) → gated with the first owner
  it("returns gated when a live (non-stale) lock already exists", () => {
    // First acquire — creates the lock
    const owner1 = { session_id: "session-001", job_id: "job-001" };
    acquireLock(tmpDir, owner1, { seams: realSeams });

    // Second acquire from a different session
    const owner2 = { session_id: "session-002", job_id: "job-002" };
    const outcome = acquireLock(tmpDir, owner2, { seams: realSeams });

    expect(outcome.kind).toBe("gated");
    if (outcome.kind !== "gated") return;
    expect(outcome.owner.session_id).toBe("session-001");
  });

  // Test 3: acquire over a stale lock (injected now past TTL) → reclaimed reason:"ttl"
  it("reclaims a stale lock via TTL", () => {
    // Write a stale lock directly
    const staleStarted = new Date(Date.now() - DEFAULT_LOCK_TTL_MS - 5000).toISOString();
    const staleLock: LockRecord = makeLockRecord({
      job_id: "old-job",
      session_id: "old-session",
      started_at: staleStarted,
    });
    writeFileSync(join(tmpDir, ".lock"), JSON.stringify(staleLock), "utf-8");

    const owner = { session_id: "session-new", job_id: "job-new" };
    const outcome = acquireLock(tmpDir, owner, { seams: realSeams });

    expect(outcome.kind).toBe("reclaimed");
    if (outcome.kind !== "reclaimed") return;
    expect(outcome.reason).toBe("ttl");
    expect(outcome.previous.session_id).toBe("old-session");
    expect(outcome.record.session_id).toBe("session-new");
  });

  // Test 4: acquire over a lock whose pid is dead → reclaimed reason:"pid_dead"
  it("reclaims a lock whose PID is provably dead", () => {
    // Use a PID that is extremely unlikely to exist (max pid + offset approach)
    // On Linux max pid is typically 32768 or 4194304, on macOS 99999.
    // We'll just use a known-dead PID by using a very large number.
    const deadPid = 999_999_999; // effectively guaranteed dead on all platforms

    const freshStarted = new Date(Date.now() - 60_000).toISOString(); // 1 min ago — NOT stale
    const lockedByDead: LockRecord = makeLockRecord({
      job_id: "dead-job",
      pid: deadPid,
      session_id: "dead-session",
      started_at: freshStarted,
    });
    writeFileSync(join(tmpDir, ".lock"), JSON.stringify(lockedByDead), "utf-8");

    const owner = { session_id: "session-new", job_id: "job-new" };
    const outcome = acquireLock(tmpDir, owner, { seams: realSeams });

    expect(outcome.kind).toBe("reclaimed");
    if (outcome.kind !== "reclaimed") return;
    expect(outcome.reason).toBe("pid_dead");
    expect(outcome.previous.session_id).toBe("dead-session");
  });

  // Test 5: acquire over a corrupt non-stale .lock → gated (fail-safe)
  it("returns gated (not free) when the lock file is corrupt and not TTL-stale", () => {
    writeFileSync(join(tmpDir, ".lock"), "not valid json {{ }", "utf-8");

    const owner = { session_id: "session-new", job_id: "job-new" };
    const outcome = acquireLock(tmpDir, owner, { seams: realSeams });

    // Fail-safe: corrupt lock with unknown age → gated
    expect(outcome.kind).toBe("gated");
  });

  // Test 9: omitted session_id/job_id → record stores "unknown"; still works
  it('stores "unknown" when session_id/job_id are omitted', () => {
    const outcome = acquireLock(tmpDir, {}, { seams: realSeams });

    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    expect(outcome.record.session_id).toBe("unknown");
    expect(outcome.record.job_id).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// releaseLock — tests 6-8
// ---------------------------------------------------------------------------

describe("releaseLock", () => {
  // Test 6: release present-and-ours → released:true, .lock gone
  it("releases a lock owned by our session", () => {
    const owner = { session_id: "session-abc", job_id: "job-abc" };
    acquireLock(tmpDir, owner, { seams: realSeams });

    const result = releaseLock(tmpDir, { session_id: "session-abc" });

    expect(result.released).toBe(true);
    expect(existsSync(join(tmpDir, ".lock"))).toBe(false);
  });

  // Test 7: release absent → released:false, no throw (idempotent)
  it("returns released:false and does not throw when no lock exists", () => {
    expect(() => releaseLock(tmpDir, { session_id: "session-xyz" })).not.toThrow();
    const result = releaseLock(tmpDir, { session_id: "session-xyz" });
    expect(result.released).toBe(false);
  });

  // Test 8: release a peer's lock (different session_id) → released:false, .lock untouched
  it("does not release a lock owned by a different session", () => {
    const owner = { session_id: "session-owner", job_id: "job-owner" };
    acquireLock(tmpDir, owner, { seams: realSeams });

    const result = releaseLock(tmpDir, { session_id: "session-other" });

    expect(result.released).toBe(false);
    // .lock must still exist
    expect(existsSync(join(tmpDir, ".lock"))).toBe(true);
  });

  // Idempotency: release with omitted owner always succeeds
  it("releases any lock when owner is omitted", () => {
    const owner = { session_id: "session-abc", job_id: "job-abc" };
    acquireLock(tmpDir, owner, { seams: realSeams });

    const result = releaseLock(tmpDir);

    expect(result.released).toBe(true);
    expect(existsSync(join(tmpDir, ".lock"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readLock
// ---------------------------------------------------------------------------

describe("readLock", () => {
  it("returns null when no .lock exists", () => {
    expect(readLock(tmpDir)).toBeNull();
  });

  it("returns null for a corrupt .lock file", () => {
    writeFileSync(join(tmpDir, ".lock"), "not-json", "utf-8");
    expect(readLock(tmpDir)).toBeNull();
  });

  it("returns the parsed LockRecord for a valid .lock", () => {
    const record = makeLockRecord({ session_id: "s1", job_id: "j1" });
    writeFileSync(join(tmpDir, ".lock"), JSON.stringify(record), "utf-8");

    const result = readLock(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("s1");
  });
});

// ---------------------------------------------------------------------------
// Corrupt + stale .lock → reclaimed with reason "corrupt_and_stale"
// ---------------------------------------------------------------------------

describe("acquireLock — corrupt AND stale", () => {
  it("reclaims a corrupt lock when mtime is past TTL", async () => {
    const lockPath = join(tmpDir, ".lock");
    writeFileSync(lockPath, "not valid json {{ }", "utf-8");

    // Inject a seam that reports a time far in the future (past TTL for the file's mtime)
    const futureNow = Date.now() + DEFAULT_LOCK_TTL_MS + 1_000_000;
    const seams: LockSeams = { now: () => futureNow, pid: () => process.pid };

    const owner = { session_id: "session-new", job_id: "job-new" };
    const outcome = acquireLock(tmpDir, owner, { ttlMs: DEFAULT_LOCK_TTL_MS, seams });

    // When corrupt AND TTL-stale (by mtime), we should reclaim
    expect(outcome.kind).toBe("reclaimed");
    if (outcome.kind !== "reclaimed") return;
    expect(outcome.reason).toBe("corrupt_and_stale");
  });
});
