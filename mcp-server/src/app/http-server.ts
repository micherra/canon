/**
 * Canon HTTP server module.
 *
 * Runs a local HTTP server alongside the stdio MCP transport to serve
 * interactive HTML artifacts. All output goes to process.stderr —
 * process.stdout is reserved for the MCP stdio transport.
 *
 * ## Lifecycle
 * Call `startHttpServer()` once from `main()` after `resolveReady()`.
 * The server binds to 127.0.0.1 (localhost only). On EADDRINUSE, a
 * warning is logged but the MCP server continues operating.
 *
 * ## Routes
 * Delegated to `http-routes.ts`:
 * - GET  /health                — liveness check
 * - GET  /artifact/:type/:slug — serve registered HTML artifact
 * - OPTIONS *                  — preflight (204, no CORS headers)
 *
 * ## Security
 * A Host-header guard (DNS-rebinding protection) rejects requests whose Host
 * does not name a loopback address (127.0.0.1, localhost, [::1]). Missing Host
 * headers are also rejected (fail-closed). No Access-Control-Allow-Origin header
 * is set — artifacts are opened via direct browser navigation, not cross-origin
 * fetch, so ACAO is not needed and would be a data-exfiltration risk (F2 fix).
 *
 * ## PID file
 * On successful bind, `startHttpServer` writes a PID file under
 * `${CLAUDE_PLUGIN_DATA}` or, when unset, the resolved startup project scope's
 * `.canon/` dir (threaded from index.ts — no implicit process.cwd() fallback).
 * `stopHttpServer` calls `removePidFile` to clean up on graceful shutdown.
 * Both operations are best-effort: failures are logged but never throw.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  handleArtifactRoutes,
  resetRoutesStateForTesting,
  respondJson,
  registerArtifact as routesRegister,
  removeArtifact as routesRemove,
} from "./http-routes.ts";
import { isLoopbackHostRequest } from "./mcp-http/loopback-host.ts";

/**
 * Registers an HTML artifact for serving via GET /artifact/:type/:slug.
 * Delegates to http-routes.ts. Kept here so existing callers of http-server.ts
 * (features/orchestration, ui/snippets) are unaffected.
 *
 * @param key - Artifact key in `"${type}/${slug}"` format.
 * @param html - Complete HTML string to serve.
 * @param data - Arbitrary data object serialized as `window.__CANON_DATA__`.
 */
export function registerArtifact(key: string, html: string, data: unknown): void {
  routesRegister(key, html, data);
}

/**
 * Removes a registered artifact.
 * Delegates to http-routes.ts. Kept here so existing callers of http-server.ts are unaffected.
 *
 * @param key - Artifact key in `"${type}/${slug}"` format.
 */
export function removeArtifact(key: string): void {
  routesRemove(key);
}

const DEFAULT_PORT = 3141;
const DEFAULT_PID_FILENAME = "canon-server.pid";

let httpServer: ReturnType<typeof createServer> | null = null;
let serverPort = DEFAULT_PORT;

// Resolved project scope, seeded at startup by startHttpServer(port, projectDir).
// Used by resolvePidDir instead of process.cwd() — removes the last implicit-scope
// leak (the class Phase 1 sub-build 1c eliminated everywhere else). The standalone
// HTTP listener has no per-request MCP context, so its scope is threaded from
// index.ts's resolved startup dir rather than read from ambient cwd.
let resolvedProjectDir: string | null = null;

// DEC-05: daemon artifact-serving signal.
// When the HTTP daemon (daemon.ts) is running and serving artifacts, it calls
// markDaemonArtifactActive() and setHttpPort(daemonPort) so that isHttpServerRunning()
// returns true and getHttpPort() returns the daemon's port. This lets present_artifact
// and open_artifact resolve URLs to the daemon rather than refusing with UNEXPECTED.
// Cleared by resetStateForTesting() for test isolation.
let daemonArtifactActive = false;

/**
 * Returns the port the HTTP server is currently bound to.
 * Returns the configured default when the server has not started yet.
 * In daemon mode (DEC-05), returns the daemon port set by setHttpPort().
 */
export function getHttpPort(): number {
  return serverPort;
}

/**
 * Sets the HTTP port explicitly. Used by the daemon (DEC-05) to signal that
 * artifacts are being served on the daemon's port rather than the default 3141.
 *
 * @param port - The port the daemon is listening on (typically 3142).
 */
export function setHttpPort(port: number): void {
  serverPort = port;
}

/**
 * Marks that the HTTP daemon is actively serving artifacts on the daemon port.
 * Called by daemon.ts startDaemon() so that isHttpServerRunning() returns true
 * in daemon mode, enabling present_artifact / open_artifact to resolve URLs.
 *
 * DEC-05: the daemon serves artifacts via the same in-process artifacts Map as
 * the sidecar, but because it starts its own HTTP server (daemon.ts → createServer),
 * the sidecar's httpServer variable stays null. This flag bridges that gap.
 */
export function markDaemonArtifactActive(): void {
  daemonArtifactActive = true;
}

/**
 * Resolves the directory where the PID file should be written.
 * Prefer CLAUDE_PLUGIN_DATA; fall back to the resolved startup project scope's
 * .canon dir. No implicit process.cwd() fallback — scope is threaded from
 * index.ts (Phase 2 isolation-finish).
 *
 * Returns null when no scope is resolvable (neither CLAUDE_PLUGIN_DATA nor a
 * seeded project scope). This is an expected condition, not an error: callers
 * skip the PID operation rather than leaking a cwd-derived directory. Fail-closed
 * is preserved exactly — a null return NEVER falls back to an arbitrary dir.
 * Exported for testing.
 */
export function resolvePidDir(): string | null {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return pluginData;
  if (resolvedProjectDir) return join(resolvedProjectDir, ".canon");
  return null;
}

/**
 * Writes a PID file containing `${process.pid}\n${port}\n` to `${dir}/${filename}`.
 * Best-effort: logs WARN to stderr on failure, never throws.
 * VITEST guard: if process.env.VITEST is set, callers should pass an explicit dir
 * (tests inject a tmp dir directly — the VITEST guard is on the integration call site).
 *
 * @param dir - Directory to write the PID file into (must already exist or be creatable).
 * @param port - The port the server is bound to.
 * @param filename - Optional PID file name; defaults to "canon-server.pid" (additive default
 *   keeps stdio callers unchanged). The daemon passes "canon-daemon.pid".
 */
export async function writePidFile(
  dir: string,
  port: number,
  filename: string = DEFAULT_PID_FILENAME,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), `${process.pid}\n${port}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `Canon HTTP server WARN: could not write PID file to ${dir}: ${String(err)}\n`,
    );
  }
}

/**
 * Reclaims a stale PID file left by a previous (dead) process.
 *
 * Decision logic:
 * - File absent / unreadable → return (nothing to do; fail-open).
 * - PID line malformed (NaN) → remove the file (corrupt/stale).
 * - `process.kill(pid, 0)` throws ESRCH → process is dead → remove.
 * - `process.kill(pid, 0)` throws EPERM → process is alive but NOT ours → PRESERVE.
 * - `process.kill(pid, 0)` succeeds → process is alive (same user) → PRESERVE.
 *
 * Best-effort: any unexpected error is swallowed so a reclaim failure never
 * blocks boot. The comment below tags the suppression point per the
 * hooks-observable-failures convention (TS analogue of DOCUMENTED FAIL-OPEN).
 *
 * F4-preservation: this function only removes files for DEAD PIDs. It never
 * signals, kills, or cedes a port held by a live daemon.
 *
 * @param dir - Directory containing the PID file.
 * @param filename - PID file name.
 */
export async function reclaimStalePidFile(dir: string, filename: string): Promise<void> {
  const pidPath = join(dir, filename);
  try {
    let content: string;
    try {
      content = await readFile(pidPath, "utf8");
    } catch {
      // File absent or unreadable — nothing to reclaim.
      // DOCUMENTED FAIL-OPEN -- absent pidfile on first boot is expected; continue.
      return;
    }

    const pid = Number.parseInt(content.split("\n")[0] ?? "", 10);
    if (Number.isNaN(pid)) {
      // Malformed/corrupt pidfile — remove it.
      await rm(pidPath, { force: true });
      return;
    }

    try {
      process.kill(pid, 0);
      // No throw → process is alive (ours or same-user) → preserve.
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Process is dead — reclaim.
        await rm(pidPath, { force: true });
      }
      // EPERM → process is alive but not ours → preserve (fall through).
      // DOCUMENTED FAIL-OPEN -- EPERM means a live foreign process holds this PID; preserve.
    }
  } catch {
    // Outer catch: any unexpected fs/logic error — swallow so boot is never blocked.
    // DOCUMENTED FAIL-OPEN -- reclaim failure is non-fatal; a stale pidfile is advisory.
  }
}

/**
 * Removes the PID file from `${dir}/${filename}` if and only if its first
 * line matches `process.pid`. This guards against removing another process's PID file
 * in the case of orphaned files from a prior run.
 * Best-effort: failures are logged but never throw.
 *
 * @param dir - Directory containing the PID file.
 * @param filename - Optional PID file name; defaults to "canon-server.pid" (additive default
 *   keeps stdio callers unchanged). The daemon passes "canon-daemon.pid".
 */
export async function removePidFile(
  dir: string,
  filename: string = DEFAULT_PID_FILENAME,
): Promise<void> {
  const pidPath = join(dir, filename);
  try {
    const content = await readFile(pidPath, "utf8");
    const storedPid = Number.parseInt(content.split("\n")[0] ?? "", 10);
    if (storedPid === process.pid) {
      await rm(pidPath, { force: true });
    }
  } catch {
    // File absent or unreadable — intentional best-effort; nothing to clean up.
    // DOCUMENTED FAIL-OPEN -- PID file may not exist (normal on first boot or already removed)
  }
}

/**
 * Returns true when the HTTP server is currently listening (bound to a port),
 * OR when the HTTP daemon is actively serving artifacts (DEC-05).
 *
 * Returns false when neither the sidecar nor the daemon is running.
 *
 * DEC-05: In daemon mode, `httpServer` stays null (the sidecar never starts),
 * but `daemonArtifactActive` is set by `markDaemonArtifactActive()` from
 * `daemon.ts startDaemon()`. This enables present_artifact / open_artifact
 * to resolve artifact URLs without returning UNEXPECTED.
 */
export function isHttpServerRunning(): boolean {
  return httpServer !== null || daemonArtifactActive;
}

/**
 * Starts the Canon HTTP server and binds it to 127.0.0.1.
 *
 * Port resolution order:
 * 1. `port` argument (explicit, used by tests)
 * 2. `CANON_HTTP_PORT` environment variable
 * 3. Default port 3141
 *
 * On EADDRINUSE: logs a warning to stderr and resolves without throwing —
 * the MCP server continues operating; HTTP artifacts become unavailable.
 *
 * @param port - Optional explicit port; overrides env var and default.
 * @param projectDir - Optional resolved startup project scope. When provided,
 *   seeds the module scope used by resolvePidDir (replacing the removed
 *   process.cwd() implicit-scope leak). Threaded from index.ts's resolvedDir.
 * @returns A Promise that resolves when the server is listening (or when an
 *   EADDRINUSE error is detected).
 */
export async function startHttpServer(port?: number, projectDir?: string): Promise<void> {
  if (projectDir !== undefined) resolvedProjectDir = projectDir;

  // Resolve port: explicit arg → env var → default
  serverPort = port ?? Number.parseInt(process.env.CANON_HTTP_PORT ?? String(DEFAULT_PORT), 10);

  if (Number.isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
    serverPort = DEFAULT_PORT;
  }

  // F2a: Reclaim a dead-PID pidfile from a prior run before binding, so the new
  // process can write its own pidfile on successful bind without confusion.
  // Best-effort: failure is swallowed inside reclaimStalePidFile.
  const pidDirForReclaim = resolvePidDir();
  if (pidDirForReclaim) {
    await reclaimStalePidFile(pidDirForReclaim, DEFAULT_PID_FILENAME);
  }

  return new Promise<void>((resolve) => {
    httpServer = createServer(handleRequest);

    httpServer.listen(serverPort, "127.0.0.1", () => {
      if (!process.env.VITEST) {
        process.stderr.write(`Canon HTTP server listening on http://127.0.0.1:${serverPort}\n`);
        // Write PID file for the SessionStart reaper. Best-effort.
        const pidDir = resolvePidDir();
        if (pidDir) {
          writePidFile(pidDir, serverPort).catch(() => {
            // Already logged inside writePidFile; no double-logging needed.
            // DOCUMENTED FAIL-OPEN -- PID file failure is non-fatal; server continues.
          });
        }
      }
      resolve();
    });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `Canon HTTP server: port ${serverPort} is in use. HTTP artifacts unavailable.\n`,
        );
      } else {
        process.stderr.write(`Canon HTTP server error: ${err.message}\n`);
      }
      // Clear the reference — server never bound, so it is unusable.
      httpServer = null;
      // Resolve even on error so callers are not left hanging.
      // MCP server continues operating without the HTTP layer.
      resolve();
    });
  });
}

/**
 * Stops the HTTP server and forcibly closes all active connections.
 * Resolves when the server is fully closed. Used in tests and graceful shutdown.
 *
 * Calls `closeAllConnections()` (Node 18.2+) before `close()` to ensure
 * keep-alive connections are destroyed immediately rather than waiting for
 * client-side timeout.
 */
export function stopHttpServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    const server = httpServer;
    httpServer = null;
    // Remove PID file on graceful shutdown. Best-effort.
    // resolvePidDir() returns null when no scope is resolvable — skip removal
    // rather than leaking cwd. Never falls back to an arbitrary directory.
    const pidDir = resolvePidDir();
    if (pidDir) {
      removePidFile(pidDir).catch(() => {
        // DOCUMENTED FAIL-OPEN -- PID removal failure is non-fatal during shutdown.
      });
    }
    // Destroy all active/keep-alive connections so close() resolves promptly.
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

/**
 * Clears all registered artifacts and module state.
 * Intended for test isolation only — do not call in production code.
 *
 * Resets: registered routes/artifacts, resolvedProjectDir, and daemonArtifactActive
 * (DEC-05 daemon signal). Does NOT reset serverPort — that is server-lifecycle state
 * managed by startHttpServer / stopHttpServer, not per-test state. Resetting it here
 * would break sidecar tests that start a server on a test port and call
 * resetStateForTesting() between tests to clear artifacts.
 *
 * @internal
 */
export function resetStateForTesting(): void {
  resetRoutesStateForTesting();
  resolvedProjectDir = null;
  daemonArtifactActive = false;
}

// ---------------------------------------------------------------------------
// Internal request handling
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // F2: No Access-Control-Allow-Origin — Canon artifacts are opened via direct
  // browser navigation (http://127.0.0.1:<port>/artifact/...), not cross-origin
  // fetch. Setting ACAO: * would allow malicious pages to read sensitive artifact
  // content (review HTML, file paths, architecture details) cross-origin.
  // Confirmed: open_artifact and present_artifact use direct URL navigation only.

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // F2: Reject non-loopback Host headers to block DNS-rebinding attacks.
  // Uses the shared loopback-host guard (mcp-http/loopback-host.ts), which is
  // also applied by daemon.ts (W6) and auth.ts. Fail-closed: missing Host
  // header is treated as non-loopback and rejected with 403.
  if (!isLoopbackHostRequest(req)) {
    respondJson(res, 403, { error: "Host header rejected" });
    return;
  }

  // Delegate to extracted route module (artifact + health routes)
  if (handleArtifactRoutes(req, res, { port: serverPort })) return;

  // 404 fallback
  respondJson(res, 404, { error: "Not found" });
}
