# ADR-0021 — Workspace Mutex: Fail-Safe Lock with Orchestrator-Supplied Identity

- **Status:** Proposed
- **Date:** 2026-06-24
- **Build:** concurrency-safety-hardening-for-multi-session-canon-orchestration
- **Supersedes:** none. Backs the long-dangling `.lock` reference in `CLAUDE.md`.

## Context

Two Canon orchestrator sessions can co-drive the same workspace and git worktree with no
mechanical guard (real incident 2026-06-24, sessions `72f2b372` + `6429ca3b`, watch_OOOOOOOOOO1–4).
`CLAUDE.md` advertises a `.lock` orchestration file, but **no tool ever created, checked, or
released it** — false confidence. We need a real workspace mutex.

A pre-design probe (`PROBE-FINDINGS.md`) established two facts that force the design:

1. **Canon runs as a single shared HTTP daemon** (`CANON_HTTP_DAEMON=1`). One OS process and one
   `process.env` serve every concurrent session. The server therefore **cannot derive the calling
   session's identity from `process.env`** — the env reflects whichever session booted the daemon
   and is identical for all sessions thereafter. `extra.sessionId` exists per-request under HTTP
   but is `undefined` under stdio, so it is not a portable identity source either.
2. **PID-based liveness is daemon-level only.** All concurrent sessions share the daemon PID, so
   `process.kill(ownerPid, 0)` reports "alive" for a crashed *session* as long as the daemon lives.

## Decision

### 1. Lock identity is supplied by the orchestrator, never derived server-side

`init_workspace` and `finalize_workspace` accept new **optional** params `session_id` and `job_id`,
read by the orchestrator from its own shell env (`CLAUDE_CODE_SESSION_ID`, basename of
`CLAUDE_JOB_DIR`). The server fills `pid` (`process.pid`) and `started_at`
(`new Date().toISOString()`). The `.lock` at `{workspace}/.lock` is:

```json
{ "session_id": "...", "job_id": "...", "started_at": "ISO-8601", "pid": 12345 }
```

Params are optional ⇒ backward-compatible (omitted ⇒ `session_id: "unknown"`); existing
single-session flows and tests are unaffected.

### 2. Acquire uses exclusive-create; staleness is TTL-primary, PID-secondary

Acquire opens the lock with `O_EXCL` (`fs.openSync(path, "wx")`) — the only race-free primitive
when two *processes* (here, two daemon-served sessions sharing a filesystem) contend; plain
temp+rename (`atomic-write.ts`) clobbers and is unsafe for acquire. On `EEXIST`, read the existing
lock and decide:

- **Stale** (now − `started_at` > TTL, default 2h) → reclaim (overwrite) + warn.
- **Owner PID dead** (`process.kill(pid,0)` → ESRCH) → reclaim early (secondary; rarely fires under
  the shared daemon).
- **Live foreign lock** → return a `gated` outcome carrying the foreign owner; the orchestrator
  HITL-gates (take over / read-only / abort) and logs the choice. NOT a silent proceed, NOT a hard
  block (preserves legitimate resume/handoff).

### 3. Fail-safe in both directions (Deterministic-gate invariant)

- A lock-subsystem **error or corrupt `.lock` never silently lets two sessions proceed**: it is
  treated as **gated** unless the TTL has also expired (then reclaim-with-warning).
- A crashed session **never permanently wedges** a workspace: TTL reclaim guarantees recovery;
  `releaseLock` at finalize is idempotent (missing `.lock` = success).
- The lock guard is deterministic and runs in **every** autonomy tier; only the *presentation* of a
  live-foreign-lock (gate vs refuse) is HITL policy.

## Consequences

**Positive:** Converts a silent data-loss hazard into a mechanical guard; backs the `.lock` claim;
reuses the proven file-claims lifecycle (acquire-at-init / check-at-preflight / release-at-finalize)
and the existing atomic-write primitive; zero behavior change for single-session builds.

**Negative / trade-offs:** Identity correctness depends on the orchestrator passing the params (a
behavioral obligation, like the checkpoint/decision call sites) — an orchestrator that omits them
gets a coarser `unknown`-owner lock that still prevents *silent* co-drive but cannot name the peer.
PID liveness contributes little under the shared daemon, so a session that crashes is reclaimed only
after the TTL (2h) — acceptable because finalize-release covers the clean path and TTL covers the
crash path.

**Rejected alternatives:** (a) server reads env for identity — wrong under the shared daemon
(Probe 1); (b) `extra.sessionId` as identity — undefined under stdio, not portable; (c) plain
temp+rename acquire — clobbers, not a mutex; (d) PID-only staleness — daemon-level, can't see dead
sessions; (e) hard-refuse on foreign lock — breaks resume/handoff (watch_OOOOOOOOOO4).
