/**
 * daemon-tester-integration.test.ts — Canon Tester integration tests.
 *
 * Fills gaps identified in the adversarial review (REVIEW-ADVERSARIAL.md) and
 * coverage notes from the implementation summaries:
 *
 * 1. N4/W5 daemon-level token rotation e2e: the pure `rereadToken` function is
 *    unit-tested in auth.test.ts but the end-to-end path (401 → fire-and-forget
 *    reread → subsequent request with rotated token accepted) is exercised here
 *    through a real daemon.
 *
 * 2. Same-dir refcount guard e2e (AC3 complement): two SDK sessions for the
 *    SAME project dir — closing one must NOT evict shared resources; the second
 *    session must remain functional. Complements the unit mock-based teardown
 *    order tests in session-manager-hardening.test.ts with a real daemon path.
 *
 * 3. Missing Host header → 403 for artifact/health routes (W6 gap): the existing
 *    W6 tests cover loopback and non-loopback hosts but not the missing-host case;
 *    the guard is fail-closed (missing Host → false) — this test pins that.
 *
 * ## Port hygiene
 * Uses fixed test ports 13207–13208 (above the 13200–13206 range used by daemon.test.ts).
 * startDaemon/stopDaemon handle test isolation — one describe per daemon instance.
 */

import { execSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon, stopDaemon } from "../daemon.ts";
import { sessionCount } from "../mcp-http/session-manager.ts";

// ── Port constants ─────────────────────────────────────────────────────────

/** Port range: above daemon.test.ts's 13200–13206 range. */
const PORT_W5_TOKEN_ROTATION = 13207;
// 13208 reserved (PORT_SAME_DIR_REFCOUNT) — same-dir test uses getFreePort() for safety
// 13209 used by W6 missing-host describe block

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Allocate a free ephemeral port via :0 bind/release.
 * Used as a fallback for the same-dir test to avoid port collisions.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not resolve port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

/** Write a known token to tokenPath at 0600. */
async function writeTestToken(tokenPath: string, token: string): Promise<void> {
  await mkdir(join(tokenPath, ".."), { recursive: true });
  await writeFile(tokenPath, token, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
}

/** Create a minimal git-initialized tmp project dir. */
async function makeProjectDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `canon-tester-${prefix}-`));
  execSync("git init -q", { cwd: dir });
  return dir;
}

/** Raw HTTP request returning status + body. */
async function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", method, path, port, headers }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => resolve({ body: data, status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Poll until condition() returns true or deadline exceeded. */
async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential polling — each iteration must observe the prior await's result before the next probe
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: deadline ${deadlineMs}ms exceeded`);
}

// ── N4/W5: daemon-level token rotation e2e ─────────────────────────────────
//
// The adversarial review (REVIEW-ADVERSARIAL.md N4) noted that the daemon-level
// rotation path (401 → fire-and-forget rereadToken → next request accepted with
// new token) is untested end-to-end. auth.test.ts covers the pure rereadToken
// function; this test exercises the full daemon request path.
//
// Protocol:
// 1. Start daemon with TOKEN_A.
// 2. Confirm TOKEN_A accepted (/mcp returns non-401).
// 3. Rotate token file to TOKEN_B (overwrite in-place).
// 4. Send a request with TOKEN_A → 401 (triggers fire-and-forget reread).
// 5. Wait ≥ 1100ms (reread rate limit is 1/s; async reread needs to settle).
// 6. Send a request with TOKEN_B → should NOT be 401 (daemon refreshed the token).
//
// This test tolerates the one-failed-request-after-rotation design: the request
// that triggers reread always 401s. Only the subsequent request must succeed.

describe("N4/W5 — daemon-level token rotation e2e", () => {
  const TOKEN_A = `token-a-${"a".repeat(56)}`; // 64 chars total
  const TOKEN_B = `token-b-${"b".repeat(56)}`; // 64 chars, different value
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-tester-w5-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    await writeTestToken(tokenPath, TOKEN_A);
    await startDaemon({ port: PORT_W5_TOKEN_ROTATION, pidDir: tmpDir, tokenPath });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rotated token is accepted on the request AFTER the 401-triggered reread (N4/W5 e2e)", async () => {
    // Step 1: Confirm TOKEN_A is accepted (auth passes → any non-4xx/5xx).
    const acceptA = await rawRequest(PORT_W5_TOKEN_ROTATION, "POST", "/mcp", {
      host: `127.0.0.1:${PORT_W5_TOKEN_ROTATION}`,
      authorization: `Bearer ${TOKEN_A}`,
      "content-type": "application/json",
    });
    expect(acceptA.status).not.toBe(401);
    expect(acceptA.status).not.toBe(403);
    expect(acceptA.status).not.toBe(503);

    // Step 2: Rotate the token file to TOKEN_B (in-place overwrite).
    await writeTestToken(tokenPath, TOKEN_B);

    // Step 3: Send TOKEN_B (which the daemon doesn't have yet) → 401.
    //
    // The W5 reread mechanism fires on 401: the daemon's handleMcpRoute calls
    // rereadToken(daemonTokenPath) as fire-and-forget after returning 401.
    // The token file now contains TOKEN_B, so rereadToken reads TOKEN_B and
    // updates tokenResult.current.token.
    //
    // Note: the daemon still has TOKEN_A in memory, so TOKEN_B is rejected here.
    // This is the request that TRIGGERS the reread.
    const rotationTrigger = await rawRequest(PORT_W5_TOKEN_ROTATION, "POST", "/mcp", {
      host: `127.0.0.1:${PORT_W5_TOKEN_ROTATION}`,
      authorization: `Bearer ${TOKEN_B}`,
      "content-type": "application/json",
    });
    expect(rotationTrigger.status).toBe(401);

    // Step 4: Wait for the async reread to settle.
    // Rate limit: reread fires at most once per second; add 100ms buffer.
    await new Promise<void>((r) => setTimeout(r, 1100));

    // Step 5: TOKEN_B should now be accepted (daemon refreshed from file to TOKEN_B).
    const acceptB = await rawRequest(PORT_W5_TOKEN_ROTATION, "POST", "/mcp", {
      host: `127.0.0.1:${PORT_W5_TOKEN_ROTATION}`,
      authorization: `Bearer ${TOKEN_B}`,
      "content-type": "application/json",
    });
    expect(acceptB.status).not.toBe(401);
    expect(acceptB.status).not.toBe(403);
    expect(acceptB.status).not.toBe(503);

    // Step 6: TOKEN_A must now be rejected (old token no longer valid after rotation).
    const rejectA = await rawRequest(PORT_W5_TOKEN_ROTATION, "POST", "/mcp", {
      host: `127.0.0.1:${PORT_W5_TOKEN_ROTATION}`,
      authorization: `Bearer ${TOKEN_A}`,
      "content-type": "application/json",
    });
    expect(rejectA.status).toBe(401);
  }, 15000); // 1100ms wait + generous CI headroom
});

// ── W6 missing/non-loopback Host: fail-closed guard for artifact/health routes ──
//
// The existing W6 tests in daemon.test.ts cover loopback (127.0.0.1, localhost)
// and non-loopback (evil.example.com) Host headers. This test covers two gaps:
//
// 1. Missing Host header: HTTP/1.1 requires Host per RFC 7230. Node's HTTP server
//    returns 400 before app code runs, so the platform itself enforces rejection.
//    The isLoopbackHost guard adds defense-in-depth for HTTP/1.0 requests where
//    Node does reach app code with req.headers.host undefined → returns false →
//    403. Both paths result in a non-200 response, pinning the fail-closed behavior.
//
// 2. Cross-site style non-loopback Host (not in daemon.test.ts coverage):
//    a numeric non-loopback IP as Host should be rejected with 403.

describe("W6 — fail-closed guard for artifact/health routes (gap coverage)", () => {
  const PORT_W6_MISSING_HOST = 13209;
  const STATIC_TOKEN = `w6-static-token-${"x".repeat(47)}`; // 64 chars
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-tester-w6-missing-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    await writeTestToken(tokenPath, STATIC_TOKEN);
    await startDaemon({ port: PORT_W6_MISSING_HOST, pidDir: tmpDir, tokenPath });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GET /health without Host header is rejected (400 from HTTP layer or 403 from app guard — not 200)", async () => {
    // Send a raw HTTP/1.1 request with NO Host header.
    // Node's HTTP server returns 400 for HTTP/1.1 requests without Host (RFC 7230).
    // For HTTP/1.0, the app guard fires first (isLoopbackHost returns false → 403).
    // Both behaviors result in a non-200 response, pinning fail-closed semantics.
    const net = await import("node:net");
    const result = await new Promise<number>((resolve) => {
      const socket = net.createConnection({ port: PORT_W6_MISSING_HOST, host: "127.0.0.1" });
      let statusCode = 0;
      socket.on("connect", () => {
        // HTTP/1.1 without Host — Node returns 400
        socket.write("GET /health HTTP/1.1\r\nConnection: close\r\n\r\n");
      });
      socket.on("data", (chunk: Buffer) => {
        const firstLine = chunk.toString().split("\r\n")[0];
        const match = /HTTP\/1\.[01] (\d+)/.exec(firstLine);
        if (match) statusCode = Number(match[1]);
      });
      socket.on("close", () => resolve(statusCode));
      socket.on("error", () => resolve(0));
      socket.setTimeout(3000, () => {
        socket.destroy();
        resolve(0);
      });
    });
    // Either 400 (platform enforced) or 403 (app guard) — never 200
    expect(result).not.toBe(200);
    expect([400, 403]).toContain(result);
  });

  it("GET /health with non-loopback numeric IP Host → 403 (W6 app guard fires)", async () => {
    // 192.168.1.1 is not in DAEMON_ALLOWED_HOSTS — the guard must reject it.
    // This is distinct from evil.example.com (already tested) — confirms numeric IPs
    // are also rejected (the guard checks a fixed set, not just "looks like a domain").
    const res = await rawRequest(PORT_W6_MISSING_HOST, "GET", "/health", {
      host: "192.168.1.1",
    });
    expect(res.status).toBe(403);
  });

  it("GET /health with loopback 127.0.0.1 Host still passes (guard is not over-aggressive)", async () => {
    const res = await rawRequest(PORT_W6_MISSING_HOST, "GET", "/health", {
      host: "127.0.0.1",
    });
    expect(res.status).toBe(200);
  });
});

// ── Same-dir refcount guard e2e (AC3 complement) ──────────────────────────
//
// Unit tests in session-manager-hardening.test.ts (W3 block) verify the refcount
// guard with mocked eviction functions. This test exercises the guard at the
// integration level through a real daemon: two SDK sessions sharing the same
// projectDir — closing one must NOT break the other.
//
// This complements the AC3 e2e test in http-mcp-e2e.integration.test.ts which
// uses DISTINCT dirs. That test ensures teardown fires. This test ensures teardown
// does NOT fire prematurely when a sibling session shares the scope.

describe("AC3 complement — same-dir refcount guard e2e (no premature eviction)", () => {
  let port: number;
  let tmpDir: string;
  let projectDir: string;
  const TEST_TOKEN = `refcount-e2e-test-token-${"r".repeat(40)}`; // 64 chars

  let clientA: Client;
  let transportA: StreamableHTTPClientTransport;
  let clientB: Client;
  let transportB: StreamableHTTPClientTransport;

  beforeAll(async () => {
    port = await getFreePort();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-tester-refcount-"));
    const tokenPath = join(tmpDir, "canon-mcp-token");
    await writeTestToken(tokenPath, TEST_TOKEN);
    projectDir = await makeProjectDir("refcount");
    await startDaemon({ port, pidDir: tmpDir, tokenPath });

    // Both clients use the SAME projectDir (same scope)
    const makeClient = (name: string) => {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "x-canon-project-dir": projectDir,
          },
        },
      });
      const client = new Client({ name, version: "1.0.0" });
      return { client, transport };
    };

    ({ client: clientA, transport: transportA } = makeClient("canon-refcount-a"));
    ({ client: clientB, transport: transportB } = makeClient("canon-refcount-b"));

    await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);
    // Wait for both sessions to appear in the registry
    await pollUntil(() => sessionCount() >= 2, 8000);
  });

  afterAll(async () => {
    await Promise.allSettled([clientB.close()]);
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("closing session A (same dir as B) does not break session B — refcount guard holds (AC3 complement)", async () => {
    // Confirm both sessions are active
    expect(sessionCount()).toBeGreaterThanOrEqual(2);
    const before = sessionCount();

    // Close session A — sends HTTP DELETE → onsessionclosed → teardownSession
    // With refcount guard: B still maps to projectDir → evictions skip
    await transportA.terminateSession();
    await clientA.close();

    // Wait for A's teardown to be reflected
    await pollUntil(() => sessionCount() < before, 8000);

    // Session A gone, B still alive
    expect(sessionCount()).toBe(before - 1);
    expect(sessionCount()).toBeGreaterThanOrEqual(1);

    // Session B must still work — its SQLite handles and scope must be intact
    // (if the refcount guard failed, eviction would have closed B's stores)
    const result = await clientB.callTool({ name: "list_principles", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
  }, 15000);
});
