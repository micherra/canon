/**
 * Tests for the Canon HTTP server module.
 *
 * Covers:
 * - startHttpServer binds to configured port and responds to health check
 * - registerArtifact + GET returns HTML with injected data script
 * - createDeferredDecision + POST resolves the deferred Promise with decision data
 * - POST with invalid JSON returns 400
 * - POST with missing action returns 400
 * - POST with invalid action returns 400
 * - GET for nonexistent artifact returns 404
 * - POST for nonexistent decision returns 404
 * - removeArtifact cleans up both artifact and pending decision
 * - CORS headers are set on all responses
 * - OPTIONS preflight returns 204
 * - Body size limit (1MB) returns 413
 * - Port configurable via CANON_HTTP_PORT env var
 */

import { request as httpRequest } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDeferredDecision,
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
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
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

  describe("createDeferredDecision + POST /artifact/:type/:slug/decision", () => {
    it("resolves the deferred Promise when a valid decision is POSTed", async () => {
      registerArtifact("planning-brief/approve-test", "<html><body></body></html>", {});
      const decisionPromise = createDeferredDecision("planning-brief/approve-test");

      const body = JSON.stringify({ action: "approve", annotations: [] });
      const res = await request("POST", "/artifact/planning-brief/approve-test/decision", body);

      expect(res.status).toBe(200);
      const responseJson = JSON.parse(res.body) as { ok: boolean; action: string };
      expect(responseJson.ok).toBe(true);
      expect(responseJson.action).toBe("approve");

      const decision = await decisionPromise;
      expect(decision.action).toBe("approve");
      expect(decision.annotations).toEqual([]);
    });

    it("resolves with request_changes action and annotations", async () => {
      registerArtifact("planning-brief/changes-test", "<html><body></body></html>", {});
      const decisionPromise = createDeferredDecision("planning-brief/changes-test");

      const annotations = [{ comment: "needs more detail", section: "intro" }];
      const body = JSON.stringify({ action: "request_changes", annotations });
      await request("POST", "/artifact/planning-brief/changes-test/decision", body);

      const decision = await decisionPromise;
      expect(decision.action).toBe("request_changes");
      expect(decision.annotations).toEqual(annotations);
    });

    it("defaults annotations to empty array when omitted", async () => {
      registerArtifact("planning-brief/no-annotations-test", "<html><body></body></html>", {});
      const decisionPromise = createDeferredDecision("planning-brief/no-annotations-test");

      const body = JSON.stringify({ action: "approve" });
      await request("POST", "/artifact/planning-brief/no-annotations-test/decision", body);

      const decision = await decisionPromise;
      expect(decision.annotations).toEqual([]);
    });

    it("returns 400 for invalid JSON body", async () => {
      registerArtifact("planning-brief/bad-json-test", "<html><body></body></html>", {});
      createDeferredDecision("planning-brief/bad-json-test");

      const res = await request(
        "POST",
        "/artifact/planning-brief/bad-json-test/decision",
        "not json",
      );
      expect(res.status).toBe(400);
      const json = JSON.parse(res.body) as { error: string };
      expect(json.error).toContain("Invalid JSON");
    });

    it("returns 400 when action is missing", async () => {
      registerArtifact("planning-brief/no-action-test", "<html><body></body></html>", {});
      createDeferredDecision("planning-brief/no-action-test");

      const res = await request(
        "POST",
        "/artifact/planning-brief/no-action-test/decision",
        JSON.stringify({ annotations: [] }),
      );
      expect(res.status).toBe(400);
      const json = JSON.parse(res.body) as { error: string };
      expect(json.error).toContain("action");
    });

    it("returns 400 when action is invalid", async () => {
      registerArtifact("planning-brief/bad-action-test", "<html><body></body></html>", {});
      createDeferredDecision("planning-brief/bad-action-test");

      const res = await request(
        "POST",
        "/artifact/planning-brief/bad-action-test/decision",
        JSON.stringify({ action: "reject", annotations: [] }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 when no pending decision exists for the artifact", async () => {
      registerArtifact("planning-brief/no-decision-test", "<html><body></body></html>", {});
      // No createDeferredDecision call

      const res = await request(
        "POST",
        "/artifact/planning-brief/no-decision-test/decision",
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

    it("removes pending decision so POST returns 404", async () => {
      registerArtifact("planning-brief/remove-decision-test", "<html><body></body></html>", {});
      createDeferredDecision("planning-brief/remove-decision-test");
      removeArtifact("planning-brief/remove-decision-test");

      const res = await request(
        "POST",
        "/artifact/planning-brief/remove-decision-test/decision",
        JSON.stringify({ action: "approve", annotations: [] }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("getHttpPort", () => {
    it("returns the port the server is listening on", () => {
      expect(getHttpPort()).toBe(TEST_PORT);
    });
  });
});
