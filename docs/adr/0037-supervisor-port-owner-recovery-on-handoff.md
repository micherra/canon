---
adr: "0037"
title: "The SessionStart supervisor recovers a stale handoff by clearing the real port owner, not just the recorded PID"
status: accepted
date: "2026-07-03"
build: "harden-the-sessionstart-daemon-version-handoff-to-recover-when-the-new"
---

# ADR-0037: Port-owner recovery on the daemon version-handoff

## Context

The Canon HTTP MCP daemon is a shared multi-session singleton on a fixed port
(default `127.0.0.1:3142`). On SessionStart, `session-start-daemon-supervisor.sh`
performs a version handoff when the running daemon is older than the installed
plugin: it kills the old daemon and starts the new one.

The kill was keyed **only to the pid recorded in `canon-daemon.pid`** and used
**SIGTERM only** (a 5s wait, no escalation). When the process actually holding the
port was *not* the recorded pid — or ignored SIGTERM — the old daemon survived, the
new one could not bind, the health poll saw the old version, and the hook merely
printed `old daemon may have survived — start did not succeed` and exited. The session
then ran the whole way on the stale daemon.

This failure hit **3+ consecutive sessions** (2026-07-02 ×2, 2026-07-03). On
2026-07-03 the surviving daemon was 2.15.0, which predated `evaluate_step`, so the
evaluator quality gate fail-open-skipped on *every build* for the entire session. The
directly-observed cause: two `daemon.ts` processes booted ~1.5 days earlier were
squatting the port and were not the recorded pid. The standing mitigation was a manual
`kill + re-run supervisor` dance at every session start.

An empirical probe (build `PROBE-FINDINGS.md`) established the load-bearing facts:
`lsof -nP -iTCP:$PORT -sTCP:LISTEN -t` resolves the listening pid on darwin; a stuck
process can ignore SIGTERM; SIGKILL clears it within 100ms; and the LISTEN port is
re-bindable within 100ms of the owner's death.

## Options Considered

### Option A: Keep the PID-file-keyed kill; just add SIGKILL escalation
- **Pros:** smallest change; fixes the SIGTERM-ignore case for the recorded pid.
- **Cons:** still blind to a survivor that is not the recorded pid — the exact
  observed incident (a squatter outside the pid file). Does not free a port held by an
  unrecorded process.
- **Alignment:** tensions `fail-closed-by-default` — it acts on non-authoritative
  state (the pid file) rather than ground truth (who holds the port).

### Option B: Resolve the real port owner, identity-validate, SIGTERM→SIGKILL, retry start once, then loud WARN
- **Pros:** acts on ground truth; handles squatters and SIGTERM-ignorers; bounded
  waits + exactly one retry; every ambiguous branch (owner unknown, non-Canon owner,
  kill fail, retry fail) fails closed with a loud surface.
- **Cons:** adds an `lsof` dependency (present in practice; lsof-absent is a
  fail-closed branch) and a test seam; force-killing a process the supervisor did not
  spawn is a stronger action that must be gated by identity validation.
- **Alignment:** honors `fail-closed-by-default`, `hooks-fail-closed`, the
  never-blind-kill rule, `functions-do-one-thing`.

### Option C: Periodic auto-swap timer / background version reconciliation
- **Pros:** would keep the daemon continuously current.
- **Cons:** the daemon is a shared multi-session singleton — a unilateral swap errors
  in-flight calls across ALL sessions and risks mid-build version skew. No session has
  swap authority. Explicitly rejected in the 2026-07-02 decision.
- **Alignment:** tensions the singleton-ownership invariant; not buildable safely.

## Decision

Chosen: **Option B.** On a handoff whose start does not reach the target version, the
supervisor resolves the **actual** port owner via `lsof`, and only if that owner's
`ps` command line proves it is a Canon daemon (`tsx` + `daemon.ts`) does it escalate
SIGTERM → bounded grace → SIGKILL and retry the start **exactly once**. Every other
outcome — owner unidentifiable (`lsof` absent), owner not a Canon daemon, kill failed,
or retry still stale — ends in a loud `CANON WARNING/ERROR` surface. The hook still
`exit 0` throughout: "fail closed" for this advisory SessionStart hook means a loud,
non-silent surface, never a non-zero exit that would block session startup.

The recorded pid is retained as the first kill target on the pre-start path, but it is
no longer the *only* authority — port ownership is.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| hooks-fail-closed | honors | Owner-unknown / non-Canon / kill-fail / retry-fail each emit a loud surface; no bare NOTE that reads as success. |
| fail-closed-by-default | honors | The port-owner resolver returns UNKNOWN on lsof-absence rather than silently reporting "port free". |
| (never blind-kill) | honors | A signal is sent only after the pid passes the `ps`-cmdline identity gate; a non-Canon owner is surfaced, never killed. |
| functions-do-one-thing | honors | Three single-purpose helpers (identity, port-owner, escalate-kill) replace inline duplicated logic. |
| idempotent-operations | honors | Bounded TERM grace + KILL wait, exactly one retry, deterministic exit. |
| simplicity-first | tensions (accepted) | A previously-linear script gains helpers + a retry wrapper; justified — the linear form cannot express "clear the real owner and retry", and the bug it fixes burned 3+ sessions and silently disabled a quality gate. |

## Consequences

**Positive:**
- A surviving daemon squatting the port — recorded or not, SIGTERM-ignoring or not —
  is cleared and the session comes up on the target version without human action.
- Genuine non-recovery is loud and actionable instead of a quiet stale-daemon session.
- The identity gate keeps the stronger SIGKILL action from ever touching a non-Canon
  process.

**Negative / trade-offs:**
- Depends on `lsof` for port-owner resolution; its absence forces the fail-closed
  "cannot auto-recover" surface (a portable `ss`/`fuser` fallback is a future option).
- Force-killing a process the supervisor did not spawn is inherently stronger than the
  prior recorded-pid TERM; the identity gate is the mitigation and must never be
  weakened.
- Same-user residual: a same-user process that forges the `tsx`+`daemon.ts` cmdline
  could be SIGKILLed — the same trust class already accepted for the daemon's own
  identity surface (cf. ADR-0003's F1 residual).

## Revisit-If

- A unix-domain-socket transport becomes available upstream (cf. ADR-0003) — the fixed-
  port squat surface disappears and this recovery path can be removed entirely.
- `lsof` proves unavailable in a supported environment — the fail-closed branch would
  fire routinely, signalling the resolver needs a portable alternative.
- Legitimate same-version daemon restarts produce false port-owner kills — tighten the
  identity surface beyond the `ps` cmdline match.
