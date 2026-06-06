/**
 * Tests for mcp-http/auth.ts — loopback auth module.
 *
 * TDD order: reject-by-default cases first (red), then accept cases.
 * All fs tests use real tmp dirs on disk (no mocks) to catch real permission behavior.
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, loadOrCreateToken, resolveTokenPath } from "../auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
  opts: { remoteAddress?: string; host?: string; authorization?: string } = {},
): IncomingMessage {
  const socket = {
    remoteAddress: opts.remoteAddress ?? "127.0.0.1",
  } as Partial<Socket> as Socket;

  const headers: Record<string, string | undefined> = {};
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;

  return {
    socket,
    headers,
  } as Partial<IncomingMessage> as IncomingMessage;
}

// ---------------------------------------------------------------------------
// resolveTokenPath
// ---------------------------------------------------------------------------

describe("resolveTokenPath", () => {
  it("returns CANON_MCP_TOKEN_FILE when set", () => {
    const env = { CANON_MCP_TOKEN_FILE: "/custom/path/token" };
    expect(resolveTokenPath(env)).toBe("/custom/path/token");
  });

  it("returns CLAUDE_PLUGIN_DATA join when CLAUDE_PLUGIN_DATA is set", () => {
    const env = { CLAUDE_PLUGIN_DATA: "/data/dir" };
    const result = resolveTokenPath(env);
    expect(result).toBe("/data/dir/canon-mcp-token");
  });

  it("returns homedir fallback when neither env var is set", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = resolveTokenPath(env);
    // Should end with the standard dev fallback path
    expect(result).toMatch(/\.claude[/\\]canon[/\\]canon-mcp-token$/);
  });

  it("prefers CANON_MCP_TOKEN_FILE over CLAUDE_PLUGIN_DATA", () => {
    const env = {
      CANON_MCP_TOKEN_FILE: "/explicit/token",
      CLAUDE_PLUGIN_DATA: "/data/dir",
    };
    expect(resolveTokenPath(env)).toBe("/explicit/token");
  });
});

// ---------------------------------------------------------------------------
// loadOrCreateToken
// ---------------------------------------------------------------------------

describe("loadOrCreateToken", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a 64-char hex token when file is absent", async () => {
    const tokenPath = join(tmpDir, "token");
    const result = await loadOrCreateToken(tokenPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("creates token file with 0600 permissions (umask-safe via explicit chmod)", async () => {
    const tokenPath = join(tmpDir, "token");
    await loadOrCreateToken(tokenPath);
    const s = await stat(tokenPath);
    // eslint-disable-next-line no-bitwise
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("reuses existing token on second call", async () => {
    const tokenPath = join(tmpDir, "token");
    const first = await loadOrCreateToken(tokenPath);
    const second = await loadOrCreateToken(tokenPath);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.token).toBe(first.token);
    }
  });

  it("regenerates token when file exists but is empty", async () => {
    const tokenPath = join(tmpDir, "empty-token");
    await writeFile(tokenPath, "", { mode: 0o600 });
    const result = await loadOrCreateToken(tokenPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("regenerates token when file exists but is whitespace-only", async () => {
    const tokenPath = join(tmpDir, "whitespace-token");
    await writeFile(tokenPath, "   \n  ", { mode: 0o600 });
    const result = await loadOrCreateToken(tokenPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("returns ok:false when parent dir is a file (uncreatable path)", async () => {
    // Create a file where the parent dir should be
    const blocker = join(tmpDir, "blocker");
    await writeFile(blocker, "I am a file");
    const tokenPath = join(blocker, "token"); // blocker is a file, not a dir
    const result = await loadOrCreateToken(tokenPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("reads an existing valid token and returns ok:true", async () => {
    const tokenPath = join(tmpDir, "valid-token");
    const existing = "a".repeat(64);
    await writeFile(tokenPath, existing, { mode: 0o600 });
    const result = await loadOrCreateToken(tokenPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe(existing);
    }
  });
});

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

describe("authenticate — reject by default", () => {
  const expectedToken = "x".repeat(64);

  it("rejects missing Authorization header with 401", () => {
    const req = makeReq({ host: "localhost" });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects malformed Authorization header (no 'Bearer ') with 401", () => {
    const req = makeReq({ host: "localhost", authorization: "Basic abc123" });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects wrong token of same length with 401 (timing-safe)", () => {
    const wrongToken = "y".repeat(64);
    const req = makeReq({ host: "localhost", authorization: `Bearer ${wrongToken}` });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects wrong-length token with 401 (must not crash timingSafeEqual)", () => {
    const shortToken = "x".repeat(32); // length mismatch
    const req = makeReq({ host: "localhost", authorization: `Bearer ${shortToken}` });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects non-loopback remoteAddress with 403", () => {
    const req = makeReq({
      remoteAddress: "192.168.1.100",
      host: "localhost",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it("rejects external hostname in Host header with 403 (DNS rebinding)", () => {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      host: "evil.example.com",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it("rejects missing Host header with 403", () => {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      // no host
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });
});

describe("authenticate — accept cases", () => {
  const expectedToken = "a".repeat(64);

  it("accepts valid token with 127.0.0.1 and localhost host", () => {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      host: "localhost",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });

  it("accepts valid token with ::1 IPv6 loopback", () => {
    const req = makeReq({
      remoteAddress: "::1",
      host: "localhost",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });

  it("accepts valid token with ::ffff:127.0.0.1 mapped loopback", () => {
    const req = makeReq({
      remoteAddress: "::ffff:127.0.0.1",
      host: "localhost",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });

  it("accepts valid token with 127.0.0.1 as Host header", () => {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });

  it("accepts valid token with [::1] as Host header", () => {
    const req = makeReq({
      remoteAddress: "::1",
      host: "[::1]",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });

  it("accepts valid token with localhost:3142 (port suffix stripped)", () => {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      host: "localhost:3142",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });

  it("accepts valid token with 127.0.0.1:3142 (port suffix stripped)", () => {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1:3142",
      authorization: `Bearer ${expectedToken}`,
    });
    const result = authenticate(req, expectedToken);
    expect(result.ok).toBe(true);
  });
});
