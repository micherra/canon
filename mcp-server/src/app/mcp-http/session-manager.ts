/**
 * session-manager.ts — MCP HTTP session registry, scope handshake, and eviction teardown.
 *
 * Governs:
 * - Per-session transport + server creation (one StreamableHTTPServerTransport per session)
 * - Scope handshake: header override → roots/list → capped retry, fail-closed
 * - Teardown in pinned order (isolation-finish-01): server.close (drain in-flight) →
 *   clearConnectionScope → evictStores → evictDriftDb → evictJobManager
 * - Refcount guard: scope-wide evictions fire only when the LAST session for a dir closes
 * - Idle-session reaper: sweeps sessions idle past CANON_HTTP_SESSION_TTL_MS (default 30 min)
 * - Pending-handshake registry: prevents eviction during the scope-acquire window (W3)
 * - Immutable scope: once registered, scope cannot be overridden by roots/list_changed (W4)
 *
 * PROBE FINDINGS obligations (PROBE-FINDINGS.md):
 * - fs.realpath-normalize root URIs (client reports file:///private/tmp/... for /tmp cwd on macOS)
 * - Never wait on roots/list_changed (client does not declare listChanged)
 * - Root entries may lack name — parse {uri} only
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evictStoresForScope } from "@domains/workspaces/execution-store-cache.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { evictJobManagerForScope } from "@platform/jobs/job-manager.ts";
import { evictDriftDbForScope } from "@platform/storage/drift/drift-db-cache.ts";
import { isSafeProjectDirInput } from "@shared/lib/safe-project-dir.ts";
import { createCanonServer } from "../create-server.ts";
import {
  clearConnectionScope,
  clearSessionReady,
  createSessionReadyGate,
  getScopeForSession,
  hasOtherSessionsForDir,
  registerConnectionScope,
  resolveSessionReady,
} from "../server-state.ts";

// ── Session type and registry ──────────────────────────────────────────────

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  sessionId: string;
  /** Monotonic timestamp (Date.now()) of the last observed activity. Updated on each request. */
  lastActivityMs: number;
};

/** Module-private session map. */
const sessions = new Map<string, Session>();

/**
 * Pending-handshake registry — tracks sessions that have been created (onsessioninitialized)
 * but whose scope handshake has not yet completed (registerConnectionScope not yet called).
 *
 * Keys are session IDs. Values are the directory hint from the x-canon-project-dir header
 * (if present) or "unknown" when only roots/list resolution is in progress.
 *
 * Used by hasOtherSessionsForDir (via hasOtherPendingSessionsForDir) to prevent eviction
 * of a dir's stores while a new session for that dir is mid-handshake (W3 fix).
 */
const pendingHandshakes = new Map<string, string | "unknown">();

/** Return the current number of active sessions. Used for observability and tests. */
export function sessionCount(): number {
  return sessions.size;
}

// ── Idle-session reaper ────────────────────────────────────────────────────

/**
 * Session TTL in milliseconds. Configurable via CANON_HTTP_SESSION_TTL_MS.
 * Default: 30 minutes. Sessions idle past this duration are torn down by the reaper.
 */
function getSessionTtlMs(): number {
  const envVal = process.env.CANON_HTTP_SESSION_TTL_MS;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 30 * 60 * 1000; // 30 minutes
}

/** Reaper interval handle — unref'd so it never prevents process exit. */
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/** Reaper sweep period: check every 60 seconds regardless of TTL. */
const REAPER_INTERVAL_MS = 60 * 1000;

/**
 * Run a single reaper sweep: tear down any session whose last-activity timestamp
 * is older than the configured TTL.
 */
export function runReaperSweep(): void {
  const ttl = getSessionTtlMs();
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivityMs > ttl) {
      process.stderr.write(
        `[session-manager] Reaping idle session ${id} (idle ${Math.round((now - session.lastActivityMs) / 1000)}s > TTL ${Math.round(ttl / 1000)}s)\n`,
      );
      void teardownSession(id);
    }
  }
}

/**
 * Start the idle-session reaper. Safe to call multiple times — re-entrant guard.
 * The timer is unref'd so it does not prevent process exit in tests.
 */
export function startReaper(): void {
  if (reaperTimer !== null) return;
  reaperTimer = setInterval(runReaperSweep, REAPER_INTERVAL_MS);
  reaperTimer.unref();
}

/**
 * Stop the idle-session reaper (called by closeAllSessions so tests have no leaked timers).
 */
export function stopReaper(): void {
  if (reaperTimer !== null) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

/** Close all active sessions (daemon SIGTERM path). Also stops the reaper. */
export async function closeAllSessions(): Promise<void> {
  stopReaper();
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map((id) => teardownSession(id)));
}

// ── Test-only injection ────────────────────────────────────────────────────

/**
 * Inject a session directly into the registry for testing without going through
 * the full HTTP handshake. DO NOT call in production code.
 *
 * @internal exported for tests only
 */
export function _injectSessionForTest(
  sessionId: string,
  server: McpServer,
  lastActivityMs?: number,
): void {
  const transport = {
    close: async (): Promise<void> => {
      // test stub — no-op close
    },
  } as unknown as StreamableHTTPServerTransport;
  sessions.set(sessionId, {
    lastActivityMs: lastActivityMs ?? Date.now(),
    server,
    sessionId,
    transport,
  });
}

/**
 * Directly inject a pending-handshake entry for testing.
 * @internal exported for tests only
 */
export function _injectPendingHandshakeForTest(
  sessionId: string,
  dirHint: string | "unknown",
): void {
  pendingHandshakes.set(sessionId, dirHint);
}

/**
 * Clear a pending-handshake entry. Used by tests to simulate handshake completion.
 * @internal exported for tests only
 */
export function _clearPendingHandshakeForTest(sessionId: string): void {
  pendingHandshakes.delete(sessionId);
}

/**
 * Invoke resolveSessionScope directly for testing CANON-SCOPE log output.
 * Builds a minimal Session from the provided server mock and delegates to the
 * real resolveSessionScope implementation.
 *
 * @internal exported for tests only
 */
export async function _resolveSessionScopeForTest(
  sessionId: string,
  server: McpServer,
  headerDir: string | undefined,
): Promise<void> {
  const transport = {
    close: async (): Promise<void> => {
      // test stub
    },
  } as unknown as StreamableHTTPServerTransport;
  const session: Session = { lastActivityMs: Date.now(), server, sessionId, transport };
  // Mirror the real onsessioninitialized flow: session must be in the registry
  // before resolveSessionScope runs so the W5 alive-check works correctly.
  // Idempotent: if the caller already injected the session via _injectSessionForTest,
  // we do not overwrite it.
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, session);
  }
  return resolveSessionScope(session, headerDir);
}

/**
 * Call registerRootsChangedHandler for test use. Registers the real W4 notification
 * handler on the provided server+transport pair. Tests capture the handler from
 * server.server.setNotificationHandler and invoke it to exercise the real guard.
 *
 * @internal exported for tests only
 */
export function _registerRootsChangedHandlerForTest(
  server: McpServer,
  transport: InstanceType<typeof StreamableHTTPServerTransport>,
): void {
  registerRootsChangedHandler(server, transport);
}

// ── Scope helpers ──────────────────────────────────────────────────────────

/**
 * Validate that dir is an existing directory, then realpath-normalize it.
 * Returns the normalized path or undefined if invalid.
 *
 * Input is barrier-validated by isSafeProjectDirInput BEFORE any fs access
 * (CodeQL js/path-injection allow-list strategy; see docs/adr/0029).
 *
 * PROBE FINDING: must use fs.realpath, NOT path.resolve, to handle macOS symlinks
 * like /tmp → /private/tmp. Without realpath, two sessions with the same physical
 * directory can produce distinct scope keys, breaking refcounted eviction.
 */
async function validateAndNormalizeDir(dir: string): Promise<string | undefined> {
  try {
    if (!isSafeProjectDirInput(dir)) return undefined; // barrier BEFORE fs access (ADR-0029)
    const resolved = resolve(dir); // normalize (removes any residual .)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return undefined;
    return await realpath(resolved);
  } catch {
    return undefined;
  }
}

/** Result from `tryRootsList` — carries both the raw URI received and the normalized dir. */
type RootsListResult = { uri: string; dir: string };

/**
 * Attempt roots/list on the session's server with a 1s timeout.
 * Returns an object with the raw URI and realpath-normalized dir, or undefined.
 *
 * PROBE FINDING: root entries may lack name — parse {uri} only.
 * PROBE FINDING: client does NOT declare listChanged — never wait on that notification.
 */
async function tryRootsList(server: McpServer): Promise<RootsListResult | undefined> {
  try {
    const result = await server.server.listRoots(undefined, { timeout: 1000 });
    const first = result.roots[0];
    if (!first) return undefined;
    // Root URIs are file:// URIs; convert to path
    let dirPath: string;
    try {
      dirPath = fileURLToPath(first.uri);
    } catch {
      // Not a file:// URI — skip
      return undefined;
    }
    const normalized = await validateAndNormalizeDir(dirPath);
    if (normalized === undefined) return undefined;
    return { dir: normalized, uri: first.uri };
  } catch {
    return undefined;
  }
}

/** Delay helper — extracted to avoid await-in-loop lint violation. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a capped retry sequence for roots/list (3 attempts × 2s backoff).
 * Extracted from resolveSessionScope to eliminate await-in-loop via sequential Promise chaining.
 * Returns the resolved RootsListResult or undefined if all attempts fail.
 */
async function retryCappedRootsList(server: McpServer): Promise<RootsListResult | undefined> {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = 2000;

  // Build a sequential promise chain: attempt1 → (if fail) delay → attempt2 → ...
  // This avoids await-in-loop while still being sequential (required for retry logic).
  const makeAttempt = async (attemptsRemaining: number): Promise<RootsListResult | undefined> => {
    const result = await tryRootsList(server);
    if (result !== undefined) return result;
    if (attemptsRemaining <= 1) return undefined;
    return delay(BACKOFF_MS).then(() => makeAttempt(attemptsRemaining - 1));
  };

  return makeAttempt(MAX_ATTEMPTS);
}

// ── Scope diagnostics ─────────────────────────────────────────────────────

/**
 * Emit a single CANON-SCOPE: diagnostic line to stderr.
 * All scope-resolution decision points log through this helper so grep surfaces them.
 * Logging must never throw — safe string interpolation only, no token/secret values.
 */
function logScope(sessionId: string, parts: Record<string, string>): void {
  const fields = Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.error(`CANON-SCOPE: session=${sessionId.slice(0, 8)} ${fields}`);
}

// ── Scope handshake ────────────────────────────────────────────────────────

/**
 * Resolve the project scope for a session (decision http2-03, layered, fail-closed).
 *
 * Layer a: x-canon-project-dir header (deterministic fast-path for CI)
 * Layer b: roots/list with up to 3 attempts, 2s backoff between attempts
 * Layer c: gate stays pending — tools never run against a guessed dir (fail-closed)
 *
 * Registers the scope and resolves the session ready gate on success.
 * If all attempts fail, logs loudly and leaves the gate pending (client-side timeout).
 *
 * Pending-handshake protocol (W3):
 * - On entry: register a pending-handshake entry for this session so that any
 *   concurrent teardown of another session sharing this dir sees the pending session
 *   and defers eviction.
 * - On exit (success or failure): always remove the pending-handshake entry.
 */
/**
 * Register a pending-handshake entry for `sessionId`.
 *
 * Uses a realpath-normalized header hint when available ("unknown" otherwise).
 * Normalization is mandatory (A8/N3 bug class): registered scopes are stored as
 * realpath values, so the key space must match. Normalization is best-effort —
 * ENOENT falls back to "unknown", which is conservative (blocks eviction).
 */
function registerPendingHandshake(sessionId: string, headerDir: string | undefined): void {
  pendingHandshakes.set(sessionId, headerDir ?? "unknown"); // placeholder
  if (headerDir === undefined) return;
  validateAndNormalizeDir(headerDir).then((normalized) => {
    if (pendingHandshakes.has(sessionId)) {
      pendingHandshakes.set(sessionId, normalized ?? "unknown");
    }
  });
}

async function resolveSessionScope(session: Session, headerDir: string | undefined): Promise<void> {
  const { server, sessionId } = session;
  registerPendingHandshake(sessionId, headerDir);

  try {
    // Layer a: header override
    if (headerDir !== undefined) {
      const normalized = await validateAndNormalizeDir(headerDir);
      if (normalized !== undefined) {
        // W5 guard: re-check session is still alive after the async realpath await.
        // teardownSession() may have removed it while we were waiting. If gone, do
        // NOT register — log and clean up instead (phantom scope → eviction leak).
        if (!sessions.has(sessionId)) {
          logScope(sessionId, {
            reason: "session-closed-during-handshake",
            source: "header",
          });
          return;
        }
        logScope(sessionId, {
          normalized: `"${normalized}"`,
          raw: `"${headerDir}"`,
          source: "header",
        });
        registerConnectionScope(sessionId, normalized);
        resolveSessionReady(sessionId);
        return;
      }
      // Invalid header dir — log and fall through to roots/list
      console.error(
        `[session-manager] x-canon-project-dir "${headerDir}" is not a valid directory; ` +
          `falling through to roots/list for session ${sessionId}`,
      );
    }

    // Layer b: roots/list with capped retry
    const rootsResult = await retryCappedRootsList(server);
    if (rootsResult !== undefined) {
      // W5 guard: re-check session is still alive after the async roots/list await.
      // teardownSession() may have removed it while we were waiting.
      if (!sessions.has(sessionId)) {
        logScope(sessionId, {
          reason: "session-closed-during-handshake",
          source: "roots-list",
        });
        return;
      }
      logScope(sessionId, {
        normalized: `"${rootsResult.dir}"`,
        source: "roots-list",
        uri: `"${rootsResult.uri}"`,
      });
      registerConnectionScope(sessionId, rootsResult.dir);
      resolveSessionReady(sessionId);
      return;
    }

    // Layer c: all attempts exhausted — gate stays pending (fail-closed)
    logScope(sessionId, { reason: "no-resolution-after-retries", source: "fail-closed" });
    console.error(
      `[session-manager] Failed to resolve project scope for session ${sessionId} ` +
        "after 3 attempts. Tools will hang until client-side timeout. " +
        "Set x-canon-project-dir header to bypass roots/list resolution.",
    );
  } finally {
    // Always clear the pending-handshake entry — scope registration is complete (or failed).
    pendingHandshakes.delete(sessionId);
  }
}

// ── Pending-handshake helpers (W3) ────────────────────────────────────────

/**
 * Return true if any pending-handshake session has a dir hint matching `dir`.
 *
 * "unknown" hints are conservatively treated as possible matches — we cannot
 * rule out that the in-progress roots/list will resolve to `dir`. This makes
 * the guard fail-safe: it may defer eviction slightly, but never allows premature
 * eviction of a dir that a mid-handshake session is about to use.
 */
function hasPendingHandshakeForDir(dir: string): boolean {
  for (const hint of pendingHandshakes.values()) {
    if (hint === "unknown" || hint === dir) return true;
  }
  return false;
}

// ── Teardown ───────────────────────────────────────────────────────────────

/**
 * Tear down a session in the corrected isolation-finish-01 order:
 *
 * Decision note (isolation-finish-01): The RELATIVE order within the eviction
 * chain — clearConnectionScope → evictStoresForScope → evictDriftDbForScope →
 * evictJobManagerForScope — is pinned by isolation-finish-01 and MUST NOT be
 * reordered. What this fix (W2) changes is that server.close() now completes
 * BEFORE the eviction chain begins.
 *
 * SDK semantics note (N2): `server.close()` delegates to `Protocol.close()` in
 * the vendored SDK, which calls `transport.close()` only — it does NOT drain or
 * await in-flight tool handler promises. The SDK has no per-handler tracking.
 * The race window (W2) is NARROWED, not eliminated:
 *   - Step 1 (sessions.delete) stops new request dispatch to this session.
 *   - Step 2 (server.close) closes SSE streams and clears the SDK's
 *     `_requestResponseMap`, so no new SDK-level response writes will complete.
 *   - A tool handler already executing when DELETE arrives can still run to
 *     completion and attempt DB access. If the eviction chain fires before it
 *     finishes, better-sqlite3 throws "connection not open"; `gatedWrapHandler`
 *     catches this as an UNEXPECTED error (typed, not a crash).
 *   - Blast radius: a typed tool error, not DB corruption (better-sqlite3 is
 *     synchronous — no mid-statement interleave is possible).
 * For full drain, per-session in-flight counters would be needed (future work).
 *
 * Updated step order:
 * 1. Remove from registry immediately (prevent new requests being dispatched)
 * 2. Close server (awaited) — closes SSE streams; narrows but does not eliminate
 *    the in-flight handler race (see SDK semantics note above)
 * 3. Capture dir BEFORE clearing scope (isolation-finish-01: capture first)
 * 4. clearConnectionScope(sessionId); clearSessionReady(sessionId)
 * 5. If no other sessions (registered OR pending-handshake) for this dir:
 *    evictStores → evictDriftDb → evictJobManager (isolation-finish-01 order preserved)
 *
 * Idempotent: bails if session already removed.
 */
export async function teardownSession(sessionId: string): Promise<void> {
  // Idempotency guard — bail if already removed
  const session = sessions.get(sessionId);
  if (!session) return;

  // Step 1: remove from registry immediately so no new requests are dispatched
  // to this session while teardown is in progress.
  sessions.delete(sessionId);

  // Step 2: close server FIRST (awaited) — closes SSE streams and the SDK's
  // _requestResponseMap, stopping new dispatch. Does NOT drain in-flight tool
  // handler promises (the SDK provides no such mechanism); see the function-level
  // "SDK semantics note (N2)" for the exact blast radius. The eviction chain below
  // is still ordered AFTER this call to minimise (not eliminate) the race window.
  //
  // Decision isolation-finish-01: the RELATIVE order of the eviction chain below
  // (clearConnectionScope → evictStores → evictDriftDb → evictJobManager) is
  // unchanged. We are only prepending server.close() ahead of the entire chain.
  await session.server.close();

  // Step 3: capture dir BEFORE clearing scope (isolation-finish-01)
  const dir = getScopeForSession(sessionId);

  // Step 4: clear scope and ready gate (isolation-finish-01 chain starts here)
  clearConnectionScope(sessionId);
  clearSessionReady(sessionId);

  // Step 5: scope-wide evictions only when this is the last session for dir.
  // W3 guard: also check pendingHandshakes — a session that has been created but
  // hasn't completed scope registration yet must block eviction of its future dir.
  if (dir !== undefined && !hasOtherSessionsForDir(dir) && !hasPendingHandshakeForDir(dir)) {
    logScope(sessionId, { dir: `"${dir}"`, teardown: "evict-scope" });
    evictStoresForScope(dir);
    evictDriftDbForScope(dir);
    evictJobManagerForScope(dir);
  } else {
    const skipReason =
      dir === undefined
        ? "no-scope"
        : hasOtherSessionsForDir(dir)
          ? "other-sessions-active"
          : "pending-handshake";
    const parts: Record<string, string> = { reason: skipReason, teardown: "evict-skipped" };
    if (dir !== undefined) parts.dir = `"${dir}"`;
    logScope(sessionId, parts);
  }
}

// ── Transport factory ──────────────────────────────────────────────────────

/**
 * Build the allowedHosts list for a given port.
 *
 * Must stay in parity with auth.ts's ALLOWED_HOSTS (auth layer) and
 * LOOPBACK_ADDRESSES (loopback check). Both IPv4 and IPv6 loopback forms are
 * included so that clients connecting via [::1] are accepted by both layers.
 *
 * Exported for unit testing parity assertions.
 */
export function buildAllowedHosts(port: number): string[] {
  return [
    "127.0.0.1",
    `127.0.0.1:${port}`,
    "localhost",
    `localhost:${port}`,
    "[::1]",
    `[::1]:${port}`,
  ];
}

/** Create a stateful StreamableHTTPServerTransport for a new HTTP session. */
function createSessionTransport(
  port: number,
  server: McpServer,
  headerDir: string | undefined,
): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    allowedHosts: buildAllowedHosts(port),
    enableDnsRebindingProtection: true,
    onsessionclosed: (closedSessionId) => {
      void teardownSession(closedSessionId);
    },
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, {
        lastActivityMs: Date.now(),
        server,
        sessionId: newSessionId,
        transport,
      });
      createSessionReadyGate(newSessionId);
      // Kick off scope resolution without awaiting (non-blocking)
      void resolveSessionScope(
        { lastActivityMs: Date.now(), server, sessionId: newSessionId, transport },
        headerDir,
      );
      // Start the idle-session reaper if not already running.
      // Safe to call multiple times — startReaper() is idempotent.
      startReaper();
    },
    sessionIdGenerator: () => randomUUID(),
  });

  // Also wire onclose for abrupt closes (teardown is idempotent)
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) void teardownSession(sid);
  };

  return transport;
}

/**
 * First-time scope registration from roots/list_changed (W5-guarded).
 * Extracted to keep registerRootsChangedHandler's handler complexity within limits.
 */
async function resolveFirstTimeScopeFromRootsChanged(
  server: McpServer,
  sid: string,
): Promise<void> {
  const rootsResult = await tryRootsList(server);
  if (rootsResult === undefined) return;
  // W5 guard: re-check session is still alive after the async tryRootsList await.
  // teardownSession() may have removed it during the await (same race as W5b).
  if (!sessions.has(sid)) {
    logScope(sid, {
      reason: "session-closed-during-handshake",
      source: "roots-list-changed",
    });
    return;
  }
  registerConnectionScope(sid, rootsResult.dir);
  resolveSessionReady(sid);
}

/** Register the roots/list_changed notification handler on a server. */
function registerRootsChangedHandler(
  server: McpServer,
  transport: StreamableHTTPServerTransport,
): void {
  // PROBE FINDING: client does not declare listChanged but we handle it defensively
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    const sid = transport.sessionId;
    if (!sid) return;
    const session = sessions.get(sid);
    if (!session) return;

    // W4 fix: scope is IMMUTABLE once registered. If a scope is already registered
    // for this session, ignore (and log) any roots/list_changed that would change it.
    // This prevents a late notification from silently replacing a header-pinned scope
    // (decision http2-03 layer a, the "deterministic fast-path for CI") and avoids
    // the stale-resource leak that occurs when scope changes without triggering eviction.
    const existingDir = getScopeForSession(sid);
    if (existingDir !== undefined) {
      // Scope already set — resolve silently (re-resolution is a no-op)
      const newResult = await tryRootsList(server);
      if (newResult !== undefined && newResult.dir !== existingDir) {
        process.stderr.write(
          `[session-manager] roots/list_changed for session ${sid}: ignoring dir change ` +
            `from "${existingDir}" to "${newResult.dir}" — scope is immutable after first registration.\n`,
        );
      }
      return;
    }

    // Scope not yet registered — delegate to W5-guarded helper
    await resolveFirstTimeScopeFromRootsChanged(server, sid);
  });
}

// ── Request handler ────────────────────────────────────────────────────────

/**
 * Main request entry point for any /mcp request (auth already verified by http2-04).
 *
 * Known session (mcp-session-id header present and in registry):
 *   → delegate to session.transport.handleRequest (SDK handles POST/GET/DELETE)
 *
 * No session header + POST initialize:
 *   → create new transport+server, wire callbacks, connect server, handle request
 *
 * Other cases (unknown session, no-header non-POST):
 *   → let the SDK return 404/400 via a fresh transport (do not duplicate SDK logic)
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Known session → delegate
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      // Update last-activity timestamp on every dispatched request (W1 reaper input)
      session.lastActivityMs = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }
    // Unknown session ID — fall through to create a new transport that will reject with 404
  }

  // Capture x-canon-project-dir for scope handshake before transport consumes request
  const headerDir = req.headers["x-canon-project-dir"] as string | undefined;

  const server = createCanonServer();
  const transport = createSessionTransport(port, server, headerDir);
  registerRootsChangedHandler(server, transport);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    await cleanupFailedInit(transport);
    throw err;
  }
}

/** Clean up a session that failed during initialization (transport never stored or partially stored). */
async function cleanupFailedInit(transport: StreamableHTTPServerTransport): Promise<void> {
  const sid = transport.sessionId;
  if (sid && sessions.has(sid)) {
    await teardownSession(sid);
  } else {
    try {
      await transport.close();
    } catch {
      // best-effort
    }
  }
}
