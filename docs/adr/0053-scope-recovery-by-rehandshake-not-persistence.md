# ADR-0053 — Recover session scope by re-handshake (spec-404), not by persisting the scope registry

- Status: Accepted
- Date: 2026-07-11
- Deciders: architect (design), security review, reviewer

## Context

`resolveScope` (`mcp-server/src/app/server-state.ts`) is the per-session project-isolation trust
boundary. It fails closed — throws — when a session has no entry in the in-memory `scopeRegistry`.
When the shared HTTP daemon restarts mid-session (e.g. a plugin auto-update, observed twice in one
session), the in-memory registry is wiped while the client's logical session persists. The client's
next call then hits an unrecoverable state and the whole session's tool access breaks until manual
reconnect.

The obvious fix — "persist the scope registry to disk so it survives restart" — was the PRD's first
proposed alternative. Investigation (PROBE-FINDINGS.md P1) falsified it: the MCP transport
`sessionId` is a per-connect `randomUUID()` (SDK `sessionIdGenerator`), regenerated on every
`initialize`. A restarted daemon never re-issues the old UUID, and a re-initializing client presents
a brand-new one. A persisted `Map<sessionId, dir>` would key on values that never recur — it cannot
match anything after a restart.

Investigation also established (PROBE-FINDINGS.md P3) that session scope is *always* derived from
client-supplied input — the `x-canon-project-dir` header or the client's `roots/list` — validated
through the `isSafeProjectDirInput` barrier (ADR-0030) + `fs.realpath`, stored per session id, and
immutable after first registration (W4). There is no daemon-held secret scope record and no source
more trustworthy than that authentic handshake.

## Decision

**Recover scope by driving the client's authentic re-registration handshake, not by persisting or
re-deriving scope inside `resolveScope`.**

Concretely, in the daemon connection path (`session-manager.ts` `handleMcpRequest`): a request that
carries a non-empty `mcp-session-id` header unknown to the in-memory `sessions` map is a stale
(post-restart) non-initialize request — an `initialize` request carries no session-id header. Respond
to it directly with the **spec-compliant 404 `-32001` "Session not found"** (matching the SDK's own
`createJsonErrorResponse` body shape), instead of routing it through a throwaway uninitialized
transport that emits `400 "Server not initialized"` (PROBE-FINDINGS.md P2). 404 is the documented
MCP signal for an invalid session id; it tells the client to discard the dead session and
re-initialize, at which point scope is re-established through the normal `resolveSessionScope`
handshake on the new session id.

`resolveScope` is left unchanged: a pure, synchronous, fail-closed registry lookup. It does **not**
recover-on-miss, because the only inputs available to it are the ephemeral session id (useless after
restart) and client-supplied hints on `extra` (trusting them would breach the isolation boundary).

## Consequences

**Positive**
- Isolation is preserved with zero new spoofing surface: recovery reuses the exact initial-registration
  trust path (per-session, barrier-validated, immutable, never cross-readable). No client-asserted
  scope is ever trusted outside that handshake.
- `resolveScope` stays a clean fail-closed accessor; AC#3 (genuinely-unknown → fail closed, never a
  wrong/global scope) holds unchanged.
- Removes a Canon-side deviation from the MCP spec (wrong status code) and a per-stale-request
  `createCanonServer()` allocation leak.
- No new at-rest artifact to secure, tamper with, or migrate.

**Negative / costs**
- Recovery is not literally same-session-id: the client obtains a new MCP session. This is inherent to
  the SDK's ephemeral-session-id model (P1), not a limitation of this choice. "Self-heal" is delivered
  at the logical-session layer (client re-initializes transparently), not as a `resolveScope`-internal
  return.
- The final hop depends on the client re-initializing on a 404 (PROBE-FINDINGS.md P5, confidence:
  medium — a client property, not observable in-repo). Returning the spec-compliant 404 is correct
  regardless; the daemon cannot recover a dead session without the client re-initializing.

## Alternatives considered

- **Persist the scope registry to disk.** Rejected: keys are ephemeral randomUUIDs (P1) — persistence
  cannot match a post-restart request.
- **Recover-on-miss inside `resolveScope` from an `extra`-carried header hint.** Rejected: couples the
  pure scope accessor to HTTP transport internals and re-introduces trust of client-supplied scope
  outside the barrier-guarded handshake — a direct isolation-boundary risk.
- **Re-derive scope from a daemon-owned session→scope table keyed by `CLAUDE_CODE_SESSION_ID`.**
  Rejected: that id is the Claude Code client session, not the MCP transport session; no such join
  exists and it is still client-reported.
