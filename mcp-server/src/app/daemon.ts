/**
 * Canon MCP HTTP daemon entry point.
 *
 * The daemon is a long-running process that serves the Canon MCP HTTP endpoint
 * on a fixed port (default 3142, configurable via CANON_DAEMON_PORT).
 * It is distinct from the stdio sidecar HTTP server (port 3141) and uses its
 * own PID file (canon-daemon.pid vs canon-server.pid).
 *
 * ## Routes
 * - POST /mcp     — auth-gated MCP endpoint (authenticate → handleMcpRequest)
 * - GET  /health  — unauthenticated liveness probe (returns version + transport)
 * - GET  /artifact/:type/:slug — unauthenticated artifact serving (handled by http-routes)
 * - 404 for all other paths
 *
 * ## Auth model
 * - Token loaded/created at boot via loadOrCreateToken(resolveTokenPath())
 * - If token fails to load: daemon KEEPS SERVING but /mcp returns 503 (fail-closed,
 *   observable via stderr and /health)
 * - /health and artifact routes are NOT token-gated
 *
 * ## EADDRINUSE handling
 * - Probe GET http://127.0.0.1:${port}/health (2s timeout)
 * - Same version → "daemon already running" → process.exit(0) (lost start race, benign)
 * - Different version OR probe fails → "CANON ERROR" → process.exit(1)
 *
 * ## PID file
 * - Written to CLAUDE_PLUGIN_DATA or ~/.claude/canon/ (NEVER a project .canon)
 * - Filename: canon-daemon.pid (not canon-server.pid)
 * - Content: ${pid}\n${port}\n
 *
 * ## Signals
 * - SIGTERM/SIGINT → closeAllSessions() → cleanupAllJobManagers() → removePidFile → exit(0)
 *
 * ## Global ready gate
 * - The daemon calls resolveReady() at boot even though per-session gates govern
 *   all HTTP tool handlers. This prevents any stray code path that falls through
 *   to the global gate from hanging forever. resolveScope() still fails closed for
 *   unregistered sessions — resolving the global gate is safe because there is no
 *   __stdio__ sentinel registered in daemon mode.
 */

import { readFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllJobManagers } from "@platform/jobs/job-manager.ts";
import { handleArtifactRoutes, respondJson } from "./http-routes.ts";
import {
  markDaemonArtifactActive,
  reclaimStalePidFile,
  removePidFile,
  setHttpPort,
  writePidFile,
} from "./http-server.ts";
import {
  authenticate,
  loadOrCreateToken,
  rereadToken,
  resolveTokenPath,
  type TokenResult,
} from "./mcp-http/auth.ts";
import { computeIdentityProof, generateNonce, probeIdentity } from "./mcp-http/identity-proof.ts";
import { isLoopbackHostRequest } from "./mcp-http/loopback-host.ts";
import { closeAllSessions, handleMcpRequest } from "./mcp-http/session-manager.ts";
import { resolveReady } from "./server-state.ts";

// ---------------------------------------------------------------------------
// Constants (exported for test regression guards)
// ---------------------------------------------------------------------------

/** Default port for the Canon MCP HTTP daemon. NOT the same as the stdio sidecar (3141). */
export const DAEMON_DEFAULT_PORT = 3142;

/** PID file filename for the daemon. Distinct from the stdio sidecar's "canon-server.pid". */
export const DAEMON_PID_FILENAME = "canon-daemon.pid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for startDaemon (production uses defaults; tests inject explicit values). */
type DaemonOptions = {
  /** Explicit port override. Defaults to CANON_DAEMON_PORT env → DAEMON_DEFAULT_PORT. */
  port?: number;
  /** Explicit PID directory. Defaults to CLAUDE_PLUGIN_DATA → ~/.claude/canon/. */
  pidDir?: string;
  /** Explicit token path. Defaults to resolveTokenPath(). */
  tokenPath?: string;
};

// ---------------------------------------------------------------------------
// Module state (cleared on stopDaemon for test isolation)
// ---------------------------------------------------------------------------

let daemonServer: ReturnType<typeof createServer> | null = null;
let daemonPort = DAEMON_DEFAULT_PORT;
let daemonPidDir: string | null = null;

/**
 * Token path stored at startup — used for lazy re-read on mismatch (W5).
 * Reset by stopDaemon for test isolation.
 */
let daemonTokenPath: string | null = null;

/**
 * Monotonic timestamp of the last token re-read attempt.
 * Rate-limits re-reads to at most once per second (W5).
 */
let lastTokenRereadMs = 0;

// ---------------------------------------------------------------------------
// Daemon PID dir resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the directory for the daemon's PID file.
 *
 * Resolution order:
 * 1. `pidDir` explicit override (for tests)
 * 2. `CLAUDE_PLUGIN_DATA` env var
 * 3. `~/.claude/canon/` — dev fallback
 *
 * NEVER returns a project .canon directory — the daemon is project-agnostic.
 */
function resolveDaemonPidDir(override?: string): string {
  if (override) return override;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return pluginData;
  return join(homedir(), ".claude", "canon");
}

// ---------------------------------------------------------------------------
// Version reading
// ---------------------------------------------------------------------------

/**
 * Reads the version from the mcp-server package.json.
 * Resolves the path relative to this module's location.
 * Returns "unknown" on any read/parse error (fail-open for /health).
 */
async function readPackageVersion(): Promise<string> {
  try {
    const thisDir = fileURLToPath(new URL(".", import.meta.url));
    // Walk up from src/app/ to find package.json at the mcp-server root
    const pkgPath = join(thisDir, "..", "..", "package.json");
    const content = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// EADDRINUSE probe (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Probes an existing process on the given port via challenge-response identity proof (F4).
 *
 * Step 1: GET /health — version mismatch → "different-version"; connection failure → "unreachable".
 * Step 2: On version match, GET /identity?nonce=<n> with Bearer token to verify HMAC proof.
 *   Valid proof → "same-version" (safe to cede). Proof failure / token unavailable → "identity-mismatch".
 *
 * @param port      - Port to probe.
 * @param myVersion - This daemon's version string.
 * @param myToken   - This daemon's local token; undefined → "identity-mismatch" (fail-closed).
 * @param timeoutMs - Per-request timeout ms (default 2000).
 */
export function probeExistingDaemon(
  port: number,
  myVersion: string,
  myToken: string | undefined,
  timeoutMs = 2000,
): Promise<"same-version" | "different-version" | "identity-mismatch" | "unreachable"> {
  return new Promise((resolve) => {
    // Step 1: GET /health to check version
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        method: "GET",
        path: "/health",
        port,
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { version?: string };
            if (parsed.version !== myVersion) {
              resolve("different-version");
              return;
            }
            // Version matches — proceed to identity challenge-response (Step 2)
            if (myToken === undefined) {
              // Token unavailable locally — cannot prove identity → fail-closed
              resolve("identity-mismatch");
              return;
            }
            // Step 2: challenge-response HMAC proof on /identity
            const nonce = generateNonce();
            probeIdentity(port, myToken, nonce, timeoutMs)
              .then(resolve)
              .catch(() => {
                resolve("identity-mismatch");
              });
          } catch {
            resolve("different-version");
          }
        });
      },
    );
    req.on("error", () => resolve("unreachable"));
    req.on("timeout", () => {
      req.destroy();
      resolve("unreachable");
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Request handler (extracted for line-limit compliance)
// ---------------------------------------------------------------------------

/**
 * Handles a single incoming request for the daemon. Extracted from startDaemon
 * to comply with the noExcessiveLinesPerFunction lint rule.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param tokenResult - Mutable ref to the current token result; may be refreshed in-place.
 * @param version - Package version string (injected into /health).
 */
function handleDaemonRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tokenResult: { current: TokenResult },
  version: string,
): void {
  // CORS headers: only for /mcp (browser MCP clients).
  // Artifact and health routes are browser-navigated directly — no cross-origin
  // script access intended, so no ACAO header is set for those routes (W6).
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${daemonPort}`);

  if (url.pathname === "/mcp") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, x-canon-project-dir, MCP-Protocol-Version",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    handleMcpRoute(req, res, tokenResult);
    return;
  }

  // OPTIONS preflight for non-MCP routes (no CORS, just respond)
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // W6: Apply Host-header rebinding guard to artifact and health routes.
  // These routes serve potentially sensitive content (review HTML, file paths).
  // Direct browser navigation uses the loopback address as Host — this guard
  // preserves that use case while blocking cross-origin JS fetches that would
  // send a different Host header.
  if (!isLoopbackHostRequest(req)) {
    respondJson(res, 403, { error: "Host header rejected" });
    return;
  }

  // Artifact + health routes (unauthenticated, loopback-Host-gated)
  if (
    handleArtifactRoutes(req, res, {
      healthExtra: { transport: "http", version },
      port: daemonPort,
    })
  )
    return;

  // F4: /identity — authenticated challenge-response identity proof route.
  // Auth-gated with the same checks as /mcp (loopback-Host already applied above).
  // Returns HMAC-SHA256_token(nonce) so the prober can verify we hold the live token.
  // Never returns the raw token — only a digest bound to the per-probe nonce.
  if (url.pathname === "/identity" && req.method === "GET") {
    handleIdentityRoute(req, res, tokenResult);
    return;
  }

  // 404 fallback
  respondJson(res, 404, { error: "Not found" });
}

/**
 * Handles the authenticated GET /identity route (F4 identity proof).
 *
 * Auth-gated: 503 on token-unavailable, 401/403 on auth failure (same as /mcp).
 * On auth success: reads `nonce` from the URL query string and responds with
 * `{ proof: HMAC-SHA256_token(nonce) }`. The prober can then recompute the
 * expected HMAC with its own local token and timingSafeEqual-compare.
 *
 * Never returns the raw token — only a digest bound to the per-probe nonce,
 * making it non-replayable (each probe uses a fresh nonce from generateNonce()).
 *
 * @param req         - Incoming HTTP request.
 * @param res         - Outgoing HTTP response.
 * @param tokenResult - Mutable ref to the current token result.
 */
function handleIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  tokenResult: { current: TokenResult },
): void {
  // 503 when token unavailable (fail-closed — cannot produce a proof)
  if (!tokenResult.current.ok) {
    respondJson(res, 503, {
      detail: tokenResult.current.error,
      error: "Service unavailable: token not loaded",
    });
    return;
  }
  // Auth check (loopback + Host + Bearer token)
  const authResult = authenticate(req, tokenResult.current.token);
  if (!authResult.ok) {
    respondJson(res, authResult.status, { error: authResult.reason });
    return;
  }
  // Extract nonce from query string
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${daemonPort}`);
  const nonce = url.searchParams.get("nonce");
  if (!nonce) {
    respondJson(res, 400, { error: "Missing required query parameter: nonce" });
    return;
  }
  // Compute proof — HMAC-SHA256 keyed on our token, bound to the nonce
  const proof = computeIdentityProof(tokenResult.current.token, nonce);
  respondJson(res, 200, { proof });
}

/**
 * Handles the /mcp route: 503 on token-unavailable, auth check, then delegate.
 *
 * W5 fix: on token mismatch, lazily re-read the token file (rate-limited to 1/s)
 * so that token rotation is recovered without restarting the daemon.
 * Token deletion still fails closed (503 path preserved).
 */
function handleMcpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  tokenResult: { current: TokenResult },
): void {
  // 503 when token unavailable (fail-closed)
  if (!tokenResult.current.ok) {
    respondJson(res, 503, {
      detail: tokenResult.current.error,
      error: "Service unavailable: token not loaded",
    });
    return;
  }
  // Authenticate the request
  const authResult = authenticate(req, tokenResult.current.token);
  if (!authResult.ok) {
    // W5: on token mismatch (401), attempt a lazy re-read of the token file
    // (rate-limited: at most once per second). If the file has been rotated to
    // a new value, the refreshed token will be used for subsequent requests.
    // Deletion still fails closed — if re-read returns ok:false, we keep the
    // current (failed-closed) tokenResult and return 401 to the caller.
    if (authResult.status === 401 && daemonTokenPath !== null) {
      const now = Date.now();
      if (now - lastTokenRereadMs >= 1000) {
        lastTokenRereadMs = now;
        rereadToken(daemonTokenPath)
          .then((refreshed) => {
            if (refreshed.ok) {
              tokenResult.current = refreshed;
            }
          })
          .catch(() => {
            // best-effort: ignore re-read errors
          });
      }
    }
    respondJson(res, authResult.status, { error: authResult.reason });
    return;
  }
  // Auth passed — delegate to session manager
  handleMcpRequest(req, res, daemonPort).catch((err: unknown) => {
    process.stderr.write(`CANON ERROR: handleMcpRequest failed: ${String(err)}\n`);
    if (!res.headersSent) {
      respondJson(res, 500, { error: "Internal server error" });
    }
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Handles an EADDRINUSE error on the daemon port via F4 challenge-response probe.
 * Extracted from bindDaemonServer to keep cognitive complexity within Biome limit.
 *
 * Exits the process on all EADDRINUSE outcomes — callers do not need to handle the
 * returned promise; it never resolves (process always exits).
 */
async function handleEaddrinuse(tokenResult: TokenResult, version: string): Promise<never> {
  // F4: pass the local token to enable challenge-response proof.
  // If token unavailable (tokenResult.ok === false), receives undefined → "identity-mismatch" (fail-closed).
  const myToken = tokenResult.ok ? tokenResult.token : undefined;
  const probeResult = await probeExistingDaemon(daemonPort, version, myToken);
  if (probeResult === "same-version") {
    process.stderr.write(
      `Canon daemon: port ${daemonPort} already held by same version (identity verified) — exiting cleanly.\n`,
    );
    process.exit(0);
  } else if (probeResult === "identity-mismatch") {
    // F4 fail-closed + observable: version matched but identity proof failed.
    // Do NOT exit(0) — this may be an impostor. Refuse to cede the port.
    process.stderr.write(
      `CANON ERROR: port ${daemonPort} held by a process that could not prove Canon daemon identity (token mismatch) — refusing to cede. Possible impostor.\n`,
    );
    process.exit(1);
  } else {
    process.stderr.write(
      `CANON ERROR: port ${daemonPort} held by a different process/version ` +
        `(probe: ${probeResult}). Refusing to start.\n`,
    );
    process.exit(1);
  }
}

/**
 * Binds the daemon server to the configured port and writes the PID file.
 * Extracted from startDaemon for line-limit compliance.
 *
 * The tokenResult is wrapped in a mutable ref object so that the W5 lazy re-read
 * in handleMcpRoute can update the current token without rebinding the closure.
 */
function bindDaemonServer(tokenResult: TokenResult, version: string): Promise<void> {
  const tokenRef = { current: tokenResult };
  return new Promise<void>((resolve, reject) => {
    daemonServer = createServer((req, res) => handleDaemonRequest(req, res, tokenRef, version));

    daemonServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        handleEaddrinuse(tokenResult, version).catch(() => process.exit(1));
      } else {
        process.stderr.write(`CANON ERROR: daemon server error: ${err.message}\n`);
        reject(err);
      }
    });

    daemonServer.listen(daemonPort, "127.0.0.1", async () => {
      process.stderr.write(`Canon MCP daemon listening on http://127.0.0.1:${daemonPort}\n`);
      if (daemonPidDir) {
        await writePidFile(daemonPidDir, daemonPort, DAEMON_PID_FILENAME);
      }
      resolve();
    });
  });
}

/**
 * Starts the Canon MCP HTTP daemon.
 *
 * In production this is called once at process startup. Tests call it with
 * explicit port/pidDir/tokenPath to avoid filesystem and port collisions.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  // Resolve port
  daemonPort =
    opts.port ?? Number.parseInt(process.env.CANON_DAEMON_PORT ?? String(DAEMON_DEFAULT_PORT), 10);
  if (Number.isNaN(daemonPort) || daemonPort < 1 || daemonPort > 65535) {
    daemonPort = DAEMON_DEFAULT_PORT;
  }

  // Resolve PID dir
  daemonPidDir = resolveDaemonPidDir(opts.pidDir);

  // F2a: Reclaim a stale daemon pidfile from a previous (dead) process before
  // attempting to bind, so a dead-PID file from a prior run doesn't block or
  // mislead the supervisor. Only removes the file when the recorded PID is dead
  // (ESRCH) or malformed; a live non-owned PID (EPERM) is preserved (F4-safe).
  if (daemonPidDir) {
    await reclaimStalePidFile(daemonPidDir, DAEMON_PID_FILENAME);
  }

  // Resolve token
  const tokenPath = opts.tokenPath ?? resolveTokenPath();
  daemonTokenPath = tokenPath;
  lastTokenRereadMs = 0;
  const tokenResult: TokenResult = await loadOrCreateToken(tokenPath);
  if (!tokenResult.ok) {
    process.stderr.write(
      `CANON ERROR: daemon token load failed: ${tokenResult.error}. ` +
        `POST /mcp will return 503 until the token is available.\n`,
    );
  }

  // Read version once at boot
  const version = await readPackageVersion();

  // DEC-05: Signal to the http-server module that the daemon is actively serving
  // artifacts on its port. This makes isHttpServerRunning() return true and
  // getHttpPort() return the daemon port, so present_artifact / open_artifact
  // can resolve artifact URLs to the daemon instead of returning UNEXPECTED.
  // The daemon already calls handleArtifactRoutes and shares the in-process
  // artifacts Map — only the port/running signal was missing.
  setHttpPort(daemonPort);
  markDaemonArtifactActive();

  // Resolve the global ready gate so stray code paths don't hang.
  // Per-session gates govern all HTTP tool handlers — the global gate
  // is only relevant for the stdio fallback path, which is never taken
  // in daemon mode (no __stdio__ sentinel is registered). Resolving it
  // is safe: resolveScope() still fails closed for unregistered sessions.
  resolveReady();

  return bindDaemonServer(tokenResult, version);
}

/**
 * Stops the daemon gracefully: closes all MCP sessions, cleans up job managers,
 * removes the PID file, and closes the listener.
 *
 * Called by SIGTERM/SIGINT handlers and by test teardown.
 */
export async function stopDaemon(): Promise<void> {
  // Close all MCP sessions (triggers teardown for each session)
  await closeAllSessions();

  // Clean up all job managers
  try {
    cleanupAllJobManagers();
  } catch {
    // Best-effort — do not prevent shutdown
  }

  // Remove PID file (best-effort)
  if (daemonPidDir) {
    await removePidFile(daemonPidDir, DAEMON_PID_FILENAME);
  }
  daemonTokenPath = null;
  lastTokenRereadMs = 0;

  // Close the listener
  await new Promise<void>((resolve) => {
    if (!daemonServer) {
      resolve();
      return;
    }
    const server = daemonServer;
    daemonServer = null;
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Signal handlers (only wired when running as main entry — not in tests)
// ---------------------------------------------------------------------------

/**
 * Wire SIGTERM / SIGINT handlers for graceful shutdown.
 * Called only by the production entry point (boot.sh → daemon.ts main).
 */
export function wireDaemonSignals(): void {
  async function shutdown(signal: string): Promise<void> {
    process.stderr.write(`Canon daemon: received ${signal}, shutting down...\n`);
    await stopDaemon();
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      process.stderr.write(`CANON ERROR: daemon shutdown error: ${String(err)}\n`);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      process.stderr.write(`CANON ERROR: daemon shutdown error: ${String(err)}\n`);
      process.exit(1);
    });
  });
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

// Only run as the main module — skip when imported by tests.
// ESM check: import.meta.url matches process.argv[1] (tsx resolves to the original file).
if (process.env.VITEST === undefined && process.env.CANON_HTTP_DAEMON === "1") {
  wireDaemonSignals();
  startDaemon().catch((err: unknown) => {
    process.stderr.write(`CANON ERROR: daemon startup failed: ${String(err)}\n`);
    process.exit(1);
  });
}
