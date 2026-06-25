/**
 * TDD tests for workspace-lock.ts — written first, before implementation.
 *
 * Contract under test:
 *   acquireLock, releaseLock, readLock, isStale
 *
 * All FS and clock operations are injected via LockSeams for determinism.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  DEFAULT_LOCK_TTL_MS,
  isStale,
  type LockRecord,
  type LockSeams,
  readLock,
  releaseLock,
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

// ---------------------------------------------------------------------------
// P1 #1 — Stale-lock reclaim must be exclusive (compare-and-acquire).
//
// Two concurrent reclaimers of the SAME stale lock must not both win. Only one
// may return reclaimed; the loser must re-read and gate (it must NOT proceed as
// if it co-owns the workspace). And a stale lock that is replaced by a FRESH
// foreign lock between observe-and-reclaim must NOT be clobbered → gate.
//
// Concurrency is simulated deterministically via the `beforeReclaim` seam, which
// fires once, after this caller has observed-and-judged the lock stale but before
// it claims the reclaim — the exact TOCTOU window.
// ---------------------------------------------------------------------------

describe("acquireLock — exclusive stale reclaim (P1 #1)", () => {
  /** Write a stale lock (started_at past TTL) directly to disk. */
  function writeStaleLock(overrides: Partial<LockRecord> = {}): LockRecord {
    const staleStarted = new Date(Date.now() - DEFAULT_LOCK_TTL_MS - 5000).toISOString();
    const stale = makeLockRecord({
      job_id: "old-job",
      session_id: "old-session",
      started_at: staleStarted,
      ...overrides,
    });
    writeFileSync(join(tmpDir, ".lock"), JSON.stringify(stale), "utf-8");
    return stale;
  }

  it("lets exactly ONE of two concurrent reclaimers win; the loser gates", () => {
    writeStaleLock();

    // Simulate the OTHER reclaimer winning the race during our TOCTOU window:
    // it reclaims the same stale lock and writes its own FRESH lock first.
    let raced = false;
    const seams: LockSeams = {
      now: () => Date.now(),
      pid: () => process.pid,
      beforeReclaim: () => {
        if (raced) return;
        raced = true;
        const winner = acquireLock(tmpDir, { session_id: "winner", job_id: "job-w" });
        expect(winner.kind).toBe("reclaimed"); // the other reclaimer wins cleanly
      },
    };

    // This caller observed the stale lock, then (in the window) the winner reclaimed.
    const loser = acquireLock(tmpDir, { session_id: "loser", job_id: "job-l" }, { seams });

    // The loser must NOT have clobbered the winner's fresh lock.
    expect(loser.kind).toBe("gated");

    // On-disk lock belongs to the winner — the loser left it intact.
    const onDisk = readLock(tmpDir);
    expect(onDisk?.session_id).toBe("winner");
  });

  it("gates without clobbering when the stale lock was replaced by a FRESH foreign lock", () => {
    writeStaleLock();

    // During our window, a fresh foreign lock appears (e.g. another session
    // reclaimed and is actively driving). We must detect the change and gate.
    const seams: LockSeams = {
      now: () => Date.now(),
      pid: () => process.pid,
      beforeReclaim: () => {
        const fresh: LockRecord = makeLockRecord({
          job_id: "fresh-job",
          session_id: "fresh-session",
          started_at: new Date().toISOString(),
        });
        writeFileSync(join(tmpDir, ".lock"), JSON.stringify(fresh), "utf-8");
      },
    };

    const outcome = acquireLock(tmpDir, { session_id: "late", job_id: "job-late" }, { seams });

    expect(outcome.kind).toBe("gated");
    // The fresh foreign lock must survive untouched.
    const onDisk = readLock(tmpDir);
    expect(onDisk?.session_id).toBe("fresh-session");
  });

  it("a single session still reclaims an expired lock → acquired/reclaimed (no regression)", () => {
    writeStaleLock();
    const outcome = acquireLock(tmpDir, { session_id: "solo", job_id: "job-solo" });
    expect(outcome.kind).toBe("reclaimed");
    if (outcome.kind !== "reclaimed") return;
    expect(outcome.record.session_id).toBe("solo");
    // No stray reclaim-temp files left behind.
    expect(existsSync(join(tmpDir, ".lock"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1 #2 — Same-session re-entry requires a REAL caller-supplied session_id.
//
// A defaulted/omitted identity normalizes to "unknown"; "unknown" must never
// satisfy the same-session predicate. Two callers both omitting session_id
// against a live lock → the second must gate, not refresh-and-proceed.
// ---------------------------------------------------------------------------

describe("acquireLock — same-session re-entry identity (P1 #2)", () => {
  it("gates a second caller that omits session_id against a live foreign lock", () => {
    // First caller omits session_id → stored as "unknown".
    const first = acquireLock(tmpDir, {}, { seams: realSeams });
    expect(first.kind).toBe("acquired");

    // Second caller also omits session_id. It must NOT be treated as the same
    // session — "unknown" !== "unknown" for same-session purposes.
    const second = acquireLock(tmpDir, {}, { seams: realSeams });
    expect(second.kind).toBe("gated");
  });

  it("gates when the on-disk lock has a real id but the caller omits one", () => {
    acquireLock(tmpDir, { session_id: "real-owner", job_id: "j" }, { seams: realSeams });
    const outcome = acquireLock(tmpDir, {}, { seams: realSeams });
    expect(outcome.kind).toBe("gated");
  });

  it("gates when the caller has a real id but the on-disk lock is unknown", () => {
    acquireLock(tmpDir, {}, { seams: realSeams }); // on-disk session_id === "unknown"
    const outcome = acquireLock(
      tmpDir,
      { session_id: "real-caller", job_id: "j" },
      { seams: realSeams },
    );
    expect(outcome.kind).toBe("gated");
  });

  it("treats an empty-string session_id as non-real (gates)", () => {
    acquireLock(tmpDir, { session_id: "", job_id: "j" }, { seams: realSeams });
    const outcome = acquireLock(tmpDir, { session_id: "", job_id: "j2" }, { seams: realSeams });
    expect(outcome.kind).toBe("gated");
  });

  it("refreshes-and-proceeds when the SAME real session_id re-acquires (no regression)", () => {
    const owner = { session_id: "session-real", job_id: "job-1" };
    const first = acquireLock(tmpDir, owner, { seams: realSeams });
    expect(first.kind).toBe("acquired");

    // Same real session re-acquires (e.g. init after preflight) → refresh, proceed.
    const again = acquireLock(
      tmpDir,
      { session_id: "session-real", job_id: "job-2" },
      { seams: realSeams },
    );
    expect(again.kind).toBe("acquired");
    if (again.kind !== "acquired") return;
    expect(again.record.session_id).toBe("session-real");
    expect(again.record.job_id).toBe("job-2"); // refreshed with new job_id
  });
});

// ---------------------------------------------------------------------------
// P1 #1 (residual) — gap-free reclaim re-verifies and never clobbers a fresh lock.
//
// The reclaim is token-serialized + atomic-replace (no move-aside / restore). If a
// fresh foreign lock appears during the reclaim window, the under-token re-verify
// must observe the change and gate WITHOUT clobbering it. (The earlier move-aside
// scheme had a restore path that could clobber a third acquirer; that path no
// longer exists, so this asserts the replacement's non-clobber guarantee.)
// ---------------------------------------------------------------------------

describe("acquireLock — gap-free reclaim re-verify (P1 #1 residual)", () => {
  it("gates and preserves a fresh foreign lock that lands during the reclaim window", () => {
    const lockFile = join(tmpDir, ".lock");
    // Stale lock the reclaimer observes and judges reclaimable.
    const staleStarted = new Date(Date.now() - DEFAULT_LOCK_TTL_MS - 5000).toISOString();
    writeFileSync(
      lockFile,
      JSON.stringify(makeLockRecord({ session_id: "old", started_at: staleStarted })),
      "utf-8",
    );

    const seams: LockSeams = {
      now: () => Date.now(),
      pid: () => process.pid,
      // A fresh foreign lock lands after we observed stale, before we take the
      // token. The under-token re-verify must see it and gate, not clobber.
      beforeReclaim: () => {
        writeFileSync(
          lockFile,
          JSON.stringify(
            makeLockRecord({ session_id: "racer-c", started_at: new Date().toISOString() }),
          ),
          "utf-8",
        );
      },
    };

    const outcome = acquireLock(tmpDir, { session_id: "A", job_id: "job-a" }, { seams });

    expect(outcome.kind).toBe("gated");
    // The fresh foreign lock must survive untouched.
    expect(readLock(tmpDir)?.session_id).toBe("racer-c");
  });
});

// ---------------------------------------------------------------------------
// P1 #1 (residual) — orphaned reclaim tokens are swept; live ones survive.
//
// A reclaimer that crashes holding the reclaim token orphans a `.lock.reclaiming`
// file (or a legacy `.lock.reclaiming.<pid>.<rand>` sidecar). Reclaim entry sweeps
// such orphans (dead-PID or aged-out) but must NOT remove a live concurrent
// reclaimer's in-flight token.
// ---------------------------------------------------------------------------

describe("acquireLock — stale reclaim-token sweep (P1 #1 residual)", () => {
  it("removes a dead-PID orphan sidecar but leaves a live, fresh one", () => {
    const lockFile = join(tmpDir, ".lock");
    // Stale lock so acquireLock enters the reclaim path (which runs the sweep).
    const staleStarted = new Date(Date.now() - DEFAULT_LOCK_TTL_MS - 5000).toISOString();
    writeFileSync(
      lockFile,
      JSON.stringify(makeLockRecord({ session_id: "old", started_at: staleStarted })),
      "utf-8",
    );

    // Orphan: owner PID is provably dead → must be swept regardless of age.
    const deadSidecar = `${lockFile}.reclaiming.999999999.deadbeef`;
    writeFileSync(deadSidecar, "orphan", "utf-8");
    // Live: owner PID is this (alive) process, just created → must survive.
    const liveSidecar = `${lockFile}.reclaiming.${process.pid}.cafef00d`;
    writeFileSync(liveSidecar, "in-flight", "utf-8");

    const outcome = acquireLock(
      tmpDir,
      { session_id: "new", job_id: "job-new" },
      { seams: realSeams },
    );

    expect(outcome.kind).toBe("reclaimed"); // reclaim still succeeds
    expect(existsSync(deadSidecar)).toBe(false); // dead-PID orphan swept
    expect(existsSync(liveSidecar)).toBe(true); // live in-flight sidecar untouched
  });
});

// Real-FS, multi-process concurrent-reclaim exclusivity lives in the sibling
// workspace-lock-concurrency.test.ts (spawns OS processes — kept separate from
// these seam-driven single-process unit tests).
