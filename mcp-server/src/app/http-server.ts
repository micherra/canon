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
 * - GET  /health                — liveness check
 * - GET  /artifact/:type/:slug — serve registered HTML artifact
 * - OPTIONS *                  — CORS preflight
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

const DEFAULT_PORT = 3141;
const PID_FILENAME = "canon-server.pid";

/** Stored artifact data keyed by `"${type}/${slug}"`. */
const artifacts = new Map<string, { html: string; data: unknown }>();

let httpServer: ReturnType<typeof createServer> | null = null;
let serverPort = DEFAULT_PORT;

// Resolved project scope, seeded at startup by startHttpServer(port, projectDir).
// Used by resolvePidDir instead of process.cwd() — removes the last implicit-scope
// leak (the class Phase 1 sub-build 1c eliminated everywhere else). The standalone
// HTTP listener has no per-request MCP context, so its scope is threaded from
// index.ts's resolved startup dir rather than read from ambient cwd.
let resolvedProjectDir: string | null = null;

/**
 * Returns the port the HTTP server is currently bound to.
 * Returns the configured default when the server has not started yet.
 */
export function getHttpPort(): number {
  return serverPort;
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
 * Writes a PID file containing `${process.pid}\n${port}\n` to `${dir}/canon-server.pid`.
 * Best-effort: logs WARN to stderr on failure, never throws.
 * VITEST guard: if process.env.VITEST is set, callers should pass an explicit dir
 * (tests inject a tmp dir directly — the VITEST guard is on the integration call site).
 *
 * @param dir - Directory to write the PID file into (must already exist or be creatable).
 * @param port - The port the server is bound to.
 */
export async function writePidFile(dir: string, port: number): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PID_FILENAME), `${process.pid}\n${port}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `Canon HTTP server WARN: could not write PID file to ${dir}: ${String(err)}\n`,
    );
  }
}

/**
 * Removes the PID file from `${dir}/canon-server.pid` if and only if its first
 * line matches `process.pid`. This guards against removing another process's PID file
 * in the case of orphaned files from a prior run.
 * Best-effort: failures are logged but never throw.
 *
 * @param dir - Directory containing the PID file.
 */
export async function removePidFile(dir: string): Promise<void> {
  const pidPath = join(dir, PID_FILENAME);
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
 * Returns true when the HTTP server is currently listening (bound to a port).
 * Returns false when the server failed to start (e.g., EADDRINUSE) or has not
 * been started yet.
 */
export function isHttpServerRunning(): boolean {
  return httpServer !== null;
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
export function startHttpServer(port?: number, projectDir?: string): Promise<void> {
  if (projectDir !== undefined) resolvedProjectDir = projectDir;

  // Resolve port: explicit arg → env var → default
  serverPort = port ?? Number.parseInt(process.env.CANON_HTTP_PORT ?? String(DEFAULT_PORT), 10);

  if (Number.isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
    serverPort = DEFAULT_PORT;
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
 * Registers an HTML artifact for serving.
 *
 * @param key - Artifact key in `"${type}/${slug}"` format.
 * @param html - Complete HTML string to serve. Data will be injected before
 *   `</head>` (or `</body>` when no `</head>` is present).
 * @param data - Arbitrary data object serialized as `window.__CANON_DATA__`.
 */
export function registerArtifact(key: string, html: string, data: unknown): void {
  artifacts.set(key, { data, html });
}

/**
 * Removes a registered artifact.
 * Call when the artifact is no longer needed.
 *
 * @param key - Artifact key in `"${type}/${slug}"` format.
 */
export function removeArtifact(key: string): void {
  artifacts.delete(key);
}

/**
 * Clears all registered artifacts.
 * Intended for test isolation only — do not call in production code.
 *
 * @internal
 */
export function resetStateForTesting(): void {
  artifacts.clear();
  resolvedProjectDir = null;
}

// ---------------------------------------------------------------------------
// Internal request handling
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);

  // CORS headers — required for browser fetch from file:// or localhost origins
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    respondJson(res, 200, { ok: true, port: serverPort });
    return;
  }

  // GET /artifact/:type/:slug
  const artifactMatch = url.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)$/);
  if (req.method === "GET" && artifactMatch) {
    const key = `${artifactMatch[1]}/${artifactMatch[2]}`;
    const artifact = artifacts.get(key);
    if (!artifact) {
      respondJson(res, 404, { error: "Artifact not found", key });
      return;
    }
    serveArtifactHtml(res, key, artifact.html, artifact.data);
    return;
  }

  // 404 fallback
  respondJson(res, 404, { error: "Not found" });
}

function serveArtifactHtml(res: ServerResponse, key: string, html: string, data: unknown): void {
  // Inject window globals before </head> (or </body> as fallback)
  const safeData = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const dataScript = `<script>
    window.__CANON_DATA__ = ${safeData};
    window.__CANON_ARTIFACT_URL__ = "http://127.0.0.1:${serverPort}/artifact/${key}";
  </script>`;

  let injectedHtml: string;
  if (html.includes("</head>")) {
    injectedHtml = html.replace("</head>", `${dataScript}\n</head>`);
  } else {
    injectedHtml = html.replace("</body>", `${dataScript}\n</body>`);
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(injectedHtml);
}

function respondJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
