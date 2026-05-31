/**
 * Tests for server-state — module-global project dir + gated handler machinery.
 *
 * Covers existing behavior (characterization) BEFORE the 1a refactor so these
 * become the no-op-regression guard:
 *
 *   Characterization (pre-refactor invariants):
 *   - projectDir starts as process.cwd()
 *   - setProjectDir mutates the global
 *   - readyPromise is pending until resolveReady() is called
 *   - gatedWrapHandler blocks until readyPromise resolves
 *
 *   1a additions:
 *   - resolveScope falls back to global projectDir when no session is active
 *   - resolveScope returns per-session value when session is registered
 *   - Two sessions get independent scopes
 *   - registerConnectionScope stores scope; clearConnectionScope removes it
 *   - setProjectDir updates both the global AND the stdio sentinel scope
 *
 * NOTE: server-state.ts is a module singleton — some tests reach into internals
 * via exported helpers rather than re-requiring the module.  We reset
 * the mutable state between tests using the exported resetForTesting() helper.
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearConnectionScope,
  gatedWrapHandler,
  registerConnectionScope,
  resetForTesting,
  resolveReady,
  resolveScope,
  STDIO_SESSION_ID,
  setProjectDir,
} from "../server-state.ts";

// Helper: create a minimal RequestHandlerExtra-compatible object.
// We only need signal + sessionId for resolveScope; other fields are stubbed.
function makeExtra(sessionId?: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestId: "test-req-1",
    sessionId,
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

// ── Characterization tests ────────────────────────────────────────────────────

describe("server-state: characterization (existing invariants)", () => {
  // These tests use a fresh module state via resetForTesting().
  // We do NOT check the exact initial value of projectDir (it's process.cwd() which
  // varies by environment); instead we verify the mutation semantics.

  afterEach(() => {
    resetForTesting();
  });

  it("setProjectDir updates the exported projectDir binding", () => {
    setProjectDir("/test/project/alpha");
    // Can't re-import the binding but the value is accessible through the module's live binding.
    // We test this indirectly through resolveScope (no sessionId → returns global).
    expect(resolveScope(makeExtra(undefined))).toBe("/test/project/alpha");
  });

  it("gatedWrapHandler blocks until readyPromise resolves, then calls handler", async () => {
    resetForTesting();
    const calls: string[] = [];

    const wrapped = gatedWrapHandler(async (_input: unknown, _extra: unknown) => {
      calls.push("handler");
      return "ok";
    });

    // Kick off the call (does NOT await — it should be blocked)
    const pending = wrapped(null, makeExtra(undefined));
    calls.push("after-start");

    // Not resolved yet — handler should not have run
    // Give the microtask queue a moment
    await Promise.resolve();
    expect(calls).toEqual(["after-start"]);

    // Resolve the ready promise
    resolveReady();

    // Now the handler should complete
    const result = await pending;
    expect(calls).toContain("handler");
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("ok") }] });
  });

  it("gatedWrapHandler proceeds immediately when already resolved", async () => {
    resetForTesting();
    resolveReady(); // resolve before wrapping

    const wrapped = gatedWrapHandler(async (_input: unknown, _extra: unknown) => "immediate");
    const result = await wrapped(null, makeExtra(undefined));
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("immediate") }] });
  });
});

// ── 1a additions: resolveScope + per-connection memoization ──────────────────

describe("resolveScope: per-connection memoization", () => {
  afterEach(() => {
    resetForTesting();
  });

  it("returns the global projectDir when extra.sessionId is undefined", () => {
    setProjectDir("/global/project");
    expect(resolveScope(makeExtra(undefined))).toBe("/global/project");
  });

  it("returns the global projectDir when extra.sessionId is the stdio sentinel", () => {
    setProjectDir("/global/project");
    expect(resolveScope(makeExtra(STDIO_SESSION_ID))).toBe("/global/project");
  });

  it("returns per-session value for a registered session", () => {
    setProjectDir("/global/project");
    registerConnectionScope("session-A", "/project/A");
    expect(resolveScope(makeExtra("session-A"))).toBe("/project/A");
  });

  it("returns global when session is not registered", () => {
    setProjectDir("/global/project");
    expect(resolveScope(makeExtra("unknown-session"))).toBe("/global/project");
  });

  it("two sessions get independent scopes", () => {
    registerConnectionScope("session-A", "/project/A");
    registerConnectionScope("session-B", "/project/B");
    expect(resolveScope(makeExtra("session-A"))).toBe("/project/A");
    expect(resolveScope(makeExtra("session-B"))).toBe("/project/B");
  });

  it("clearConnectionScope removes a registered session", () => {
    setProjectDir("/global/project");
    registerConnectionScope("session-A", "/project/A");
    clearConnectionScope("session-A");
    // Falls back to global after removal
    expect(resolveScope(makeExtra("session-A"))).toBe("/global/project");
  });

  it("setProjectDir updates the stdio sentinel scope", () => {
    setProjectDir("/new/project");
    expect(resolveScope(makeExtra(STDIO_SESSION_ID))).toBe("/new/project");
  });

  it("setProjectDir does not override an explicitly registered non-stdio session", () => {
    registerConnectionScope("http-session", "/project/http");
    setProjectDir("/stdio/project");
    // http-session should keep its own value
    expect(resolveScope(makeExtra("http-session"))).toBe("/project/http");
    // stdio sentinel should reflect the new global
    expect(resolveScope(makeExtra(STDIO_SESSION_ID))).toBe("/stdio/project");
  });
});

// ── Connection lifecycle helpers ─────────────────────────────────────────────

describe("registerConnectionScope / clearConnectionScope", () => {
  afterEach(() => {
    resetForTesting();
  });

  it("registerConnectionScope stores the scope and overrides previous value", () => {
    registerConnectionScope("s1", "/first");
    registerConnectionScope("s1", "/second");
    expect(resolveScope(makeExtra("s1"))).toBe("/second");
  });

  it("clearConnectionScope is a no-op for unknown session IDs", () => {
    // Should not throw
    expect(() => clearConnectionScope("no-such-session")).not.toThrow();
  });
});
