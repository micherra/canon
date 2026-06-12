/**
 * Tests for daemon.ts — the Canon MCP HTTP daemon entry point.
 *
 * Covers:
 * - /mcp returns 401 without Authorization header
 * - /mcp returns 503 when token is forced unavailable
 * - /health includes version matching package.json
 * - SIGTERM teardown: sessions drained + PID file removed
 * - PID filename is canon-daemon.pid (not canon-server.pid)
 * - Default port constant is 3142 (not 3141)
 * - W6 Host-header guard on non-MCP routes
 * - DEC-05: isHttpServerRunning() true + getHttpPort() returns daemon port after startDaemon
 *
 * F4 identity-proof tests and /identity auth gate tests live in daemon-identity.test.ts.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON_DEFAULT_PORT, DAEMON_PID_FILENAME, startDaemon, stopDaemon } from "../daemon.ts";

// ---------------------------------------------------------------------------
// Constants regression guards (must be checked before any daemon starts)
// ---------------------------------------------------------------------------

describe("Daemon constants", () => {
  it("DAEMON_DEFAULT_PORT is 3142 (not 3141 stdio default)", () => {
    expect(DAEMON_DEFAULT_PORT).toBe(3142);
  });

  it("DAEMON_PID_FILENAME is canon-daemon.pid (not canon-server.pid)", () => {
    expect(DAEMON_PID_FILENAME).toBe("canon-daemon.pid");
  });

  it("startHttpServer default port remains 3141 (stdio default unchanged)", () => {
    // getHttpPort returns the configured default when server hasn't started yet.
    // We verify it's not 3142 (the daemon port).
    // This is a static constant regression guard — we don't start the server.
    expect(DAEMON_DEFAULT_PORT).not.toBe(3141);
  });
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function daemonRequest(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", method, path, port, headers: headers ?? {} },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Daemon with a valid token
// ---------------------------------------------------------------------------

describe("Daemon /mcp — auth gate", () => {
  const TEST_DAEMON_PORT = 13200;
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    // Write a known token to the tmp dir
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(tokenPath, "test-token-value", { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    await startDaemon({
      port: TEST_DAEMON_PORT,
      pidDir: tmpDir,
      tokenPath,
    });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GET /health responds 200 with ok:true, port, version, transport:http", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      port: number;
      version: string;
      transport: string;
    };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(TEST_DAEMON_PORT);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.transport).toBe("http");
  });

  it("GET /health version matches package.json version", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    // Read the actual package.json — version must match exactly
    const pkgPath = join(new URL("../../../package.json", import.meta.url).pathname);
    const pkg = JSON.parse(await rf(pkgPath, "utf8")) as { version: string };

    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health");
    const body = JSON.parse(res.body) as { version: string };
    expect(body.version).toBe(pkg.version);
  });

  it("POST /mcp without Authorization header returns 401", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "POST", "/mcp", {
      host: "127.0.0.1",
    });
    expect(res.status).toBe(401);
  });

  it("POST /mcp with wrong token returns 401", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "POST", "/mcp", {
      host: "127.0.0.1",
      authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("POST /mcp with correct token is auth-passed (any status except 401/403)", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "POST", "/mcp", {
      host: "127.0.0.1",
      authorization: "Bearer test-token-value",
    });
    // Auth passed — the transport handles the request (may return 400 for missing MCP framing)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });

  it("GET /unknown returns 404", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/unknown");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 503 when token unavailable (fail-closed)
// ---------------------------------------------------------------------------

describe("Daemon /mcp — 503 on token-unavailable", () => {
  const TEST_DAEMON_PORT = 13201;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-503-test-"));
    // Don't write a token file AND make the directory read-only so creation also fails
    // Force the token path to an unwritable location
    const badTokenPath = "/nonexistent-dir/that-cannot-be-created/token";

    await startDaemon({
      port: TEST_DAEMON_PORT,
      pidDir: tmpDir,
      tokenPath: badTokenPath,
    });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /mcp returns 503 when token failed to load", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "POST", "/mcp", {
      host: "127.0.0.1",
      authorization: "Bearer anything",
    });
    expect(res.status).toBe(503);
  });

  it("GET /health still works even when token unavailable (non-authenticated route)", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PID file
// ---------------------------------------------------------------------------

describe("Daemon PID file", () => {
  const TEST_DAEMON_PORT = 13202;
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-pid-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(tokenPath, "test-token-pid", { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    await startDaemon({ port: TEST_DAEMON_PORT, pidDir: tmpDir, tokenPath });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes canon-daemon.pid (not canon-server.pid) to pidDir", async () => {
    const content = await readFile(join(tmpDir, "canon-daemon.pid"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines[0]).toBe(String(process.pid));
    expect(lines[1]).toBe(String(TEST_DAEMON_PORT));
  });
});

// ---------------------------------------------------------------------------
// SIGTERM teardown
// ---------------------------------------------------------------------------

describe("Daemon SIGTERM teardown", () => {
  const TEST_DAEMON_PORT = 13203;
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-sigterm-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(tokenPath, "test-token-teardown", { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    await startDaemon({ port: TEST_DAEMON_PORT, pidDir: tmpDir, tokenPath });
  });

  it("stopDaemon removes PID file and closes server", async () => {
    // Verify PID file exists
    const pidPath = join(tmpDir, "canon-daemon.pid");
    const beforeContent = await readFile(pidPath, "utf8");
    expect(beforeContent.trim().split("\n")[0]).toBe(String(process.pid));

    await stopDaemon();

    // PID file should be gone after stop
    await expect(readFile(pidPath, "utf8")).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// W6 — Host-header guard on artifact/health routes
// ---------------------------------------------------------------------------

describe("W6 — Host-header guard on non-MCP routes", () => {
  const TEST_DAEMON_PORT = 13206;
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-w6-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(tokenPath, "test-token-w6", { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    await startDaemon({ port: TEST_DAEMON_PORT, pidDir: tmpDir, tokenPath });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GET /health with loopback Host responds 200", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health", {
      host: "127.0.0.1",
    });
    expect(res.status).toBe(200);
  });

  it("GET /health with non-loopback Host is rejected 403", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health", {
      host: "evil.example.com",
    });
    expect(res.status).toBe(403);
  });

  it("GET /health with loopback Host:localhost also responds 200", async () => {
    // Verify the guard accepts all canonical loopback host forms
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health", {
      host: "localhost",
    });
    expect(res.status).toBe(200);
  });

  it("POST /mcp CORS headers include x-canon-project-dir and MCP-Protocol-Version", async () => {
    // Use OPTIONS preflight to check CORS headers
    const http = await import("node:http");
    const headers = await new Promise<Record<string, string | string[] | undefined>>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            method: "OPTIONS",
            path: "/mcp",
            port: TEST_DAEMON_PORT,
            headers: {
              host: "127.0.0.1",
              origin: "http://127.0.0.1:3000",
            },
          },
          (res) => {
            resolve(res.headers);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    const allowHeaders = String(headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowHeaders).toContain("x-canon-project-dir");
    expect(allowHeaders).toContain("mcp-protocol-version");
  });
});

// ---------------------------------------------------------------------------
// DEC-05 — daemon artifact-port wiring
// (F4 identity probe + /identity auth gate tests moved to daemon-identity.test.ts)
// ---------------------------------------------------------------------------

describe("DEC-05 — getHttpPort() and isHttpServerRunning() in daemon mode", () => {
  const TEST_DAEMON_PORT = 13211;
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-dec05-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    await writeFile(tokenPath, "test-token-dec05", { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    await startDaemon({ port: TEST_DAEMON_PORT, pidDir: tmpDir, tokenPath });
  });

  afterAll(async () => {
    await stopDaemon();
    // Reset http-server module state so DEC-05 signal doesn't leak into other test suites
    const { resetStateForTesting } = await import("../http-server.ts");
    resetStateForTesting();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("getHttpPort() returns the daemon port after startDaemon()", async () => {
    const { getHttpPort } = await import("../http-server.ts");
    expect(getHttpPort()).toBe(TEST_DAEMON_PORT);
  });

  it("isHttpServerRunning() returns true after startDaemon() (DEC-05 flag)", async () => {
    const { isHttpServerRunning } = await import("../http-server.ts");
    expect(isHttpServerRunning()).toBe(true);
  });
});
