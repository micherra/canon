/**
 * F4 identity-proof tests for daemon.ts.
 *
 * Covers:
 * - EADDRINUSE F4 probe: version+proof → "same-version"; version-only → "identity-mismatch"
 * - Token-unavailable → "identity-mismatch" (fail-closed)
 * - Wrong proof → "identity-mismatch"
 * - Unreachable → "unreachable"
 * - /identity auth gate: 401/403 without valid auth, proof on success, proof ≠ raw token
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon, stopDaemon } from "../daemon.ts";
import { computeIdentityProof, generateNonce } from "../mcp-http/identity-proof.ts";

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
      { headers: headers ?? {}, hostname: "127.0.0.1", method, path, port },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve({ body: data, status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// EADDRINUSE / F4 probe tests (injection-based via probeExistingDaemon)
// ---------------------------------------------------------------------------

describe("Daemon EADDRINUSE — F4 identity probe", () => {
  it("F4 happy path: version match + valid identity proof → 'same-version'", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const pkgPath = join(new URL("../../../package.json", import.meta.url).pathname);
    const pkg = JSON.parse(await rf(pkgPath, "utf8")) as { version: string };

    const testToken = "f4-test-token-happy-path-value";
    const fakePort = 14204;
    // Stub server serves matching /health AND computes a valid /identity proof
    const fakeServer = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${fakePort}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, port: fakePort, version: pkg.version, transport: "http" }),
        );
      } else if (url.pathname === "/identity" && req.method === "GET") {
        const nonce = url.searchParams.get("nonce") ?? "";
        const proof = computeIdentityProof(testToken, nonce);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ proof }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => fakeServer.listen(fakePort, "127.0.0.1", resolve));

    try {
      const { probeExistingDaemon } = await import("../daemon.ts");
      const result = await probeExistingDaemon(fakePort, pkg.version, testToken, 2000);
      expect(result).toBe("same-version");
    } finally {
      await new Promise<void>((resolve) => {
        fakeServer.closeAllConnections();
        fakeServer.close(() => resolve());
      });
    }
  });

  it("F4 impostor: version match but /identity not served → 'identity-mismatch' (NOT same-version)", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const pkgPath = join(new URL("../../../package.json", import.meta.url).pathname);
    const pkg = JSON.parse(await rf(pkgPath, "utf8")) as { version: string };

    const fakePort = 14207;
    // Impostor: serves matching /health version but 404 on /identity
    const fakeServer = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${fakePort}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, port: fakePort, version: pkg.version, transport: "http" }),
        );
      } else {
        // No /identity route — impostor cannot prove identity
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => fakeServer.listen(fakePort, "127.0.0.1", resolve));

    try {
      const { probeExistingDaemon } = await import("../daemon.ts");
      // The probe sends our token as Bearer but the impostor can't produce a valid HMAC
      const result = await probeExistingDaemon(fakePort, pkg.version, "some-token", 2000);
      // Must NOT be same-version — version match without proof must fail-closed
      expect(result).toBe("identity-mismatch");
      expect(result).not.toBe("same-version");
    } finally {
      await new Promise<void>((resolve) => {
        fakeServer.closeAllConnections();
        fakeServer.close(() => resolve());
      });
    }
  });

  it("F4 impostor: wrong proof on /identity → 'identity-mismatch'", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const pkgPath = join(new URL("../../../package.json", import.meta.url).pathname);
    const pkg = JSON.parse(await rf(pkgPath, "utf8")) as { version: string };

    const fakePort = 14208;
    // Impostor: serves matching /health AND a plausible-looking /identity, but
    // with the WRONG proof (uses a different token than the prober expects)
    const fakeServer = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${fakePort}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, port: fakePort, version: pkg.version, transport: "http" }),
        );
      } else if (url.pathname === "/identity" && req.method === "GET") {
        const nonce = url.searchParams.get("nonce") ?? "";
        // Use a DIFFERENT token — proof won't match prober's expected HMAC
        const wrongProof = computeIdentityProof("impostor-token", nonce);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ proof: wrongProof }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => fakeServer.listen(fakePort, "127.0.0.1", resolve));

    try {
      const { probeExistingDaemon } = await import("../daemon.ts");
      const result = await probeExistingDaemon(fakePort, pkg.version, "correct-token", 2000);
      expect(result).toBe("identity-mismatch");
    } finally {
      await new Promise<void>((resolve) => {
        fakeServer.closeAllConnections();
        fakeServer.close(() => resolve());
      });
    }
  });

  it("F4 token-unavailable: undefined myToken on version-matching stub → 'identity-mismatch' (fail-closed)", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const pkgPath = join(new URL("../../../package.json", import.meta.url).pathname);
    const pkg = JSON.parse(await rf(pkgPath, "utf8")) as { version: string };

    const fakePort = 14209;
    const fakeServer = createServer((req: IncomingMessage, res) => {
      if (new URL(req.url ?? "/", `http://127.0.0.1:${fakePort}`).pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, port: fakePort, version: pkg.version, transport: "http" }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => fakeServer.listen(fakePort, "127.0.0.1", resolve));

    try {
      const { probeExistingDaemon } = await import("../daemon.ts");
      // Token undefined → cannot prove → fail-closed
      const result = await probeExistingDaemon(fakePort, pkg.version, undefined, 2000);
      expect(result).toBe("identity-mismatch");
    } finally {
      await new Promise<void>((resolve) => {
        fakeServer.closeAllConnections();
        fakeServer.close(() => resolve());
      });
    }
  });

  it("probeExistingDaemon returns different-version when version differs", async () => {
    const fakePort = 14205;
    const fakeServer = createServer((req: IncomingMessage, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, port: fakePort, version: "0.0.0", transport: "http" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => fakeServer.listen(fakePort, "127.0.0.1", resolve));

    try {
      const { probeExistingDaemon } = await import("../daemon.ts");
      const result = await probeExistingDaemon(fakePort, "1.2.3", "some-token", 2000);
      expect(result).toBe("different-version");
    } finally {
      await new Promise<void>((resolve) => {
        fakeServer.closeAllConnections();
        fakeServer.close(() => resolve());
      });
    }
  });

  it("probeExistingDaemon returns unreachable when connection refused", async () => {
    const { probeExistingDaemon } = await import("../daemon.ts");
    // Port 13299 should not be in use
    const result = await probeExistingDaemon(13299, "2.6.0", "token", 500);
    expect(result).toBe("unreachable");
  });
});

// ---------------------------------------------------------------------------
// F4 /identity route — auth guard tests
// ---------------------------------------------------------------------------

describe("Daemon /identity — auth gate (F4)", () => {
  const TEST_DAEMON_PORT = 13210;
  const TEST_TOKEN = "test-token-identity-auth-guard";
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-daemon-identity-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
    await writeFile(tokenPath, TEST_TOKEN, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    await startDaemon({ port: TEST_DAEMON_PORT, pidDir: tmpDir, tokenPath });
  });

  afterAll(async () => {
    await stopDaemon();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GET /identity without Authorization header returns 401 (not a proof)", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/identity?nonce=abc123", {
      host: "127.0.0.1",
    });
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body) as { proof?: string };
    expect(body.proof).toBeUndefined();
  });

  it("GET /identity with wrong token returns 401 (not a proof)", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/identity?nonce=abc123", {
      authorization: "Bearer wrong-token",
      host: "127.0.0.1",
    });
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body) as { proof?: string };
    expect(body.proof).toBeUndefined();
  });

  it("GET /identity with correct token returns proof (200)", async () => {
    const nonce = generateNonce();
    const res = await daemonRequest(
      TEST_DAEMON_PORT,
      "GET",
      `/identity?nonce=${encodeURIComponent(nonce)}`,
      {
        authorization: `Bearer ${TEST_TOKEN}`,
        host: "127.0.0.1",
      },
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { proof?: string };
    expect(typeof body.proof).toBe("string");
    // The proof must be the HMAC-SHA256 of the nonce with our token
    const expected = computeIdentityProof(TEST_TOKEN, nonce);
    expect(body.proof).toBe(expected);
  });

  it("GET /identity proof is not the raw token (secrets-never-in-code)", async () => {
    const nonce = generateNonce();
    const res = await daemonRequest(
      TEST_DAEMON_PORT,
      "GET",
      `/identity?nonce=${encodeURIComponent(nonce)}`,
      {
        authorization: `Bearer ${TEST_TOKEN}`,
        host: "127.0.0.1",
      },
    );
    const body = JSON.parse(res.body) as { proof?: string };
    // Proof must never equal the raw token
    expect(body.proof).not.toBe(TEST_TOKEN);
  });

  it("GET /health still returns version (supervisor not broken by F4)", async () => {
    const res = await daemonRequest(TEST_DAEMON_PORT, "GET", "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { version?: string };
    expect(typeof body.version).toBe("string");
    expect(body.version!.length).toBeGreaterThan(0);
    // /health must still have the version field (supervisor greps it)
    expect(body).toHaveProperty("version");
  });
});
