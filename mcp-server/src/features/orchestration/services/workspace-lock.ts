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
  /**
   * Test-only hook fired once inside the reclaim path, AFTER this caller has
   * observed-and-judged the lock stale but BEFORE it claims the reclaim. Lets a
   * test inject a concurrent reclaimer into the exact TOCTOU window. Never set
   * in production.
   */
  beforeReclaim?: () => void;
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

/**
 * A real, caller-supplied session id is a non-empty string other than the
 * `"unknown"` default that `buildRecord` substitutes for an omitted id.
 *
 * Same-session re-entry must require a real id on BOTH sides: a defaulted
 * `"unknown"` must never equal another `"unknown"` (two distinct
 * missed-parameter callers are NOT the same session). See ADR-0021 P1 #2.
 */
function isRealSessionId(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === "string" && sessionId !== "" && sessionId !== "unknown";
}

/** A reclaim that fell through to a re-read-and-gate (lost the race / lock changed). */
const RECLAIM_GATED = Symbol("reclaim_gated");

/**
 * Exclusively reclaim a lock we have judged stale, keyed to the EXACT bytes we
 * observed on disk (`observedRaw`). Compare-and-acquire — only one concurrent
 * reclaimer of the same observed stale lock can win:
 *
 * 1. Move the current `.lock` aside to a per-caller-unique reclaim path. On
 *    POSIX, the rename of the specific target is atomic: if another reclaimer
 *    already moved/removed it, ours fails `ENOENT` → we lost → gate.
 * 2. Verify the bytes we moved aside still match what we observed. If they
 *    differ, a FRESH foreign lock was written between observe-and-reclaim — we
 *    must not clobber it: restore it and gate.
 * 3. Exclusively create a new `.lock` (`wx`) and write our record. Then remove
 *    the moved-aside file.
 *
 * Returns the new `LockRecord` on success, or `RECLAIM_GATED` when this caller
 * lost the race / the observed lock changed. Fail-safe (D7): any ambiguity or
 * subsystem error during reclaim resolves to GATED, never a silent co-drive.
 */
function reclaimExclusive(
  workspace: string,
  observedRaw: string,
  record: LockRecord,
  seams: LockSeams,
): LockRecord | typeof RECLAIM_GATED {
  const target = lockPath(workspace);
  const suffix = randomBytes(8).toString("hex");
  const asidePath = `${target}.reclaiming.${process.pid}.${suffix}`;

  // Test hook: simulate a concurrent reclaimer entering our TOCTOU window.
  seams.beforeReclaim?.();

  // Step 1 — claim the right to reclaim by moving the observed lock aside.
  try {
    renameSync(target, asidePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return RECLAIM_GATED; // another reclaimer already moved it — we lost
    }
    throw err; // genuinely unexpected FS error — propagate
  }

  // Step 2 — verify we moved aside the SAME bytes we observed. A mismatch means
  // a fresh foreign lock landed between observe and our rename: restore + gate.
  let asideRaw: string;
  try {
    asideRaw = readFileSync(asidePath, "utf-8");
  } catch {
    // Cannot read what we just moved — fail-safe: try to restore, then gate.
    tryRestore(asidePath, target);
    return RECLAIM_GATED;
  }
  if (asideRaw !== observedRaw) {
    tryRestore(asidePath, target);
    return RECLAIM_GATED;
  }

  // Step 3 — we own the reclaim. Exclusively create the new lock.
  let fd: number;
  try {
    fd = openSync(target, "wx");
  } catch {
    // Someone re-created the lock between our move-aside and now — fail-safe:
    // do not clobber it. Drop our aside copy and gate.
    tryUnlink(asidePath);
    return RECLAIM_GATED;
  }
  try {
    writeFileSync(target, JSON.stringify(record), "utf-8");
  } finally {
    closeSync(fd);
  }
  tryUnlink(asidePath);
  return record;
}

/** Best-effort restore of a moved-aside lock; swallows errors (fail-safe gate). */
function tryRestore(asidePath: string, target: string): void {
  try {
    renameSync(asidePath, target);
  } catch {
    tryUnlink(asidePath);
  }
}

/** Best-effort unlink; swallows errors. */
function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone — ignore */
  }
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
    return parseLock(readFileSync(lockPath(workspace), "utf-8"));
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

  // Read the EXACT bytes once — the same bytes drive the staleness judgement and
  // the compare-and-acquire reclaim (so reclaim is keyed to what we observed).
  let observedRaw: string;
  try {
    observedRaw = readFileSync(lockPath(workspace), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Lock vanished between the failed exclusive-create and this read — let
      // the caller retry from the top by treating it as a gate (fail-safe).
      return { kind: "gated", owner: buildFallbackOwner() };
    }
    throw err;
  }

  const existing = parseLock(observedRaw);
  if (existing === null) {
    // Corrupt — check mtime to decide if we can safely reclaim
    return handleCorrupt(workspace, owner, observedRaw, { nowMs, seams, ttlMs });
  }

  // Same-session re-entry: only when BOTH the caller and the on-disk lock carry a
  // REAL (non-"unknown", non-empty) session id AND they match. A defaulted
  // "unknown" must never satisfy this — two distinct missed-parameter callers are
  // NOT the same session (ADR-0021 P1 #2). Same-session refresh is intentionally
  // non-exclusive: a session racing only itself may clobber its own lock safely.
  if (isRealSessionId(owner.session_id) && owner.session_id === existing.session_id) {
    const record = buildRecord(owner, seams);
    writeLockAtomic(workspace, record);
    return { kind: "acquired", record };
  }

  // Valid record: check staleness (TTL primary)
  if (isStale(existing, nowMs, ttlMs)) {
    return reclaimWithReason({
      observedRaw,
      owner,
      previous: existing,
      reason: "ttl",
      seams,
      workspace,
    });
  }

  // Valid record: check PID liveness (secondary — useful only for fully-dead daemon)
  if (isPidDead(existing.pid)) {
    return reclaimWithReason({
      observedRaw,
      owner,
      previous: existing,
      reason: "pid_dead",
      seams,
      workspace,
    });
  }

  // Live foreign lock — HITL gate required
  return { kind: "gated", owner: existing };
}

/**
 * Run an exclusive compare-and-acquire reclaim for a stale/dead-PID lock,
 * mapping the outcome to a `LockOutcome`. A lost race / changed lock gates.
 */
function reclaimWithReason(args: {
  workspace: string;
  owner: { session_id?: string; job_id?: string };
  observedRaw: string;
  previous: LockRecord;
  reason: "ttl" | "pid_dead";
  seams: LockSeams;
}): LockOutcome {
  const { workspace, owner, observedRaw, previous, reason, seams } = args;
  const record = buildRecord(owner, seams);
  const result = reclaimExclusive(workspace, observedRaw, record, seams);
  if (result === RECLAIM_GATED) {
    // Lost the reclaim race (or the lock changed under us). Re-read so the gate
    // surfaces the current owner rather than the stale one we observed.
    return { kind: "gated", owner: readLock(workspace) ?? previous };
  }
  return { kind: "reclaimed", previous, reason, record };
}

/** Parse raw lock bytes into a LockRecord, or null when corrupt/invalid. */
function parseLock(raw: string): LockRecord | null {
  try {
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

/** Handle a corrupt (unparseable) lock file — fail-safe unless mtime is past TTL. */
function handleCorrupt(
  workspace: string,
  owner: { session_id?: string; job_id?: string },
  observedRaw: string,
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
    // Corrupt AND mtime is past TTL — safe to reclaim, but exclusively: two
    // concurrent reclaimers of the same corrupt lock must not both win.
    const record = buildRecord(owner, seams);
    const result = reclaimExclusive(workspace, observedRaw, record, seams);
    if (result === RECLAIM_GATED) {
      return { kind: "gated", owner: readLock(workspace) ?? buildFallbackOwner() };
    }
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
