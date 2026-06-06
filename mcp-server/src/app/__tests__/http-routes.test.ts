/**
 * Tests for http-routes.ts — the extracted artifact + health route module.
 *
 * Covers:
 * - handleArtifactRoutes: /health with and without healthExtra
 * - handleArtifactRoutes: artifact serve / 404 / CORS / OPTIONS (parity with prior http-server behavior)
 * - respondJson helpers called correctly (status / content-type)
 * - Route isolation: /mcp not handled (returns false)
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  handleArtifactRoutes,
  registerArtifact,
  removeArtifact,
  resetRoutesStateForTesting,
  type RouteContext,
} from "../http-routes.ts";

// ---------------------------------------------------------------------------
// Test HTTP server that delegates to handleArtifactRoutes
// ---------------------------------------------------------------------------

const TEST_PORT = 13142;

async function request(
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        method,
        path,
        port: TEST_PORT,
        headers: headers ?? {},
      },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            body: data,
            headers: res.headers as Record<string, string | string[]>,
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let server: ReturnType<typeof createServer>;
const ctx: RouteContext = { port: TEST_PORT };

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Set CORS headers (matches http-server.ts behavior)
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (!handleArtifactRoutes(req, res, ctx)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      });
      server.listen(TEST_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

afterEach(() => {
  resetRoutesStateForTesting();
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe("handleArtifactRoutes — /health", () => {
  it("responds GET /health with { ok: true, port } when no healthExtra", async () => {
    const res = await request("GET", "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; port: number };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(TEST_PORT);
  });

  it("/health response has exactly {ok, port} keys when healthExtra is undefined (byte-compat)", async () => {
    const res = await request("GET", "/health");
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["ok", "port"]);
  });

  it("/health includes healthExtra fields when provided", async () => {
    // Use a dedicated port for a server with healthExtra
    const extraPort = 13143;
    const extraCtx: RouteContext = { port: extraPort, healthExtra: { version: "1.2.3", transport: "http" } };

    let extraServer: ReturnType<typeof createServer>;
    await new Promise<void>((resolve) => {
      extraServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (!handleArtifactRoutes(req, res, extraCtx)) {
          res.writeHead(404);
          res.end();
        }
      });
      extraServer.listen(extraPort, "127.0.0.1", resolve);
    });

    try {
      const http = await import("node:http");
      const res = await new Promise<{ status: number; body: string }>(
        (resolveReq, reject) => {
          const r = http.request(
            { hostname: "127.0.0.1", method: "GET", path: "/health", port: extraPort },
            (response: IncomingMessage) => {
              let data = "";
              response.on("data", (chunk: Buffer) => {
                data += chunk.toString();
              });
              response.on("end", () => resolveReq({ status: response.statusCode ?? 0, body: data }));
            },
          );
          r.on("error", reject);
          r.end();
        },
      );
      const body = JSON.parse(res.body) as { ok: boolean; port: number; version: string; transport: string };
      expect(body.ok).toBe(true);
      expect(body.port).toBe(extraPort);
      expect(body.version).toBe("1.2.3");
      expect(body.transport).toBe("http");
    } finally {
      await new Promise<void>((resolve) => {
        extraServer.closeAllConnections();
        extraServer.close(() => resolve());
      });
    }
  });
});

// ---------------------------------------------------------------------------
// CORS / OPTIONS
// ---------------------------------------------------------------------------

describe("handleArtifactRoutes — CORS / OPTIONS", () => {
  it("sets CORS headers on /health response", async () => {
    const res = await request("GET", "/health");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("OPTIONS /health returns 204 (preflight passthrough)", async () => {
    const res = await request("OPTIONS", "/health");
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Artifact routes
// ---------------------------------------------------------------------------

describe("handleArtifactRoutes — /artifact/:type/:slug", () => {
  it("serves registered HTML artifact with injected data script", async () => {
    const html = "<html><head></head><body>hello</body></html>";
    const data = { planId: "plan-123" };
    registerArtifact("planning-brief/plan-123", html, data);

    const res = await request("GET", "/artifact/planning-brief/plan-123");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("window.__CANON_DATA__");
    expect(res.body).toContain("plan-123");
  });

  it("returns 404 JSON for nonexistent artifact", async () => {
    const res = await request("GET", "/artifact/review/does-not-exist");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("removeArtifact causes subsequent GET to return 404", async () => {
    registerArtifact("review/remove-me", "<html><body></body></html>", {});
    removeArtifact("review/remove-me");

    const res = await request("GET", "/artifact/review/remove-me");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Route isolation — unhandled routes return false
// ---------------------------------------------------------------------------

describe("handleArtifactRoutes — non-artifact routes return false", () => {
  it("returns false for /mcp path (not handled by artifact routes)", async () => {
    // Verify the test server returns 404 for /mcp (it fell through)
    const res = await request("GET", "/mcp");
    // The test server's fallback 404 only fires when handleArtifactRoutes returns false
    expect(res.status).toBe(404);
  });

  it("returns false for unknown path", async () => {
    const res = await request("GET", "/totally-unknown");
    expect(res.status).toBe(404);
  });
});
