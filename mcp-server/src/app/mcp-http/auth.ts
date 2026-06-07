/**
 * Canon HTTP MCP — loopback authentication module.
 *
 * ## Security model
 * - Token file at 0600; generated with crypto.randomBytes(32).toString("hex") (64 hex chars).
 * - `loadOrCreateToken` fails CLOSED: any unrecoverable fs error → `{ ok: false }`.
 *   Callers must serve 503 and never run the MCP route unauthenticated.
 * - `authenticate` asserts loopback remoteAddress (defense-in-depth behind 127.0.0.1
 *   bind) and safe Host header (DNS-rebinding guard) before token comparison.
 * - Token comparison uses `crypto.timingSafeEqual` on equal-length Buffers.
 *   Length mismatch → 401 WITHOUT calling timingSafeEqual (it throws on unequal lengths).
 *
 * ## No side effects at import time
 * All fs and crypto operations are behind exported functions — importable in tests
 * without any tmp dir setup.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated-union result from loadOrCreateToken. */
export type TokenResult = { ok: true; token: string } | { ok: false; error: string };

/** Discriminated-union result from authenticate. */
export type AuthResult = { ok: true } | { ok: false; reason: string; status: 401 | 403 };

// ---------------------------------------------------------------------------
// Loopback / Host allowlists
// ---------------------------------------------------------------------------

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Allowed hostnames in the Host header (after stripping port). */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// ---------------------------------------------------------------------------
// Token path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the token file path from the environment.
 *
 * Resolution order:
 * 1. `env.CANON_MCP_TOKEN_FILE` — explicit override
 * 2. `env.CLAUDE_PLUGIN_DATA` → `${CLAUDE_PLUGIN_DATA}/canon-mcp-token`
 * 3. `${os.homedir()}/.claude/canon/canon-mcp-token` — dev fallback
 *
 * @param env - Environment to inspect (default: `process.env`). Injectable for testing.
 */
export function resolveTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CANON_MCP_TOKEN_FILE) {
    return env.CANON_MCP_TOKEN_FILE;
  }
  if (env.CLAUDE_PLUGIN_DATA) {
    return join(env.CLAUDE_PLUGIN_DATA, "canon-mcp-token");
  }
  return join(homedir(), ".claude", "canon", "canon-mcp-token");
}

// ---------------------------------------------------------------------------
// Token load / create
// ---------------------------------------------------------------------------

/**
 * Reads the token from `tokenPath` if it exists and is non-empty.
 * Unlike `loadOrCreateToken`, this does NOT create a new token if absent.
 *
 * Returns `{ ok: true, token }` if the file exists and is non-empty.
 * Returns `{ ok: false, error }` if absent, empty, or unreadable.
 *
 * Used for lazy re-read on token mismatch (W5: token rotation recovery).
 *
 * @param tokenPath - Absolute path to the token file.
 */
export async function rereadToken(tokenPath: string): Promise<TokenResult> {
  try {
    const existing = await readFile(tokenPath, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      return { ok: true, token: trimmed };
    }
    return { error: "token file is empty", ok: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, ok: false };
  }
}

/**
 * Loads the token from `tokenPath`, or creates a new one if the file is absent
 * or has empty/whitespace content.
 *
 * On create:
 * - `mkdir -p` parent directory
 * - Generate 32 random bytes → 64-char hex string
 * - `writeFile(..., { mode: 0o600 })` then explicit `chmod(path, 0o600)`
 *   (writeFile mode is umask-masked; explicit chmod is umask-safe)
 *
 * Returns `{ ok: false, error }` for any unrecoverable fs error.
 * Callers MUST serve 503 and never fall through to the MCP route.
 *
 * @param tokenPath - Absolute path to the token file.
 */
export async function loadOrCreateToken(tokenPath: string): Promise<TokenResult> {
  // Attempt to read existing file
  try {
    const existing = await readFile(tokenPath, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      // Valid existing token
      return { ok: true, token: trimmed };
    }
    // Fall through to regenerate — treat empty/whitespace as absent
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") {
      // Read failed for a reason other than "file absent" — log and fail closed
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Canon MCP ERROR: could not read token file ${tokenPath}: ${message}\n`);
      return { error: message, ok: false };
    }
    // ENOENT — proceed to create
  }

  // Create new token
  try {
    const parentDir = dirname(tokenPath);
    await mkdir(parentDir, { recursive: true });

    const token = randomBytes(32).toString("hex");

    // writeFile mode is umask-masked — explicit chmod ensures 0600 regardless of umask
    await writeFile(tokenPath, token, { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    return { ok: true, token };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Canon MCP ERROR: could not create token file ${tokenPath}: ${message}\n`);
    return { error: message, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

/**
 * Authenticates an incoming request against the expected token.
 *
 * Checks (in order):
 * 1. Loopback assert: `req.socket.remoteAddress` ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1} → else 403
 * 2. Host-header check: hostname part ∈ {127.0.0.1, localhost, [::1]} → else 403
 * 3. Authorization: `Bearer <token>` — missing/malformed → 401
 * 4. Token comparison via `crypto.timingSafeEqual` on equal-length Buffers
 *    — length mismatch short-circuits to 401 WITHOUT calling timingSafeEqual
 *
 * @param req - Incoming HTTP request.
 * @param expectedToken - The loaded token to compare against.
 */
export function authenticate(req: IncomingMessage, expectedToken: string): AuthResult {
  // 1. Loopback check (defense-in-depth behind 127.0.0.1 bind)
  const remoteAddress = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_ADDRESSES.has(remoteAddress)) {
    return {
      ok: false,
      reason: `Non-loopback address rejected: ${remoteAddress}`,
      status: 403,
    };
  }

  // 2. Host-header check (DNS-rebinding guard)
  const hostHeader = req.headers.host;
  if (!hostHeader) {
    return {
      ok: false,
      reason: "Missing Host header",
      status: 403,
    };
  }
  const hostname = extractHostname(hostHeader);
  if (!ALLOWED_HOSTS.has(hostname)) {
    return {
      ok: false,
      reason: `Host header rejected: ${hostHeader}`,
      status: 403,
    };
  }

  // 3. Authorization header check
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      reason: "Missing or malformed Authorization header",
      status: 401,
    };
  }
  const providedToken = authHeader.slice("Bearer ".length);

  // 4. Timing-safe comparison — length must match before calling timingSafeEqual
  //    (timingSafeEqual throws on unequal-length buffers)
  const expectedBuf = Buffer.from(expectedToken);
  const providedBuf = Buffer.from(providedToken);

  if (expectedBuf.length !== providedBuf.length) {
    return {
      ok: false,
      reason: "Token length mismatch",
      status: 401,
    };
  }

  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return {
      ok: false,
      reason: "Invalid token",
      status: 401,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the hostname from a Host header value, stripping any port suffix.
 *
 * Examples:
 * - "localhost"       → "localhost"
 * - "localhost:3142"  → "localhost"
 * - "127.0.0.1:3142" → "127.0.0.1"
 * - "[::1]"          → "[::1]"
 * - "[::1]:3142"     → "[::1]"
 */
function extractHostname(host: string): string {
  // IPv6 literal: [::1] or [::1]:port
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    if (closingBracket !== -1) {
      return host.slice(0, closingBracket + 1);
    }
    return host;
  }
  // IPv4 or hostname: strip port suffix
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx !== -1) {
    return host.slice(0, colonIdx);
  }
  return host;
}
