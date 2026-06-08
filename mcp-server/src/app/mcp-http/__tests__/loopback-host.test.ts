/**
 * Tests for mcp-http/loopback-host.ts — shared loopback Host-header guard.
 *
 * This module is the single source of truth for the DNS-rebinding allowlist
 * used by auth.ts, daemon.ts, and http-server.ts. These tests verify:
 *   - Allowlist members are accepted
 *   - Non-loopback and spoofed hosts are rejected
 *   - Port suffixes are stripped correctly (IPv4, IPv6, hostname)
 *   - Fail-closed behaviour: missing Host → rejected
 *   - Edge cases: trailing-dot, extra brackets, bare IP
 */

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  extractLoopbackHostname,
  isAllowedLoopbackHost,
  isLoopbackHostRequest,
} from "../loopback-host.js";

// ---------------------------------------------------------------------------
// extractLoopbackHostname
// ---------------------------------------------------------------------------

describe("extractLoopbackHostname", () => {
  it("returns bare hostname unchanged", () => {
    expect(extractLoopbackHostname("localhost")).toBe("localhost");
  });

  it("strips port from IPv4 host", () => {
    expect(extractLoopbackHostname("127.0.0.1:3141")).toBe("127.0.0.1");
  });

  it("strips port from hostname with port", () => {
    expect(extractLoopbackHostname("localhost:3141")).toBe("localhost");
  });

  it("strips port from IPv6 bracket notation", () => {
    expect(extractLoopbackHostname("[::1]:3142")).toBe("[::1]");
  });

  it("returns bare IPv6 bracket notation unchanged", () => {
    expect(extractLoopbackHostname("[::1]")).toBe("[::1]");
  });

  it("handles unclosed bracket gracefully (returns input as-is)", () => {
    // Malformed — no closing bracket. Return the full string so callers
    // can compare against the allowlist and reject.
    expect(extractLoopbackHostname("[::1")).toBe("[::1");
  });
});

// ---------------------------------------------------------------------------
// isAllowedLoopbackHost
// ---------------------------------------------------------------------------

describe("isAllowedLoopbackHost", () => {
  // Allowlist members (with and without port)
  it("accepts 127.0.0.1", () => {
    expect(isAllowedLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("accepts 127.0.0.1 with port", () => {
    expect(isAllowedLoopbackHost("127.0.0.1:3141")).toBe(true);
  });

  it("accepts localhost", () => {
    expect(isAllowedLoopbackHost("localhost")).toBe(true);
  });

  it("accepts localhost with port", () => {
    expect(isAllowedLoopbackHost("localhost:3141")).toBe(true);
  });

  it("accepts [::1]", () => {
    expect(isAllowedLoopbackHost("[::1]")).toBe(true);
  });

  it("accepts [::1] with port", () => {
    expect(isAllowedLoopbackHost("[::1]:3142")).toBe(true);
  });

  // Non-loopback and spoofed hosts
  it("rejects external hostname", () => {
    expect(isAllowedLoopbackHost("evil.example.com")).toBe(false);
  });

  it("rejects external hostname with port", () => {
    expect(isAllowedLoopbackHost("evil.example.com:80")).toBe(false);
  });

  it("rejects non-loopback IP", () => {
    expect(isAllowedLoopbackHost("192.168.1.1")).toBe(false);
  });

  it("rejects non-loopback IP with port", () => {
    expect(isAllowedLoopbackHost("10.0.0.1:3141")).toBe(false);
  });

  // Trailing dot — not in allowlist, correctly rejected
  it("rejects trailing-dot variant of 127.0.0.1", () => {
    expect(isAllowedLoopbackHost("127.0.0.1.")).toBe(false);
  });

  it("rejects trailing-dot variant of localhost", () => {
    expect(isAllowedLoopbackHost("localhost.")).toBe(false);
  });

  // Empty string
  it("rejects empty string", () => {
    expect(isAllowedLoopbackHost("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackHostRequest — fail-closed on missing Host header
// ---------------------------------------------------------------------------

function makeReq(host?: string): IncomingMessage {
  return {
    headers: host !== undefined ? { host } : {},
  } as unknown as IncomingMessage;
}

describe("isLoopbackHostRequest", () => {
  it("returns true for loopback Host header", () => {
    expect(isLoopbackHostRequest(makeReq("127.0.0.1:3141"))).toBe(true);
  });

  it("returns true for localhost Host header", () => {
    expect(isLoopbackHostRequest(makeReq("localhost:3141"))).toBe(true);
  });

  it("returns true for IPv6 loopback Host header", () => {
    expect(isLoopbackHostRequest(makeReq("[::1]:3142"))).toBe(true);
  });

  it("returns false (fail-closed) when Host header is absent", () => {
    expect(isLoopbackHostRequest(makeReq())).toBe(false);
  });

  it("returns false for non-loopback Host header", () => {
    expect(isLoopbackHostRequest(makeReq("attacker.example.com"))).toBe(false);
  });

  it("returns false for spoofed trailing-dot host", () => {
    expect(isLoopbackHostRequest(makeReq("127.0.0.1."))).toBe(false);
  });
});
