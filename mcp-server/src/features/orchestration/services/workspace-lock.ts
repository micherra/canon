/**
 * Workspace mutex — file-based exclusive lock for multi-session Canon orchestration.
 *
 * Design decisions (from ADR-0021):
 * - Acquire uses `fs.openSync(lockPath, "wx")` (exclusive create) — the only race-free
 *   primitive on a shared filesystem. `rename` clobbers; `wx` fails EEXIST atomically.
 * - On EEXIST: read existing lock, apply TTL reclaim (primary) + dead-PID reclaim (secondary).
 * - Fail-safe posture (D7): a corrupt/unreadable lock is treated as GATED (not free) unless
 *   its mtime is also past TTL, in which case we reclaim as `corrupt_and_stale`.
 * - Never throws for expected conditions — all outcomes are values (LockOutcome union).
 * - Identity (`session_id`, `job_id`) is caller-supplied: the shared HTTP daemon cannot
 *   derive the calling session's identity from process.env (see PROBE-FINDINGS.md Probe 1).
 *
 * Reference patterns:
 *   shared/lib/file-claims.ts — lifecycle shape
 *   app/http-server.ts reclaimStalePidFile — PID liveness check
 *   features/orchestration/tools/init-workspace.ts FOUR_HOURS_MS — TTL idiom
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The JSON body stored in `{workspace}/.lock`. */
export type LockRecord = {
  session_id: string;
  job_id: string;
  started_at: string; // ISO-8601
  pid: number;
};

/**
 * Result of an acquire attempt.
 *
 * - `acquired` — we hold the lock; record is our own.
 * - `reclaimed` — the prior lock was stale/dead; we replaced it.
 * - `gated` — a live foreign lock exists; orchestrator must HITL.
 */
// canon:allow-unwired: type is inlined into init-workspace.ts InitWorkspaceResult (not imported directly); exposed for future diagnostic consumers
export type LockOutcome =
  | { kind: "acquired"; record: LockRecord }
  | {
      kind: "reclaimed";
      record: LockRecord;
      previous: LockRecord;
      reason: "ttl" | "pid_dead" | "corrupt_and_stale";
    }
  | { kind: "gated"; owner: LockRecord };

/** Injectable seams for tests — override clock and PID sources. */
// canon:allow-unwired: test-only injection type; not imported by production code
export type LockSeams = {
  now?: () => number; // default: Date.now
  pid?: () => number; // default: process.pid
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 2-hour default TTL for workspace mutex. Safely exceeds any real build step.
 * Q3 decision: TTL-primary staleness; PID-secondary. */
// canon:allow-unwired: test-only constant for seam injection; not imported by production code
export const DEFAULT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function lockPath(workspace: string): string {
  return join(workspace, ".lock");
}

/** Return true when `process.kill(pid, 0)` indicates the process is dead. */
function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false; // EPERM = alive (we just lack permission) or success = alive
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Build a new LockRecord with caller-supplied identity and seam-injected pid/clock. */
function buildRecord(
  owner: { session_id?: string; job_id?: string },
  seams: LockSeams,
): LockRecord {
  return {
    job_id: owner.job_id ?? "unknown",
    pid: seams.pid?.() ?? process.pid,
    session_id: owner.session_id ?? "unknown",
    started_at: new Date(seams.now?.() ?? Date.now()).toISOString(),
  };
}

/** Write a new lock atomically: write to a temp file then rename over target.
 * This is safe AFTER we have confirmed we should take the lock (reclaim path).
 * For the initial acquire we use `wx` exclusive create instead. */
function writeLockAtomic(workspace: string, record: LockRecord): void {
  const target = lockPath(workspace);
  const suffix = randomBytes(4).toString("hex");
  const tmp = `${target}.tmp.${process.pid}.${suffix}`;
  writeFileSync(tmp, JSON.stringify(record), "utf-8");
  renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Read the current `.lock` file.
 * Returns null on ENOENT or when the file content cannot be parsed as a LockRecord.
 * Never throws.
 */
// canon:allow-unwired: diagnostic helper; referenced in tests only today, reserved for future lock-inspector tooling
export function readLock(workspace: string): LockRecord | null {
  try {
    const raw = readFileSync(lockPath(workspace), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).session_id !== "string"
    ) {
      return null;
    }
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Returns true when `record.started_at` is older than `ttlMs`.
 * An unparseable `started_at` is treated as stale — an unjudgeable timestamp must not wedge.
 */
export function isStale(record: LockRecord, nowMs: number, ttlMs: number): boolean {
  const age = nowMs - Date.parse(record.started_at);
  if (!Number.isFinite(age)) return true; // NaN / unparseable → treat as stale
  return age > ttlMs;
}

/**
 * Acquire the workspace mutex.
 *
 * Algorithm:
 * 1. Try `openSync(lockPath, "wx")` — exclusive create (POSIX-atomic, fails EEXIST).
 *    On success: write our record and return `acquired`.
 * 2. On EEXIST: read existing lock.
 *    a. Corrupt (readLock returns null): check mtime. If mtime is past TTL → reclaim
 *       as `corrupt_and_stale`. Otherwise → gated (fail-safe: never silently free).
 *    b. Valid record + TTL-stale → reclaim, reason "ttl".
 *    c. Valid record + owner PID dead → reclaim, reason "pid_dead".
 *    d. Valid record, live → gated.
 */
export function acquireLock(
  workspace: string,
  owner: { session_id?: string; job_id?: string },
  opts?: { ttlMs?: number; seams?: LockSeams },
): LockOutcome {
  const ttlMs = opts?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const seams = opts?.seams ?? {};
  const nowMs = seams.now?.() ?? Date.now();
  const path = lockPath(workspace);

  let fd: number;
  try {
    fd = openSync(path, "wx"); // exclusive create — fails EEXIST atomically
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err; // unexpected FS error — propagate
    return handleExisting(workspace, owner, { nowMs, seams, ttlMs });
  }

  // We hold the exclusive fd. Write our record then close.
  const record = buildRecord(owner, seams);
  try {
    writeFileSync(path, JSON.stringify(record), "utf-8");
  } finally {
    closeSync(fd);
  }
  return { kind: "acquired", record };
}

/** Handle the case where a lock file already exists (EEXIST path). */
function handleExisting(
  workspace: string,
  owner: { session_id?: string; job_id?: string },
  ctx: { nowMs: number; ttlMs: number; seams: LockSeams },
): LockOutcome {
  const { nowMs, ttlMs, seams } = ctx;
  const existing = readLock(workspace);

  if (existing === null) {
    // Corrupt — check mtime to decide if we can safely reclaim
    return handleCorrupt(workspace, owner, { nowMs, seams, ttlMs });
  }

  // Same-session re-entry: if the new owner's session_id matches the existing lock's
  // session_id, this is the same orchestrator re-acquiring (e.g. a resume after init,
  // or an init after preflight). Refresh the lock with the new record.
  // Note: when both are "unknown" (session_id omitted by caller) this same-session path
  // fires — single-session flows work correctly without a HITL gate.
  const newSessionId = owner.session_id ?? "unknown";
  if (newSessionId === existing.session_id) {
    const record = buildRecord(owner, seams);
    writeLockAtomic(workspace, record);
    return { kind: "acquired", record };
  }

  // Valid record: check staleness (TTL primary)
  if (isStale(existing, nowMs, ttlMs)) {
    const record = buildRecord(owner, seams);
    writeLockAtomic(workspace, record);
    return { kind: "reclaimed", previous: existing, reason: "ttl", record };
  }

  // Valid record: check PID liveness (secondary — useful only for fully-dead daemon)
  if (isPidDead(existing.pid)) {
    const record = buildRecord(owner, seams);
    writeLockAtomic(workspace, record);
    return { kind: "reclaimed", previous: existing, reason: "pid_dead", record };
  }

  // Live foreign lock — HITL gate required
  return { kind: "gated", owner: existing };
}

/** Handle a corrupt (unparseable) lock file — fail-safe unless mtime is past TTL. */
function handleCorrupt(
  workspace: string,
  owner: { session_id?: string; job_id?: string },
  ctx: { nowMs: number; ttlMs: number; seams: LockSeams },
): LockOutcome {
  const { nowMs, ttlMs, seams } = ctx;
  const path = lockPath(workspace);

  let mtimeMs: number;
  try {
    const stat = statSync(path);
    mtimeMs = stat.mtimeMs;
  } catch {
    // Cannot stat — treat as gated (fail-safe: unknown state)
    return { kind: "gated", owner: buildFallbackOwner() };
  }

  if (nowMs - mtimeMs > ttlMs) {
    // Corrupt AND mtime is past TTL — safe to reclaim
    const record = buildRecord(owner, seams);
    writeLockAtomic(workspace, record);
    // previous cannot be a LockRecord (it was corrupt) — synthesize a placeholder
    const previous: LockRecord = {
      job_id: "corrupt",
      pid: 0,
      session_id: "corrupt",
      started_at: new Date(mtimeMs).toISOString(),
    };
    return { kind: "reclaimed", previous, reason: "corrupt_and_stale", record };
  }

  // Corrupt but mtime unknown age or within TTL — gated (fail-safe)
  return { kind: "gated", owner: buildFallbackOwner() };
}

/** Placeholder LockRecord used when we cannot read the real owner (corrupt lock). */
function buildFallbackOwner(): LockRecord {
  return { job_id: "unknown", pid: 0, session_id: "unknown", started_at: "" };
}

/**
 * Release the workspace mutex.
 *
 * - If `.lock` is absent → `{ released: false }` (idempotent, no throw).
 * - If `.lock` exists and owner matches (or owner omitted) → unlink → `{ released: true }`.
 * - If `.lock` exists but owned by a different session → do NOT delete → `{ released: false }`.
 */
export function releaseLock(
  workspace: string,
  owner?: { session_id?: string },
): { released: boolean } {
  const existing = readLock(workspace);
  if (existing === null) {
    // No lock (ENOENT or corrupt) — idempotent success
    return { released: false };
  }

  // If a session_id is provided, only release if it matches
  if (owner?.session_id !== undefined && existing.session_id !== owner.session_id) {
    return { released: false };
  }

  try {
    unlinkSync(lockPath(workspace));
    return { released: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { released: false }; // already gone — idempotent
    }
    throw err;
  }
}
