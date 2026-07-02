# mcp-http/ — HTTP Transport Auth and Session Management

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Stateful HTTP MCP transport subsystem: token-based auth, per-session McpServer registry, scope handshake, and idle-session eviction. Flag-dark (CANON_HTTP_DAEMON=1) until Phase 3.

## Architecture
<!-- last-updated: 2026-06-11 -->

| File | Responsibility |
|------|---------------|
| `loopback-host.ts` | Shared DNS-rebinding guard — single source of truth for `LOOPBACK_ALLOWED_HOSTS` set, `extractLoopbackHostname`, `isAllowedLoopbackHost`, `isLoopbackHostRequest`; consumed by `auth.ts`, `daemon.ts`, and `http-server.ts` (sidecar) |
| `auth.ts` | Token lifecycle (`resolveTokenPath`/`loadOrCreateToken` 0600 fail-closed, O_EXCL exclusive create, 0700 parent dir) + request auth (`authenticate` timingSafeEqual, loopback+Host rebinding guards via `loopback-host.ts`, `rereadToken` rate-limited rotation) |
| `identity-proof.ts` | Pure HMAC challenge-response module (F4): `generateNonce`, `computeIdentityProof`, `verifyIdentityProof` (timing-safe, length-guard), `probeIdentity` — authenticated GET /identity probe; returns `"same-version" | "identity-mismatch"` |
| `session-manager.ts` | Per-session `McpServer`+`StreamableHTTPServerTransport` registry; scope handshake (header→roots/list capped retry, fail-closed, fs.realpath-normalized); refcount+pending-handshake-guarded eviction in isolation-finish-01 order (server.close first); idle reaper (`CANON_HTTP_SESSION_TTL_MS`, default 30 min); scope immutable after first registration |

## Contracts
<!-- last-updated: 2026-06-13 -->

**`loopback-host.ts`**
- `LOOPBACK_ALLOWED_HOSTS` — `Set<string>` of allowed loopback hostnames: `"127.0.0.1"`, `"localhost"`, `"[::1]"`; single source of truth for all Canon HTTP endpoints
- `extractLoopbackHostname(host)` — strips port suffix from a raw Host header value; handles IPv6 bracket notation; malformed input returned as-is (rejects at allowlist check)
- `isAllowedLoopbackHost(hostHeader)` — `boolean`; fail-closed (empty string → false)
- `isLoopbackHostRequest(req)` — `boolean`; fail-closed (missing Host header → false → caller returns 403)

**`auth.ts`**
- `resolveTokenPath(env?)` — 2-tier (ADR-0015): `CANON_MCP_TOKEN_FILE` → `~/.claude/canon/canon-mcp-token`; `CLAUDE_PLUGIN_DATA` is intentionally NOT consulted
- `loadOrCreateToken(tokenPath)` — async, fail-closed; parent dir created at `mode:0o700` + explicit `chmod(0o700)` (hardens pre-existing world-traversable dirs); exclusive `writeFile({ flag:"wx" })` (O_EXCL — fails EEXIST, never follows symlinks); on EEXIST re-reads via `rereadToken`, fails closed if invalid; `chmod(0o600)` applied after write (umask-safe); regenerates on empty/whitespace via `unlink`+re-create; returns `TokenResult`
- `authenticate(req, expectedToken)` — sync; loopback remoteAddress check (403), Host header DNS-rebinding guard (403), Bearer presence (401), `crypto.timingSafeEqual` with length-mismatch short-circuit (401)
- `rereadToken(tokenPath)` — async; re-reads file for rate-limited background rotation recovery; fail-closed on delete/ENOENT

**`identity-proof.ts`**
- `generateNonce()` — cryptographically random 32-char hex nonce; unique per probe
- `computeIdentityProof(token, nonce)` — HMAC-SHA256 keyed on token, bound to nonce; returns hex digest; never exposes raw token
- `verifyIdentityProof(token, nonce, proof)` — timing-safe comparison with length guard before `timingSafeEqual`; returns `boolean`
- `probeIdentity(port, token, nonce, timeoutMs?)` — authenticated `GET /identity?nonce=<n>` with Bearer token; returns `"same-version" | "identity-mismatch"`; errors resolve to `"identity-mismatch"` (fail-closed)

**`session-manager.ts`**
- `handleMcpRequest(req, res, port)` — main entry point; routes by session ID; creates transport+server for new POSTs; `cleanupFailedInit` on abrupt close
- `createSessionTransport(port, server, headerDir)` — transport factory; wires `onsessioninitialized` and `onsessionclosed`
- `teardownSession(sessionId)` — idempotent; isolation-finish-01 order: `server.close()` → `clearConnectionScope` → `clearSessionReady` → `evictStoresForScope` → `evictDriftDbForScope` → `evictJobManagerForScope`; refcount guard via `hasOtherSessionsForDir`; pending-handshake guard via `hasPendingHandshakeForDir`
- `resolveSessionScope(session, headerDir)` — layered fail-closed: `x-canon-project-dir` header → `roots/list` retry (3×2s) → gate stays pending; scope never falls back to daemon cwd/env
- `validateAndNormalizeDir(dir)` — allow-list barrier (`isSafeProjectDirInput` from `shared/lib/safe-project-dir.ts`, ADR-0030) applied BEFORE any fs access; returns `undefined` on barrier rejection (fail-closed); surviving inputs pass through `fs.realpath` normalization (handles macOS `/tmp`→`/private/tmp`; `path.resolve` is NOT sufficient)
- `closeAllSessions()` — stops idle reaper; parallel teardown of all sessions; daemon SIGTERM path
- `sessionCount()` — observability accessor
- `startReaper()` / `stopReaper()` — unref'd interval; started lazily on first `onsessioninitialized`

## Invariants
<!-- last-updated: 2026-07-02 -->
- `loopback-host.ts` is the sole definition of the loopback allowlist — do NOT redeclare `LOOPBACK_ALLOWED_HOSTS` or `extractLoopbackHostname` in `auth.ts`, `daemon.ts`, or `http-server.ts`; divergent copies are a security-consistency risk
- `authenticate` always checks remoteAddress (loopback) BEFORE Host header BEFORE token comparison — order is security-critical (defense-in-depth)
- `loadOrCreateToken` returns `{ ok: false }` on any fs error — callers must serve 503 (never fall through to auth)
- `loadOrCreateToken` creates the token with O_EXCL (`flag:"wx"`) — NEVER clobbers a pre-existing file; EEXIST → re-read then fail-closed; protects against symlink pre-plant and race injection
- `loadOrCreateToken` creates parent dir at mode 0700 + explicit `chmod(0700)` — hardens pre-existing world-traversable dirs (umask-safe)
- `identity-proof.ts` never returns the raw token — `/identity` route returns HMAC digest bound to a per-probe nonce only
- Scope resolution never falls back to daemon cwd/env — gate stays pending on all failure paths
- `fs.realpath` used for all root URI normalization — `path.resolve` is explicitly NOT sufficient (macOS symlink issue documented in PROBE-FINDINGS.md)
- `teardownSession` is idempotent — second call is a no-op; unknown session is a no-op
- Scope is immutable after first registration — `roots/list_changed` events that attempt re-registration are logged and dropped
- `server.close()` fires BEFORE eviction chain (isolation-finish-01) — tools must not run against a scope that is being evicted
- Pending handshake blocks eviction — a session in scope-resolution cannot be evicted by a concurrent teardown
- **Realpath at path-comparison seams (watch_NNNNN3)**: every new code path using a filesystem path as a map key, equality comparator, or string-prefix matcher MUST normalize via `fs.realpath()` (not `path.resolve()`) when the path could originate outside the process (client-reported URI, tool input, env var). `path.resolve` does not follow symlinks; on macOS `/tmp` → `/private/tmp`, causing silent key mismatches and broken eviction/refcount guards. The obligation does NOT propagate — re-verify at every new path-comparison site.
