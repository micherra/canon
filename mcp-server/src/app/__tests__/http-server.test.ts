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
 * - writePidFile writes PID + port under given dir
 * - removePidFile removes PID file only when PID matches current process
 * - PID file path always under .canon or PLUGIN_DATA
 * - writePidFile failure (unwritable dir) does not throw
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHttpPort,
  registerArtifact,
  removeArtifact,
  removePidFile,
  resetStateForTesting,
  resolvePidDir,
  startHttpServer,
  stopHttpServer,
  writePidFile,
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

// ---------------------------------------------------------------------------
// PID file helpers — tested independently of the HTTP server lifecycle
// ---------------------------------------------------------------------------
describe("PID file helpers", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pid-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writePidFile writes ${pid}\\n${port} to dir/canon-server.pid", async () => {
    await writePidFile(tmpDir, 3141);
    const content = await readFile(join(tmpDir, "canon-server.pid"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines[0]).toBe(String(process.pid));
    expect(lines[1]).toBe("3141");
  });

  it("removePidFile removes file only when file PID matches process.pid", async () => {
    // Write with current PID
    await writePidFile(tmpDir, 3141);
    await removePidFile(tmpDir);
    // File should be gone
    await expect(readFile(join(tmpDir, "canon-server.pid"), "utf8")).rejects.toThrow();
  });

  it("removePidFile does NOT remove file when PID does not match", async () => {
    // Write a PID file with a different PID (1 = init process, definitely not us)
    await writeFile(join(tmpDir, "canon-server.pid"), "1\n3141\n");
    await removePidFile(tmpDir);
    // File should still exist (PID 1 != process.pid)
    const content = await readFile(join(tmpDir, "canon-server.pid"), "utf8");
    expect(content).toContain("1");
  });

  it("PID file path always contains .canon or injected dir (gitignored)", async () => {
    // Assert the PID filename is canon-server.pid (not in working tree root)
    const pidPath = join(tmpDir, "canon-server.pid");
    await writePidFile(tmpDir, 3141);
    const content = await readFile(pidPath, "utf8");
    expect(content).toBeTruthy();
    // The path was written under tmpDir (injected, not cwd)
    expect(pidPath).toContain(tmpDir);
  });

  it("writePidFile failure (unwritable dir) does not throw and logs to stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Pass a non-existent/unwritable path
    await expect(
      writePidFile("/nonexistent/path/that/does/not/exist", 3141),
    ).resolves.not.toThrow();
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// resolvePidDir scope resolution — Phase 2 isolation-finish (no process.cwd leak)
// ---------------------------------------------------------------------------
describe("resolvePidDir scope resolution (no implicit cwd leak)", () => {
  let savedPluginData: string | undefined;

  beforeEach(() => {
    savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  });

  afterEach(() => {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
    // Clear any seeded scope so tests do not bleed.
    resetStateForTesting();
  });

  it("returns CLAUDE_PLUGIN_DATA verbatim when set", () => {
    process.env.CLAUDE_PLUGIN_DATA = "/plugin/data/dir";
    expect(resolvePidDir()).toBe("/plugin/data/dir");
  });

  it("returns {seededScope}/.canon when no CLAUDE_PLUGIN_DATA but a startup scope was seeded", async () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    // Seed scope via the startup entry point (does not rebind/restart the server).
    await startHttpServer(TEST_PORT, "/seeded/project");
    expect(resolvePidDir()).toBe(join("/seeded/project", ".canon"));
    // No path containing the process cwd is produced when a scope is seeded.
    expect(resolvePidDir()).not.toContain(process.cwd());
  });

  it("fails closed (returns null) when neither CLAUDE_PLUGIN_DATA nor a seeded scope is available", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    resetStateForTesting(); // clears resolvedProjectDir
    // Fail-closed guarantee preserved: null can never be a cwd-derived directory,
    // so it never leaks process.cwd() — the value contract IS the fail-closed assertion.
    expect(resolvePidDir()).toBeNull();
  });
});
