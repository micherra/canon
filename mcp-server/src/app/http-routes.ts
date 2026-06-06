/**
 * Canon HTTP artifact + health routes.
 *
 * Extracted from http-server.ts to keep that module within the line-limit
 * constraint. This module owns:
 *
 * - The artifacts registry (Map<key, { html, data }>)
 * - `registerArtifact` / `removeArtifact` / `resetRoutesStateForTesting`
 * - `handleArtifactRoutes` — the request dispatcher (returns true if handled)
 * - `respondJson` — shared JSON response helper
 * - `RouteContext` — shared context type for port + optional health extras
 *
 * ## Route table
 * - GET /health  → `{ ok: true, port, ...ctx.healthExtra }` (key order preserved)
 * - GET /artifact/:type/:slug → serve registered HTML artifact
 * - OPTIONS * → 204 (preflight — handled by callers that set CORS headers first)
 *
 * Callers are responsible for:
 * 1. Setting CORS headers before calling handleArtifactRoutes.
 * 2. Routing /mcp (or any other application-specific routes) before or after
 *    this handler — handleArtifactRoutes returns `false` for unknown paths so
 *    callers can compose additional routes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context threaded to handleArtifactRoutes from the enclosing server.
 *
 * @property port - The port the server is bound to (injected into /health and artifact URLs).
 * @property healthExtra - Optional extra fields merged into /health response (e.g. version, transport).
 *   When undefined the response is exactly `{ ok: true, port }` — byte-identical to the
 *   stdio sidecar's prior behavior.
 */
export type RouteContext = {
  port: number;
  healthExtra?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Artifacts registry
// ---------------------------------------------------------------------------

/** Stored artifact data keyed by `"${type}/${slug}"`. */
const artifacts = new Map<string, { html: string; data: unknown }>();

/**
 * Registers an HTML artifact for serving via GET /artifact/:type/:slug.
 *
 * @param key - Artifact key in `"${type}/${slug}"` format.
 * @param html - Complete HTML string. Data is injected before `</head>` (or `</body>`).
 * @param data - Arbitrary data object serialized as `window.__CANON_DATA__`.
 */
export function registerArtifact(key: string, html: string, data: unknown): void {
  artifacts.set(key, { data, html });
}

/**
 * Removes a registered artifact. Call when the artifact is no longer needed.
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
export function resetRoutesStateForTesting(): void {
  artifacts.clear();
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

/**
 * Handles artifact and health routes for a Canon HTTP server.
 *
 * Returns `true` when the request was handled (response written), `false` when
 * the route is not owned by this module (caller should handle or return 404).
 *
 * CORS headers and OPTIONS preflight must be handled by the caller before
 * invoking this function (http-server.ts and daemon.ts both set them on every
 * request before delegating).
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param ctx - Route context: port for health/artifact URLs, optional extra health fields.
 * @returns `true` if the request was handled; `false` otherwise.
 */
export function handleArtifactRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${ctx.port}`);

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    respondJson(res, 200, { ok: true, port: ctx.port, ...ctx.healthExtra });
    return true;
  }

  // GET /artifact/:type/:slug
  const artifactMatch = url.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)$/);
  if (req.method === "GET" && artifactMatch) {
    const key = `${artifactMatch[1]}/${artifactMatch[2]}`;
    const artifact = artifacts.get(key);
    if (!artifact) {
      respondJson(res, 404, { error: "Artifact not found", key });
      return true;
    }
    serveArtifactHtml(res, key, artifact.html, artifact.data, ctx.port);
    return true;
  }

  // Route not owned by this module
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function serveArtifactHtml(
  res: ServerResponse,
  key: string,
  html: string,
  data: unknown,
  port: number,
): void {
  // Inject window globals before </head> (or </body> as fallback)
  const safeData = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const dataScript = `<script>
    window.__CANON_DATA__ = ${safeData};
    window.__CANON_ARTIFACT_URL__ = "http://127.0.0.1:${port}/artifact/${key}";
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

/**
 * Writes a JSON response.
 *
 * @param res - Outgoing HTTP response.
 * @param status - HTTP status code.
 * @param data - Data to serialize as JSON.
 */
export function respondJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
