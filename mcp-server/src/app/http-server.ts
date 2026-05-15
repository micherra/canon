/**
 * Canon HTTP server module.
 *
 * Runs a local HTTP server alongside the stdio MCP transport to serve
 * interactive HTML artifacts and receive synchronous HITL decisions from
 * the browser. All output goes to process.stderr — process.stdout is
 * reserved for the MCP stdio transport.
 *
 * ## Lifecycle
 * Call `startHttpServer()` once from `main()` after `resolveReady()`.
 * The server binds to 127.0.0.1 (localhost only). On EADDRINUSE, a
 * warning is logged but the MCP server continues operating.
 *
 * ## Routes
 * - GET  /health                              — liveness check
 * - GET  /artifact/:type/:slug               — serve registered HTML artifact
 * - POST /artifact/:type/:slug/decision      — receive browser decision (resolves deferred Promise)
 * - OPTIONS *                                — CORS preflight
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const DEFAULT_PORT = 3141;
const BODY_SIZE_LIMIT = 1_048_576; // 1 MB

/**
 * A user decision submitted from the browser after reviewing an artifact.
 * Exported so other modules (e.g., present_artifact tool handler) can type
 * the resolved value of `createDeferredDecision`.
 */
export type Decision = {
  /** User action: approve the artifact or request changes. */
  action: "approve" | "request_changes";
  /** Inline annotations attached to sections of the artifact. May be empty. */
  annotations: unknown[];
};

/** Stored artifact data keyed by `"${type}/${slug}"`. */
const artifacts = new Map<string, { html: string; data: unknown }>();

/** Pending deferred decisions keyed by `"${type}/${slug}"`. */
const pendingDecisions = new Map<string, { resolve: (decision: Decision) => void }>();

let httpServer: ReturnType<typeof createServer> | null = null;
let serverPort = DEFAULT_PORT;

/**
 * Returns the port the HTTP server is currently bound to.
 * Returns the configured default when the server has not started yet.
 */
export function getHttpPort(): number {
  return serverPort;
}

/**
 * Returns true when the HTTP server has successfully bound and is currently
 * listening. Returns false when the server never started (e.g., EADDRINUSE)
 * or has been stopped.
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
 * @returns A Promise that resolves when the server is listening (or when an
 *   EADDRINUSE error is detected).
 */
export function startHttpServer(port?: number): Promise<void> {
  // Resolve port: explicit arg → env var → default
  serverPort = port ?? Number.parseInt(process.env.CANON_HTTP_PORT ?? String(DEFAULT_PORT), 10);

  if (Number.isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
    serverPort = DEFAULT_PORT;
  }

  return new Promise<void>((resolve) => {
    httpServer = createServer(handleRequest);

    httpServer.listen(serverPort, "127.0.0.1", () => {
      process.stderr.write(`Canon HTTP server listening on http://127.0.0.1:${serverPort}\n`);
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
 * Removes a registered artifact and any associated pending decision.
 * Call after a decision is received (or when abandoning an artifact).
 *
 * @param key - Artifact key in `"${type}/${slug}"` format.
 */
export function removeArtifact(key: string): void {
  artifacts.delete(key);
  pendingDecisions.delete(key);
}

/**
 * Clears all registered artifacts and pending decisions.
 * Intended for test isolation only — do not call in production code.
 *
 * @internal
 */
export function resetStateForTesting(): void {
  artifacts.clear();
  pendingDecisions.clear();
}

/**
 * Creates a deferred Promise that resolves when the browser POSTs a decision
 * to `POST /artifact/${key}/decision`.
 *
 * Caller must also call `registerArtifact` so the artifact is available for
 * the browser to load. The Promise resolves with the validated `Decision`
 * object submitted by the user.
 *
 * @param key - Artifact key in `"${type}/${slug}"` format; must match a registered artifact.
 * @returns A Promise that resolves with the user's `Decision` when the browser
 *   submits a decision POST.
 */
export function createDeferredDecision(key: string): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    pendingDecisions.set(key, { resolve });
  });
}

// ---------------------------------------------------------------------------
// Internal request handling
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);

  // CORS headers — required for browser fetch from file:// or localhost origins
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

  // POST /artifact/:type/:slug/decision
  const decisionMatch = url.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)\/decision$/);
  if (req.method === "POST" && decisionMatch) {
    const key = `${decisionMatch[1]}/${decisionMatch[2]}`;
    handleDecisionPost(req, res, key);
    return;
  }

  // 404 fallback
  respondJson(res, 404, { error: "Not found" });
}

function serveArtifactHtml(res: ServerResponse, key: string, html: string, data: unknown): void {
  // Escape JSON for safe embedding in a <script> tag.
  // Replace all '<' with '<' so '</script>' in data cannot break out of the script context.
  const safeJson = JSON.stringify(data).replace(/</g, "\\u003c");

  // Inject window globals before </head> (or </body> as fallback, or appended at end)
  const dataScript = `<script>
    window.__CANON_DATA__ = ${safeJson};
    window.__CANON_ARTIFACT_URL__ = "http://127.0.0.1:${serverPort}/artifact/${key}";
  </script>`;

  let injectedHtml: string;
  if (/<\/head>/i.test(html)) {
    injectedHtml = html.replace(/<\/head>/i, `${dataScript}\n</head>`);
  } else if (/<\/body>/i.test(html)) {
    injectedHtml = html.replace(/<\/body>/i, `${dataScript}\n</body>`);
  } else {
    // Neither </head> nor </body> found — append at end of HTML
    injectedHtml = html + dataScript;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(injectedHtml);
}

function handleDecisionPost(req: IncomingMessage, res: ServerResponse, key: string): void {
  const pending = pendingDecisions.get(key);
  if (!pending) {
    respondJson(res, 404, {
      error: "No pending decision for this artifact",
      key,
    });
    return;
  }

  let body = "";
  let responded = false;

  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > BODY_SIZE_LIMIT) {
      responded = true;
      respondJson(res, 413, { error: "Request body too large" });
      req.destroy();
    }
  });

  req.on("end", () => {
    if (responded) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("action" in parsed) ||
      typeof (parsed as { action: unknown }).action !== "string" ||
      !["approve", "request_changes"].includes((parsed as { action: string }).action)
    ) {
      respondJson(res, 400, {
        error: "Invalid decision: action must be 'approve' or 'request_changes'",
      });
      return;
    }

    const raw = parsed as { action: string; annotations?: unknown[] };
    const decision: Decision = {
      action: raw.action as Decision["action"],
      annotations: Array.isArray(raw.annotations) ? raw.annotations : [],
    };

    pending.resolve(decision);
    pendingDecisions.delete(key);
    artifacts.delete(key);
    respondJson(res, 200, { action: decision.action, ok: true });
  });
}

function respondJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
