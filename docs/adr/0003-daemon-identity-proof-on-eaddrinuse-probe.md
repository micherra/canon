---
adr: "0003"
title: "Daemon proves token possession via challenge-response on the EADDRINUSE probe, not a public version match"
status: accepted
date: "2026-06-11"
build: "harden-http-daemon-f1-same-user-token-read-f4-probe-identity-security"
---

# ADR-0003: Daemon identity proof on the EADDRINUSE probe

## Context

The Canon HTTP MCP daemon binds a fixed TCP port (`127.0.0.1:3142`). When a second
daemon starts and the port is already held, `bindDaemonServer` catches `EADDRINUSE`
and calls `probeExistingDaemon`, which GETs the incumbent's `/health` and — if the
returned `version` string matches the probing daemon's own version — calls
`process.exit(0)`, cleanly ceding the port to whatever is listening.

The Phase-3 security assessment flagged this (finding F4): `/health`'s `version` is
PUBLIC and attacker-controllable. A same-user (or token-less) impostor that binds
`:3142` first and serves `{"version":"<plugin version>"}` causes the real daemon to
exit, winning the port — a denial-of-service and bearer-token-capture surface. The
probe authenticates nothing about the incumbent's identity.

This decision ships as part of the Phase-3 hardening that gates the default-transport
flip (stdio → HTTP daemon). A hard constraint discovered while designing: the live
SessionStart supervisor hook greps `/health` for the `version` field to drive its
version-handoff kill, so any fix must not remove or rename that field.

## Options Considered

### Option A: Static token-derived field on `/health`

Have `/health` include a fixed `HMAC_token("canon")` field; the prober compares it.

**Pros:**
- Smallest change — no new route.

**Cons:**
- **Replayable.** Any process that reads `/health` once scrapes the static proof and can serve it back, so it proves nothing against an impostor who probed first.
- Mutates `/health`, risking the supervisor's `version` grep.

**Canon-principle alignment:** Tensions fail-closed-by-default — a replayable proof is not a real proof.

### Option B: Challenge-response HMAC over a nonce on a new authenticated `/identity` route

The prober generates a fresh random nonce, calls the incumbent's authenticated
`GET /identity?nonce=<n>`, which returns `HMAC-SHA256_token(nonce)`; the prober
recomputes with its own token and `timingSafeEqual`-compares.

**Pros:**
- Non-replayable — a fresh nonce per probe makes a scraped response useless; proves LIVE possession of the 0600 token.
- Additive — leaves `/health` (and its `version`) untouched, so the supervisor is unaffected.
- Reuses `node:crypto` (already imported by `auth.ts`); the route sits behind the same auth + loopback-Host guard as `/mcp`.

**Cons:**
- Larger than a one-line guard — a new route, a probe round-trip, and a small pure helper module.

**Canon-principle alignment:** Honors fail-closed-by-default (mismatch → refuse to cede + exit(1)), observable-best-effort (mismatch logged), secrets-never-in-code (transmits a digest, never the token).

### Option C: Unix-domain socket (no port to squat)

**Pros:** Collapses F4 (and F1) entirely — a 0600 UDS cannot be pre-bound by another user.

**Cons:** Blocked upstream — Claude Code `.mcp.json` and the MCP TS SDK have no unix-socket transport. Filed as a future durable-fix epic.

**Canon-principle alignment:** Strictly stronger, but not currently buildable.

## Decision

Chosen: **Option B — challenge-response HMAC over a nonce on a new authenticated `/identity` route.**

Only a challenge-response proves *live* token possession; the static variant is
replayable and therefore not a real identity proof. Option B is additive, so it does
not disturb the supervisor's load-bearing `/health` version grep. It defends against
the realistic cheap attack (a token-less impostor serving a fake `version` and ceding
the port). A same-user attacker who has READ the token can still forge the proof — but
that adversary is already in the F1 "can read the token" trust class, which is the
documented, signed-off residual risk for this phase. Option C is the correct long-term
fix but is upstream-blocked.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | On identity-mismatch the daemon refuses to cede the port and `exit(1)` rather than `exit(0)`. |
| observable-best-effort | honors | Mismatch writes a distinct stderr conflict line — the impostor detection is surfaced, not silent. |
| secrets-never-in-code | honors | The `/identity` route transmits an HMAC digest over a nonce, never the raw token; the helper holds no literal secret. |
| simplicity-first | tensions (accepted) | A challenge-response route is more than a one-line guard; the simpler static-hash variant was rejected because it is replayable. |

## Consequences

**Positive:**
- A token-less port squatter can no longer cheaply force the real daemon to cede the port on a public version match.
- The fix is additive: `/health` and the supervisor's version-handoff logic are unchanged.
- The identity-proof logic is a pure, unit-testable module (`identity-proof.ts`).

**Negative / trade-offs:**
- Adds a wire route (`/identity`) and a probe round-trip to the EADDRINUSE path.
- Does NOT defend against a same-user process that has read the token (out of scope — documented, signed-off residual per the F1 decision).
- Two legitimately-racing same-version daemons must both hold the same token for the probe to pass; a token-rotation race could in principle yield a false `identity-mismatch` (monitored).

## Revisit-If

- A unix-domain-socket transport becomes available upstream (Claude Code `.mcp.json` / MCP TS SDK) — the entire fixed-port squat surface and this route can be removed.
- False `identity-mismatch` is observed on legitimate same-version daemon restarts (e.g. during token rotation).
