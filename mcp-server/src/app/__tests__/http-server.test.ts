/**
 * Tests for the Canon HTTP server module.
 *
 * Covers:
 * - startHttpServer binds to configured port and responds to health check
 * - registerArtifact + GET returns HTML with injected data script
 * - GET for nonexistent artifact returns 404
 * - removeArtifact removes the artifact
 * - CORS headers are set on all responses
 * - OPTIONS preflight returns 204
 * - Port configurable via CANON_HTTP_PORT env var
 */

import { request as httpRequest } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getHttpPort,
  registerArtifact,
  removeArtifact,
  resetStateForTesting,
  startHttpServer,
  stopHttpServer,
} from "../http-server.ts";

// Helper: perform HTTP request against the test server
async function request(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  const port = getHttpPort();
  return new Promise((resolve, reject) => {
    const options = {
      headers: body ? { "Content-Type": "application/json" } : {},
      hostname: "127.0.0.1",
      method,
      path,
      port,
    };

    const req = httpRequest(options, (res) => {
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
    });

    req.on("error", reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// Use a dedicated test port to avoid conflicts with real server
const TEST_PORT = 13141;

describe("HTTP server module", () => {
  // Start the server once for the entire suite — repeated start/stop on the
  // same port within a single vitest run can race on socket release.
  beforeAll(async () => {
    await startHttpServer(TEST_PORT);
  });

  afterAll(async () => {
    await stopHttpServer();
  });

  // Clear registered artifacts and pending decisions between each test
  // so tests are isolated from each other's side effects.
  afterEach(() => {
    resetStateForTesting();
  });

  describe("startHttpServer", () => {
    it("responds to GET /health with 200 and ok: true", async () => {
      const res = await request("GET", "/health");
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body) as { ok: boolean; port: number };
      expect(json.ok).toBe(true);
      expect(json.port).toBe(TEST_PORT);
    });

    it("returns 404 for unknown paths", async () => {
      const res = await request("GET", "/unknown-path");
      expect(res.status).toBe(404);
    });

    it("sets CORS headers on all responses", async () => {
      const res = await request("GET", "/health");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
      expect(res.headers["access-control-allow-methods"]).toContain("OPTIONS");
    });

    it("responds to OPTIONS preflight with 204", async () => {
      const res = await request("OPTIONS", "/health");
      expect(res.status).toBe(204);
    });
  });

  describe("registerArtifact + GET /artifact/:type/:slug", () => {
    it("returns HTML with injected window.__CANON_DATA__ script", async () => {
      const html = "<html><head></head><body>hello</body></html>";
      const data = { planId: "plan-123", sections: ["intro"] };
      registerArtifact("planning-brief/plan-123", html, data);

      const res = await request("GET", "/artifact/planning-brief/plan-123");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("window.__CANON_DATA__");
      expect(res.body).toContain(JSON.stringify(data));
      expect(res.body).toContain("hello");
    });

    it("injects data before </head>", async () => {
      const html = "<html><head><title>Test</title></head><body></body></html>";
      registerArtifact("planning-brief/test-head", html, { x: 1 });

      const res = await request("GET", "/artifact/planning-brief/test-head");
      expect(res.status).toBe(200);
      // Script should appear before </head>
      const headClose = res.body.indexOf("</head>");
      const scriptStart = res.body.indexOf("window.__CANON_DATA__");
      expect(scriptStart).toBeGreaterThan(0);
      expect(scriptStart).toBeLessThan(headClose);
    });

    it("falls back to injecting before </body> when no </head>", async () => {
      const html = "<html><body>content</body></html>";
      registerArtifact("planning-brief/test-body", html, { y: 2 });

      const res = await request("GET", "/artifact/planning-brief/test-body");
      expect(res.status).toBe(200);
      const bodyClose = res.body.indexOf("</body>");
      const scriptStart = res.body.indexOf("window.__CANON_DATA__");
      expect(scriptStart).toBeGreaterThan(0);
      expect(scriptStart).toBeLessThan(bodyClose);
    });

    it("returns 404 for nonexistent artifact", async () => {
      const res = await request("GET", "/artifact/planning-brief/does-not-exist");
      expect(res.status).toBe(404);
      const json = JSON.parse(res.body) as { error: string };
      expect(json.error).toContain("not found");
    });
  });

  describe("POST /artifact/:type/:slug/decision (removed route)", () => {
    it("returns 404 — decision POST route no longer exists", async () => {
      registerArtifact("planning-brief/post-test", "<html><body></body></html>", {});

      const res = await request(
        "POST",
        "/artifact/planning-brief/post-test/decision",
        JSON.stringify({ action: "approve", annotations: [] }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("removeArtifact", () => {
    it("removes artifact so GET returns 404", async () => {
      registerArtifact("planning-brief/remove-test", "<html><body></body></html>", {});
      removeArtifact("planning-brief/remove-test");

      const res = await request("GET", "/artifact/planning-brief/remove-test");
      expect(res.status).toBe(404);
    });
  });

  describe("getHttpPort", () => {
    it("returns the port the server is listening on", () => {
      expect(getHttpPort()).toBe(TEST_PORT);
    });
  });
});
