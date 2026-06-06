/**
 * session-manager.ts — MCP HTTP session registry, scope handshake, and eviction teardown.
 *
 * Governs:
 * - Per-session transport + server creation (one StreamableHTTPServerTransport per session)
 * - Scope handshake: header override → roots/list → capped retry, fail-closed
 * - Teardown in pinned order (isolation-finish-01): clearConnectionScope →
 *   evictStores → evictDriftDb → evictJobManager
 * - Refcount guard: scope-wide evictions fire only when the LAST session for a dir closes
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
import { fileURLToPath } from "node:url";
import { evictStoresForScope } from "@domains/workspaces/execution-store-cache.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { evictJobManagerForScope } from "@platform/jobs/job-manager.ts";
import { evictDriftDbForScope } from "@platform/storage/drift/drift-db-cache.ts";
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
};

/** Module-private session map. */
const sessions = new Map<string, Session>();

/** Return the current number of active sessions. Used for observability and tests. */
export function sessionCount(): number {
  return sessions.size;
}

/** Close all active sessions (daemon SIGTERM path). */
export async function closeAllSessions(): Promise<void> {
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
export function _injectSessionForTest(sessionId: string, server: McpServer): void {
  const transport = {
    close: async (): Promise<void> => {
      // test stub — no-op close
    },
  } as unknown as StreamableHTTPServerTransport;
  sessions.set(sessionId, { server, sessionId, transport });
}

// ── Scope helpers ──────────────────────────────────────────────────────────

/**
 * Validate that dir is an existing directory, then realpath-normalize it.
 * Returns the normalized path or undefined if invalid.
 *
 * PROBE FINDING: must use fs.realpath, NOT path.resolve, to handle macOS symlinks
 * like /tmp → /private/tmp. Without realpath, two sessions with the same physical
 * directory can produce distinct scope keys, breaking refcounted eviction.
 */
async function validateAndNormalizeDir(dir: string): Promise<string | undefined> {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
    return await realpath(dir);
  } catch {
    return undefined;
  }
}

/**
 * Attempt roots/list on the session's server with a 1s timeout.
 * Returns the first root's realpath-normalized URI as a string, or undefined.
 *
 * PROBE FINDING: root entries may lack name — parse {uri} only.
 * PROBE FINDING: client does NOT declare listChanged — never wait on that notification.
 */
async function tryRootsList(server: McpServer): Promise<string | undefined> {
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
    return await validateAndNormalizeDir(dirPath);
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
 * Returns the resolved directory string or undefined if all attempts fail.
 */
async function retryCappedRootsList(server: McpServer): Promise<string | undefined> {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = 2000;

  // Build a sequential promise chain: attempt1 → (if fail) delay → attempt2 → ...
  // This avoids await-in-loop while still being sequential (required for retry logic).
  const makeAttempt = async (attemptsRemaining: number): Promise<string | undefined> => {
    const dir = await tryRootsList(server);
    if (dir !== undefined) return dir;
    if (attemptsRemaining <= 1) return undefined;
    return delay(BACKOFF_MS).then(() => makeAttempt(attemptsRemaining - 1));
  };

  return makeAttempt(MAX_ATTEMPTS);
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
 */
async function resolveSessionScope(session: Session, headerDir: string | undefined): Promise<void> {
  const { server, sessionId } = session;

  // Layer a: header override
  if (headerDir !== undefined) {
    const normalized = await validateAndNormalizeDir(headerDir);
    if (normalized !== undefined) {
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
  const dir = await retryCappedRootsList(server);
  if (dir !== undefined) {
    registerConnectionScope(sessionId, dir);
    resolveSessionReady(sessionId);
    return;
  }

  // Layer c: all attempts exhausted — gate stays pending (fail-closed)
  console.error(
    `[session-manager] Failed to resolve project scope for session ${sessionId} ` +
      "after 3 attempts. Tools will hang until client-side timeout. " +
      "Set x-canon-project-dir header to bypass roots/list resolution.",
  );
}

// ── Teardown ───────────────────────────────────────────────────────────────

/**
 * Tear down a session in the pinned isolation-finish-01 order:
 * 1. Capture dir BEFORE clearing
 * 2. clearConnectionScope(sessionId); clearSessionReady(sessionId)
 * 3. If no other sessions for this dir: evictStores → evictDriftDb → evictJobManager
 * 4. sessions.delete(sessionId); server.close()
 *
 * Idempotent: bails if session already removed.
 */
export async function teardownSession(sessionId: string): Promise<void> {
  // Idempotency guard — bail if already removed
  const session = sessions.get(sessionId);
  if (!session) return;

  // Step 1: capture dir BEFORE clearing scope
  const dir = getScopeForSession(sessionId);

  // Step 2: clear scope and ready gate
  clearConnectionScope(sessionId);
  clearSessionReady(sessionId);

  // Step 3: scope-wide evictions only when this is the last session for dir
  if (dir !== undefined && !hasOtherSessionsForDir(dir)) {
    evictStoresForScope(dir);
    evictDriftDbForScope(dir);
    evictJobManagerForScope(dir);
  }

  // Step 4: remove from registry; close server (which closes transport)
  sessions.delete(sessionId);
  await session.server.close();
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
      sessions.set(newSessionId, { server, sessionId: newSessionId, transport });
      createSessionReadyGate(newSessionId);
      // Kick off scope resolution without awaiting (non-blocking)
      void resolveSessionScope({ server, sessionId: newSessionId, transport }, headerDir);
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
    // Re-resolve roots/list and update the scope (overwrite is idempotent)
    const dir = await tryRootsList(server);
    if (dir !== undefined) {
      registerConnectionScope(sid, dir);
      resolveSessionReady(sid);
    }
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
