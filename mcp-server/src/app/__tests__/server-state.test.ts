/**
 * Tests for server-state — per-connection scope registry + gated handler machinery.
 *
 * Covers:
 *   Characterization (post-1d invariants):
 *   - readyPromise is pending until resolveReady() is called
 *   - gatedWrapHandler blocks until readyPromise resolves
 *
 *   1a additions:
 *   - resolveScope returns per-session value when session is registered
 *   - Two sessions get independent scopes
 *   - registerConnectionScope stores scope; clearConnectionScope removes it
 *
 *   1d additions:
 *   - stdio sentinel preserves old global behavior: undefined/unregistered sessionId
 *     returns the sentinel value after registerConnectionScope(STDIO_SESSION_ID, dir)
 *   - resolveScope throws for a fully-unregistered session (fail-closed)
 *   - resetForTesting clears the registry (sentinel is gone)
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
  findAnchorDir,
  gatedWrapHandler,
  registerConnectionScope,
  resetForTesting,
  resolveReady,
  resolveScope,
  STDIO_SESSION_ID,
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
  afterEach(() => {
    resetForTesting();
  });

  it("registerConnectionScope(STDIO_SESSION_ID) seeds scope accessible via resolveScope", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/test/project/alpha");
    // No sessionId → returns sentinel value (stdio behavior)
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

  it("returns the sentinel value when extra.sessionId is undefined (stdio behavior)", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/project");
    expect(resolveScope(makeExtra(undefined))).toBe("/global/project");
  });

  it("returns the sentinel value when extra.sessionId is the stdio sentinel ID", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/project");
    expect(resolveScope(makeExtra(STDIO_SESSION_ID))).toBe("/global/project");
  });

  it("returns per-session value for a registered session (over sentinel)", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/project");
    registerConnectionScope("session-A", "/project/A");
    expect(resolveScope(makeExtra("session-A"))).toBe("/project/A");
  });

  it("falls back to sentinel when session is not registered but sentinel exists", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/project");
    expect(resolveScope(makeExtra("unknown-session"))).toBe("/global/project");
  });

  it("two sessions get independent scopes", () => {
    registerConnectionScope("session-A", "/project/A");
    registerConnectionScope("session-B", "/project/B");
    expect(resolveScope(makeExtra("session-A"))).toBe("/project/A");
    expect(resolveScope(makeExtra("session-B"))).toBe("/project/B");
  });

  it("clearConnectionScope removes a registered session, falls back to sentinel", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/project");
    registerConnectionScope("session-A", "/project/A");
    clearConnectionScope("session-A");
    // Falls back to sentinel after removal
    expect(resolveScope(makeExtra("session-A"))).toBe("/global/project");
  });

  it("registerConnectionScope(STDIO_SESSION_ID) updates the stdio sentinel scope", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/new/project");
    expect(resolveScope(makeExtra(STDIO_SESSION_ID))).toBe("/new/project");
  });

  it("re-registering STDIO_SESSION_ID does not override an explicitly registered non-stdio session", () => {
    registerConnectionScope("http-session", "/project/http");
    registerConnectionScope(STDIO_SESSION_ID, "/stdio/project");
    // http-session should keep its own value
    expect(resolveScope(makeExtra("http-session"))).toBe("/project/http");
    // stdio sentinel should reflect the new value
    expect(resolveScope(makeExtra(STDIO_SESSION_ID))).toBe("/stdio/project");
  });
});

// ── gatedWrapHandler: error branches ─────────────────────────────────────────

describe("gatedWrapHandler: error branches", () => {
  afterEach(() => {
    resetForTesting();
  });

  it("converts a generic throw to an UNEXPECTED error response", async () => {
    resetForTesting();
    resolveReady(); // resolve so handler executes

    const wrapped = gatedWrapHandler(async (_input: unknown, _extra: unknown) => {
      throw new Error("something blew up");
    });

    const result = await wrapped(null, makeExtra(undefined));
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      error_code: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
  });

  it("converts a 'directory does not exist' throw to WORKSPACE_NOT_FOUND", async () => {
    resetForTesting();
    resolveReady(); // resolve so handler executes

    const wrapped = gatedWrapHandler(async (_input: unknown, _extra: unknown) => {
      throw new Error("workspace directory does not exist on disk");
    });

    const result = await wrapped(null, makeExtra(undefined));
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      error_code: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("WORKSPACE_NOT_FOUND");
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

// ── 1d: stdio sentinel no-op + fail-closed behavior ─────────────────────────
//
// After deleting the projectDir global and setProjectDir, the only way to seed
// scope is registerConnectionScope(STDIO_SESSION_ID, dir). These tests verify:
//   1. After seeding the sentinel, resolveScope with undefined OR an unregistered
//      sessionId BOTH return the sentinel value (behavioral no-op under stdio).
//   2. resolveScope throws for a fully-unregistered session (no per-session entry,
//      no sentinel) — fail-closed behavior replacing the old ?? projectDir fallback.
//   3. resetForTesting() clears the registry so the sentinel is gone.

describe("1d: stdio sentinel no-op + fail-closed resolveScope", () => {
  afterEach(() => {
    resetForTesting();
  });

  it("after registerConnectionScope(STDIO_SESSION_ID), resolveScope with undefined sessionId returns sentinel value", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/sentinel/project");
    expect(resolveScope(makeExtra(undefined))).toBe("/sentinel/project");
  });

  it("after registerConnectionScope(STDIO_SESSION_ID), resolveScope with an unregistered sessionId returns sentinel value", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/sentinel/project");
    expect(resolveScope(makeExtra("unregistered-http-session"))).toBe("/sentinel/project");
  });

  it("resolveScope throws when no sentinel AND no per-session entry exists", () => {
    // resetForTesting() clears registry — no sentinel, no per-session entry
    expect(() => resolveScope(makeExtra(undefined))).toThrow(
      /resolveScope: no project scope for session/,
    );
  });

  it("resolveScope throw message includes the session ID when provided", () => {
    expect(() => resolveScope(makeExtra("orphan-session"))).toThrow(/orphan-session/);
  });

  it("resolveScope throw message mentions (none) when sessionId is undefined", () => {
    expect(() => resolveScope(makeExtra(undefined))).toThrow(/\(none\)/);
  });

  it("resolveScope does NOT throw after the sentinel is registered", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/ok");
    expect(() => resolveScope(makeExtra(undefined))).not.toThrow();
  });

  it("resetForTesting clears the registry so the sentinel is gone", () => {
    registerConnectionScope(STDIO_SESSION_ID, "/before-reset");
    resetForTesting();
    expect(() => resolveScope(makeExtra(undefined))).toThrow(/resolveScope: no project scope/);
  });
});

// ── findAnchorDir: marker-walk plugin root resolution ────────────────────────
//
// These tests drive findAnchorDir with a fake existsFn so they are fully
// hermetic — no real filesystem stat calls, no dependency on the repo layout.
//
// Test cases (per T1-fix-plugindir-seed-PLAN.md Step 1):
//   1. src/app-depth start → resolves to plugin root
//   2. dist-depth start   → same root (layout-independent, proves AC#2)
//   3. mcpServerRoot marker (boot.sh) → resolves to mcp-server dir
//   4. not-found           → throws with diagnostic message
//   5. env override        → documented as short-circuit before walk

describe("findAnchorDir: marker-walk plugin root resolution", () => {
  it("resolves from src/app-depth start to the plugin root (AC#1, AC#2)", () => {
    // Markers present at /repo: /repo/agents and /repo/principles
    const existsFn = (p: string) => p === "/repo/agents" || p === "/repo/principles";
    const result = findAnchorDir("/repo/mcp-server/src/app", ["agents", "principles"], existsFn);
    expect(result).toBe("/repo");
  });

  it("resolves from dist-depth start to the same root as src/app-depth (AC#2 layout independence)", () => {
    // Same markers, deeper start — proves no fixed dirname count assumption
    const existsFn = (p: string) => p === "/repo/agents" || p === "/repo/principles";
    const result = findAnchorDir(
      "/repo/mcp-server/dist/src/app",
      ["agents", "principles"],
      existsFn,
    );
    expect(result).toBe("/repo");
  });

  it("resolves mcpServerRoot via boot.sh marker to the mcp-server dir", () => {
    // boot.sh present at /repo/mcp-server/boot.sh — absent at repo root and src/
    const existsFn = (p: string) => p === "/repo/mcp-server/boot.sh";
    const result = findAnchorDir("/repo/mcp-server/src/app", ["boot.sh"], existsFn);
    expect(result).toBe("/repo/mcp-server");
  });

  it("throws with a diagnostic message when no ancestor contains the markers", () => {
    // existsFn always returns false → walk will reach filesystem root and throw
    const existsFn = () => false;
    expect(() =>
      findAnchorDir("/repo/mcp-server/src/app", ["agents", "principles"], existsFn),
    ).toThrow(/agents/);
    expect(() =>
      findAnchorDir("/repo/mcp-server/src/app", ["agents", "principles"], existsFn),
    ).toThrow(/CANON_PLUGIN_DIR/);
  });

  it("resolves in a single step when markers are present in startDir itself", () => {
    // Markers already exist at the start dir — should return start dir immediately
    const existsFn = (p: string) => p === "/repo/agents" || p === "/repo/principles";
    const result = findAnchorDir("/repo", ["agents", "principles"], existsFn);
    expect(result).toBe("/repo");
  });
});
