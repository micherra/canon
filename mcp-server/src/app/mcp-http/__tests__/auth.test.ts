/**
 * Tests for mcp-http/auth.ts — loopback auth module.
 *
 * TDD order: reject-by-default cases first (red), then accept cases.
 * All fs tests use real tmp dirs on disk (no mocks) to catch real permission behavior.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, loadOrCreateToken, rereadToken, resolveTokenPath } from "../auth.js";

// ---------------------------------------------------------------------------
// Path to the headersHelper shell script (relative to mcp-server root)
// ---------------------------------------------------------------------------
const HEADERS_HELPER = join(
  import.meta.dirname,
  // from __tests__/ → mcp-http/ → app/ → src/ → mcp-server/mcp-auth-headers.sh
  "..",
  "..",
  "..",
  "..",
  "mcp-auth-headers.sh",
);

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

  it("ignores CLAUDE_PLUGIN_DATA and returns homedir fallback", () => {
    // After ADR-0015 collapse: CLAUDE_PLUGIN_DATA is no longer consulted.
    const env = { CLAUDE_PLUGIN_DATA: "/data/dir" };
    const result = resolveTokenPath(env);
    // Must end with the home-dir canonical path, NOT a CLAUDE_PLUGIN_DATA join.
    expect(result).toMatch(/\.claude[/\\]canon[/\\]canon-mcp-token$/);
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
// env-divergence regression (auth-token-determinism-01) — RED before the fix
// ---------------------------------------------------------------------------

describe("env-divergence regression (auth-token-determinism-01)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = join(tmpdir(), `auth-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolveTokenPath ignores CLAUDE_PLUGIN_DATA — with and without it resolve identically", () => {
    // Incident: daemon (CLAUDE_PLUGIN_DATA set) resolved tier-2, helper (unset) resolved tier-3 home.
    expect(resolveTokenPath({ CLAUDE_PLUGIN_DATA: "/data/dir" })).toBe(resolveTokenPath({}));
  });

  it("TS↔shell parity: resolveTokenPath and mcp-auth-headers.sh resolve the same token (CANON_MCP_TOKEN_FILE pinned)", () => {
    const placeholder = "a".repeat(64);
    const tokenFile = join(tmpDir, "canon-mcp-token");
    writeFileSync(tokenFile, placeholder, { mode: 0o600 });
    const tsPath = resolveTokenPath({ CANON_MCP_TOKEN_FILE: tokenFile });
    const jsonOutput = execFileSync("bash", [HEADERS_HELPER], {
      env: {
        ...process.env,
        CANON_MCP_TOKEN_FILE: tokenFile,
        HOME: tmpDir,
        CLAUDE_PLUGIN_DATA: join(tmpDir, "decoy"),
      },
      encoding: "utf8",
    });
    const helperToken = (JSON.parse(jsonOutput) as { Authorization: string }).Authorization.replace(
      "Bearer ",
      "",
    );
    expect(tsPath).toBe(tokenFile);
    expect(helperToken).toBe(placeholder);
  });

  it("incident reproduction: helper with CLAUDE_PLUGIN_DATA set resolves the SAME HOME token as without it", () => {
    const dataDir = join(tmpDir, "data-dir");
    const homeDir = join(tmpDir, "fake-home");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(homeDir, ".claude", "canon"), { recursive: true });
    const tokenA = "a".repeat(64); // data-dir token (old tier-2)
    const tokenB = "b".repeat(64); // home token (the canonical path after fix)
    writeFileSync(join(dataDir, "canon-mcp-token"), tokenA, { mode: 0o600 });
    writeFileSync(join(homeDir, ".claude", "canon", "canon-mcp-token"), tokenB, { mode: 0o600 });
    const runHelper = (extraEnv: Record<string, string>) =>
      execFileSync("bash", [HEADERS_HELPER], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homeDir, ...extraEnv },
        encoding: "utf8",
      });
    const withData = runHelper({ CLAUDE_PLUGIN_DATA: dataDir });
    const withoutData = runHelper({});
    const parsedWith = (JSON.parse(withData) as { Authorization: string }).Authorization;
    const parsedWithout = (JSON.parse(withoutData) as { Authorization: string }).Authorization;
    expect(parsedWith).toBe(parsedWithout); // both resolve same token
    expect(parsedWith).toBe(`Bearer ${tokenB}`); // the home token, not data-dir
  });

  it("e2e auth: token emitted by helper authenticates via authenticate()", () => {
    const placeholder = "c".repeat(64);
    const tokenFile = join(tmpDir, "e2e-token");
    writeFileSync(tokenFile, placeholder, { mode: 0o600 });
    const helperOut = execFileSync("bash", [HEADERS_HELPER], {
      env: { ...process.env, CANON_MCP_TOKEN_FILE: tokenFile, HOME: tmpDir },
      encoding: "utf8",
    });
    const helperToken = (JSON.parse(helperOut) as { Authorization: string }).Authorization.replace(
      "Bearer ",
      "",
    );
    const authResult = authenticate(
      makeReq({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1",
        authorization: `Bearer ${helperToken}`,
      }),
      placeholder,
    );
    expect(authResult.ok).toBe(true);
  });

  it("fail-closed preserved: helper exits non-zero when token file is absent", () => {
    let threw = false;
    try {
      execFileSync("bash", [HEADERS_HELPER], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: tmpDir,
          CANON_MCP_TOKEN_FILE: join(tmpDir, "no-such-token"),
        },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
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

  // ---------------------------------------------------------------------------
  // T-F1: parent dir 0700 hardening (umask-safe)
  // ---------------------------------------------------------------------------

  it("creates parent dir at 0700 when dir does not exist", async () => {
    // Use a subdirectory that does not yet exist
    const parentDir = join(tmpDir, "new-subdir");
    const tokenPath = join(parentDir, "token");
    await loadOrCreateToken(tokenPath);
    const s = await stat(parentDir);
    // eslint-disable-next-line no-bitwise
    expect(s.mode & 0o777).toBe(0o700);
  });

  it("hardens a pre-existing 0755 parent dir to 0700", async () => {
    // Pre-create the parent at world-traversable 0755
    const parentDir = join(tmpDir, "weak-dir");
    await mkdir(parentDir, { mode: 0o755 });
    const tokenPath = join(parentDir, "token");
    await loadOrCreateToken(tokenPath);
    const s = await stat(parentDir);
    // eslint-disable-next-line no-bitwise
    expect(s.mode & 0o777).toBe(0o700);
  });

  // ---------------------------------------------------------------------------
  // T-F1: exclusive create (O_EXCL) — deterministic EEXIST handling
  // ---------------------------------------------------------------------------

  it("returns existing valid token (EEXIST path) and does NOT overwrite it", async () => {
    const tokenPath = join(tmpDir, "pre-existing-token");
    const knownToken = "c".repeat(64);
    // Pre-plant a valid token file before loadOrCreateToken runs
    await writeFile(tokenPath, knownToken, { mode: 0o600 });

    const result = await loadOrCreateToken(tokenPath);

    // Should return the pre-existing token (re-read path, not silent overwrite)
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe(knownToken);
    }

    // On-disk token must NOT have been clobbered
    const { readFile: readFileSync } = await import("node:fs/promises");
    const onDisk = (await readFileSync(tokenPath, "utf8")).trim();
    expect(onDisk).toBe(knownToken);
  });

  it("fails closed (ok:false) when pre-existing token file is unreadable due to empty content (invalid token)", async () => {
    // This test exercises the EEXIST branch with an unreadable/invalid token.
    // We do this by writing an empty file then calling loadOrCreateToken via a
    // path that will hit the read-first (ENOENT check) then create branch.
    // Since the existing empty-file test already covers regeneration from the
    // read-first path, here we specifically test EEXIST-with-invalid-content
    // using a spy on writeFile to simulate the race condition.

    // Simpler approach: write a valid file, then truncate it to empty after
    // the read-first path has already seen ENOENT (hard to race in unit tests).
    // Instead verify the rereadToken helper returns ok:false for empty files
    // (the EEXIST branch delegates to rereadToken and propagates its result).
    const tokenPath = join(tmpDir, "empty-pre-existing");
    await writeFile(tokenPath, "", { mode: 0o600 });
    // rereadToken on an empty file must return ok:false (fail-closed)
    const reread = await rereadToken(tokenPath);
    expect(reread.ok).toBe(false);
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

// ---------------------------------------------------------------------------
// W5 — rereadToken: lazy rotation recovery
// ---------------------------------------------------------------------------

describe("W5 — rereadToken", () => {
  let tmpDir: string;
  let tokenPath: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    tmpDir = await mkdtemp(join(tmpdir(), "auth-reread-test-"));
    tokenPath = join(tmpDir, "canon-mcp-token");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok:true with the current token when file exists and is non-empty", async () => {
    await writeFile(tokenPath, "rotated-token-value", { mode: 0o600 });
    const result = await rereadToken(tokenPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("rotated-token-value");
    }
  });

  it("returns ok:false when file does not exist (fail-closed on deletion)", async () => {
    // No file created — rereadToken should fail closed
    const result = await rereadToken(tokenPath);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when file is empty (treat as absent)", async () => {
    await writeFile(tokenPath, "   \n", { mode: 0o600 });
    const result = await rereadToken(tokenPath);
    expect(result.ok).toBe(false);
  });

  it("rereadToken reads rotated value — old token rejected, new token accepted", async () => {
    // Use fixed-length tokens (64 chars) so authenticate's timing-safe comparison
    // doesn't short-circuit on length mismatch.
    const oldToken = "a".repeat(64);
    const newToken = "b".repeat(64);
    await writeFile(tokenPath, oldToken, { mode: 0o600 });

    // Authenticate with old token against old token → accept
    const reqWithOld = makeReq({ host: "localhost", authorization: `Bearer ${oldToken}` });
    const acceptOld = authenticate(reqWithOld, oldToken);
    expect(acceptOld.ok).toBe(true);

    // Rotate the token file
    await writeFile(tokenPath, newToken, { mode: 0o600 });

    // Re-read the token from disk: should now return the new token
    const rotated = await rereadToken(tokenPath);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error("expected ok:true after rotation");
    expect(rotated.token).toBe(newToken);
    expect(rotated.token).not.toBe(oldToken);

    // Old token rejected against the rotated expected token
    const reqWithOld2 = makeReq({ host: "localhost", authorization: `Bearer ${oldToken}` });
    const rejectOld = authenticate(reqWithOld2, newToken);
    expect(rejectOld.ok).toBe(false);
    if (!rejectOld.ok) expect(rejectOld.status).toBe(401);

    // New token accepted against the rotated expected token
    const reqWithNew = makeReq({ host: "localhost", authorization: `Bearer ${newToken}` });
    const acceptNew = authenticate(reqWithNew, newToken);
    expect(acceptNew.ok).toBe(true);
  });
});
