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
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";

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
   * observed-and-judged the lock stale but BEFORE it takes the reclaim token.
   * Lets a test inject a concurrent actor (another reclaimer winning, or a fresh
   * foreign lock landing) into the reclaim window. Never set in production.
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

/**
 * Orphan-sweep threshold for `.lock.reclaiming.*` sidecars. A reclaim's
 * move-aside→wx window is microseconds (fully synchronous), so any sidecar older
 * than this is a crashed reclaimer's orphan, never a live in-flight one. Kept far
 * below `DEFAULT_LOCK_TTL_MS` so orphans cannot accumulate for hours, and far
 * above any real reclaim duration so a concurrent reclaimer's sidecar is never
 * swept. Under the shared daemon all reclaimers share one PID, so age (not
 * dead-PID) is the primary criterion here.
 */
const RECLAIMING_SIDECAR_TTL_MS = 60 * 1000;

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
 * observed on disk (`observedRaw`). Token-serialized, gap-free compare-and-swap —
 * only one reclaimer can replace the lock and a concurrent fresh acquirer can
 * never slip into a gap and co-drive:
 *
 * 1. Win the exclusive reclaim token (`.lock.reclaiming`, `wx`). Concurrent
 *    reclaimers fail `EEXIST` and gate — exactly one reclaims at a time.
 * 2. Under the token, RE-VERIFY `target` still equals the bytes we observed. If
 *    it changed (an earlier reclaimer already installed a fresh lock, or it was
 *    released) → gate without clobbering the fresh lock.
 * 3. Install atomically with `rename(tmp → target)`. `rename` replaces in one
 *    step — `target` is never absent, so no fresh `wx` acquirer can win a gap.
 *
 * Returns the new `LockRecord` on success, or `RECLAIM_GATED` when this caller
 * lost the token race / the observed lock changed. Fail-safe (D7): any ambiguity
 * or subsystem error during reclaim resolves to GATED, never a silent co-drive.
 *
 * This replaces an earlier move-aside+restore scheme whose transient
 * target-absent window let a concurrent fresh acquirer co-drive (it could win the
 * empty slot while a reclaimer that had already installed its lock was displaced).
 */
function reclaimExclusive(
  workspace: string,
  observedRaw: string,
  record: LockRecord,
  seams: LockSeams,
): LockRecord | typeof RECLAIM_GATED {
  const target = lockPath(workspace);
  const tokenPath = `${target}.reclaiming`;

  // Bounded cleanup: remove orphaned reclaim tokens left by crashed reclaimers so
  // they cannot wedge future reclaims unboundedly. Keyed on dead-PID/age — never
  // removes a live concurrent reclaimer's in-flight token.
  sweepStaleReclaimSidecars(workspace, seams);

  // Test hook: simulate a concurrent actor acting before we take the token.
  seams.beforeReclaim?.();

  // Step 1 — win the exclusive right to reclaim. Only one reclaimer holds the
  // token; the rest gate (fail-safe — never two reclaimers replacing at once).
  let tokenFd: number;
  try {
    tokenFd = openSync(tokenPath, "wx");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return RECLAIM_GATED;
    throw err; // genuinely unexpected FS error — propagate
  }

  try {
    // Step 2 — re-verify UNDER the token. If the lock is no longer the exact
    // stale bytes we observed (e.g. an earlier reclaimer already installed a
    // fresh one, or it vanished), do NOT clobber — gate. Any read error → gate.
    let current: string | null;
    try {
      current = readFileSync(target, "utf-8");
    } catch {
      current = null;
    }
    if (current !== observedRaw) return RECLAIM_GATED;

    // Step 3 — install atomically. Write a temp then rename OVER target: rename
    // is atomic and leaves no window where target is absent, so a fresh acquirer
    // can never win a gap. We verified target is still the observed stale lock,
    // so this replace does not clobber a fresh foreign lock.
    const suffix = randomBytes(8).toString("hex");
    const tmp = `${target}.tmp.${process.pid}.${suffix}`;
    writeFileSync(tmp, JSON.stringify(record), "utf-8");
    try {
      renameSync(tmp, target);
    } catch (err) {
      tryUnlink(tmp);
      throw err;
    }
    return record;
  } finally {
    closeSync(tokenFd);
    tryUnlink(tokenPath); // release the reclaim token
  }
}

/**
 * Sweep orphaned `.lock.reclaiming*` tokens left by reclaimers that crashed while
 * holding the reclaim token. An orphan is identified by a dead owner PID (when the
 * name carries one) or an age beyond `RECLAIMING_SIDECAR_TTL_MS`; a live, recent
 * token (a concurrent reclaimer's in-flight file) is left untouched. Best-effort
 * and fail-open — any error aborts the sweep silently (cleanup, never correctness).
 */
function sweepStaleReclaimSidecars(workspace: string, seams: LockSeams): void {
  const nowMs = seams.now?.() ?? Date.now();
  const prefix = `${basename(lockPath(workspace))}.reclaiming`; // ".lock.reclaiming"
  let entries: string[];
  try {
    entries = readdirSync(workspace);
  } catch {
    return; // cannot list — nothing to sweep
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(workspace, name);
    if (isOrphanedSidecar(full, name, prefix, nowMs)) tryUnlink(full);
  }
}

/** True when a `.lock.reclaiming*` token is a crashed orphan (dead PID or aged out). */
function isOrphanedSidecar(fullPath: string, name: string, prefix: string, nowMs: number): boolean {
  // Names may be the bare token ("<prefix>") or carry an owner PID
  // ("<prefix>.<pid>.<rand>"). Parse the PID segment when present.
  const rest = name.slice(prefix.length).replace(/^\./, "");
  const ownerPid = Number.parseInt(rest.split(".")[0] ?? "", 10);
  if (Number.isInteger(ownerPid) && ownerPid > 0 && isPidDead(ownerPid)) return true;
  // Age fallback (primary under the shared daemon, where all PIDs are alive).
  try {
    return nowMs - statSync(fullPath).mtimeMs > RECLAIMING_SIDECAR_TTL_MS;
  } catch {
    return false; // cannot stat — leave it (fail-open)
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

  // We hold the exclusive fd. Write through it (not by re-opening the path) so a
  // concurrent rename of `path` cannot redirect our write to another inode.
  const record = buildRecord(owner, seams);
  try {
    writeSync(fd, JSON.stringify(record));
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
