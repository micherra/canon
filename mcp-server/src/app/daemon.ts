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
import { removePidFile, writePidFile } from "./http-server.ts";
import {
  authenticate,
  loadOrCreateToken,
  resolveTokenPath,
  type TokenResult,
} from "./mcp-http/auth.ts";
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
 * Probes an existing process on the given port's /health endpoint.
 *
 * Returns:
 * - "same-version" — /health responded with the same version string → benign race loss
 * - "different-version" — /health responded with a different version → conflict
 * - "unreachable" — connection refused or timeout → not a Canon daemon
 */
export function probeExistingDaemon(
  port: number,
  myVersion: string,
  timeoutMs = 2000,
): Promise<"same-version" | "different-version" | "unreachable"> {
  return new Promise((resolve) => {
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
            if (parsed.version === myVersion) {
              resolve("same-version");
            } else {
              resolve("different-version");
            }
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
// Daemon start / stop (exported for tests)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Request handler (extracted for line-limit compliance)
// ---------------------------------------------------------------------------

/**
 * Handles a single incoming request for the daemon. Extracted from startDaemon
 * to comply with the noExcessiveLinesPerFunction lint rule.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param tokenResult - Token load result (checked for 503 path).
 * @param version - Package version string (injected into /health).
 */
function handleDaemonRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tokenResult: TokenResult,
  version: string,
): void {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${daemonPort}`);

  if (url.pathname === "/mcp") {
    handleMcpRoute(req, res, tokenResult);
    return;
  }

  // Artifact + health routes (unauthenticated)
  if (
    handleArtifactRoutes(req, res, {
      healthExtra: { transport: "http", version },
      port: daemonPort,
    })
  )
    return;

  // 404 fallback
  respondJson(res, 404, { error: "Not found" });
}

/**
 * Handles the /mcp route: 503 on token-unavailable, auth check, then delegate.
 */
function handleMcpRoute(req: IncomingMessage, res: ServerResponse, tokenResult: TokenResult): void {
  // 503 when token unavailable (fail-closed)
  if (!tokenResult.ok) {
    respondJson(res, 503, {
      detail: tokenResult.error,
      error: "Service unavailable: token not loaded",
    });
    return;
  }
  // Authenticate the request
  const authResult = authenticate(req, tokenResult.token);
  if (!authResult.ok) {
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
 * Binds the daemon server to the configured port and writes the PID file.
 * Extracted from startDaemon for line-limit compliance.
 */
function bindDaemonServer(tokenResult: TokenResult, version: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    daemonServer = createServer((req, res) => handleDaemonRequest(req, res, tokenResult, version));

    daemonServer.on("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const probeResult = await probeExistingDaemon(daemonPort, version);
        if (probeResult === "same-version") {
          process.stderr.write(
            `Canon daemon: port ${daemonPort} already held by same version — exiting cleanly.\n`,
          );
          process.exit(0);
        } else {
          process.stderr.write(
            `CANON ERROR: port ${daemonPort} held by a different process/version ` +
              `(probe: ${probeResult}). Refusing to start.\n`,
          );
          process.exit(1);
        }
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

  // Resolve token
  const tokenPath = opts.tokenPath ?? resolveTokenPath();
  const tokenResult: TokenResult = await loadOrCreateToken(tokenPath);
  if (!tokenResult.ok) {
    process.stderr.write(
      `CANON ERROR: daemon token load failed: ${tokenResult.error}. ` +
        `POST /mcp will return 503 until the token is available.\n`,
    );
  }

  // Read version once at boot
  const version = await readPackageVersion();

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
