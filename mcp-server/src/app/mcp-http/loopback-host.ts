/**
 * Shared loopback Host-header guard — DNS-rebinding protection.
 *
 * Single source of truth for the loopback allowlist and hostname extraction
 * used by auth.ts, daemon.ts, and http-server.ts. All three previously
 * maintained byte-identical private copies; this module consolidates them so
 * a future hardening change is applied in one place.
 *
 * Responsibility: decide whether an HTTP request's Host header names an
 * allowed loopback host.
 *
 * Security invariant (fail-closed): a missing, empty, or non-loopback Host
 * header always returns false — the caller is expected to respond 403.
 */

import type { IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Hostnames accepted in the Host header after stripping any port suffix.
 * IPv6 bracket notation is kept intact: "[::1]" not "::1".
 */
export const LOOPBACK_ALLOWED_HOSTS = new Set<string>(["127.0.0.1", "localhost", "[::1]"]);

// ---------------------------------------------------------------------------
// Hostname extraction
// ---------------------------------------------------------------------------

/**
 * Extract the hostname from a Host header value, stripping any port suffix.
 *
 * Examples:
 * - "localhost"         → "localhost"
 * - "localhost:3141"    → "localhost"
 * - "127.0.0.1:3141"   → "127.0.0.1"
 * - "[::1]"            → "[::1]"
 * - "[::1]:3142"       → "[::1]"
 * - "[::1" (malformed) → "[::1" (returned as-is; will not match allowlist)
 */
export function extractLoopbackHostname(host: string): string {
  // IPv6 literal: "[::1]" or "[::1]:port"
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    if (closingBracket !== -1) {
      return host.slice(0, closingBracket + 1);
    }
    // Malformed IPv6 — return as-is so the caller compares against the
    // allowlist and rejects it.
    return host;
  }
  // IPv4 or hostname: strip port suffix (last colon).
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx !== -1) {
    return host.slice(0, colonIdx);
  }
  return host;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Return true if `hostHeader` (a raw Host header value, possibly including a
 * port) names an allowed loopback host.
 *
 * Fail-closed: empty string → false.
 */
export function isAllowedLoopbackHost(hostHeader: string): boolean {
  if (!hostHeader) return false;
  return LOOPBACK_ALLOWED_HOSTS.has(extractLoopbackHostname(hostHeader));
}

/**
 * Return true if the request's Host header names an allowed loopback host.
 *
 * Fail-closed: missing Host header → false → caller responds 403.
 * Mirrors the DNS-rebinding guard pattern used across all Canon HTTP
 * endpoints (sidecar :3141, daemon :3142, MCP auth).
 */
export function isLoopbackHostRequest(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (!hostHeader) return false;
  return isAllowedLoopbackHost(hostHeader);
}
