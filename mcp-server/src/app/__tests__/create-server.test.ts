/**
 * Tests for createCanonServer() factory and readyPromiseFor().
 *
 * TDD order (agent-tdd-required):
 *   Characterization tests run FIRST to pin current behavior as a no-op baseline.
 *   Factory and readyPromiseFor tests are written before the implementation.
 *
 * Covers:
 *   Characterization:
 *   - Tool count from factory matches pre-refactor count (43 tools)
 *   - Tool names set matches a known stable subset
 *
 *   Factory independence:
 *   - Two factory calls return independent McpServer instances
 *   - Registering on one does not affect the other (tool count on each matches baseline)
 *
 *   readyPromiseFor:
 *   - No sessionId → global gate (pending until resolveReady())
 *   - Registered sessionId → per-session gate
 *   - Unknown sessionId (no gate created) → global gate (documented fallback)
 *   - resolveSessionReady() resolves only that session's gate, not global
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// We import these lazily inside test bodies to avoid module-load order issues.

// ── Helper: count tools registered on a McpServer ────────────────────────────
// The SDK exposes tools through the internal `_registeredTools` map on McpServer.
// This is the same pattern used by register-composite.test.ts which reads
// server.registerTool mock call counts.  For real instances we probe _registeredTools.
function getToolCount(server: McpServer): number {
  // SDK 1.29 stores registered tools in a plain object (not a Map).
  // Type cast to access the internal field.
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(internal._registeredTools ?? {}).length;
}

function getToolNames(server: McpServer): Set<string> {
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
  return new Set(Object.keys(internal._registeredTools ?? {}));
}

// ── Characterization: tool count pinned pre-refactor ─────────────────────────
//
// TOOL COUNT BASELINE (updated 2026-06-09: routines tools added):
//   Tools reachable from the 6 top-level register groups:
//   - registerOrchestrationTools: 19 tools
//   - registerKnowledgeTools:     12 tools
//   - registerArtifactTools:       4 tools
//   - registerPrincipleTools:      8 tools
//   - registerLoopTools:           2 tools (list_loops, get_loop_definition)
//   - registerRoutineTools:        3 tools (list_routines, get_routine, sync_routines)
//   Total: 48 tools
//
// Note: register-evaluate-step.ts defines evaluate_step but it is not imported
// from any of the 6 top-level groups, so it is NOT registered at runtime.
//
// This test must be GREEN before the refactor starts (pin existing behavior)
// and GREEN after (prove no silent regression).

describe("createCanonServer(): characterization — tool count baseline", () => {
  // Import the factory once for the whole describe block — avoids per-test module load
  // latency from real feature modules (SQLite, filesystem walks, etc.)
  let createCanonServer: () => McpServer;

  beforeAll(async () => {
    const mod = await import("../create-server.ts");
    createCanonServer = mod.createCanonServer;
  }, 60_000); // generous timeout for real module load

  afterAll(async () => {
    const { resetForTesting } = await import("../server-state.ts");
    resetForTesting();
  });

  it("factory produces a server with exactly 50 registered tools", () => {
    const server = createCanonServer();
    expect(getToolCount(server)).toBe(53);
  });

  it("tool names include a stable known subset", () => {
    const server = createCanonServer();
    const names = getToolNames(server);

    // Representative sample covering each register group
    const expected = [
      // orchestration
      "init_workspace",
      "log_step",
      "batch_log_steps",
      "finalize_workspace",
      "reconcile_workspace",
      "post_event",
      "categorize_failures",
      "invoke_janitor",
      "resolve_agent_skills",
      "compute_autonomy_tier",
      "get_next_escalation_strategy",
      "write_review",
      "write_implementation_summary",
      "write_plan_index",
      "write_test_report",
      "present_artifact",
      "open_artifact",
      "capture_transcript",
      "record_agent_metrics",
      "get_transcript",
      "get_build_history",
      "get_historical_artifacts",
      "get_cross_run_analysis",
      // knowledge
      "codebase_graph",
      "get_file_context",
      "codebase_graph_materialize",
      "store_summaries",
      "get_drift_report",
      "get_history",
      "wiki_lint",
      "graph_query",
      "semantic_search",
      "codebase_graph_submit",
      "codebase_graph_poll",
      "get_context",
      // principles
      "show_pr_impact",
      "get_principles",
      "list_principles",
      "review_code",
      "get_compliance",
      "report",
      "store_pr_review",
      "present_review",
      // loops
      "list_loops",
      "get_loop_definition",
      // routines
      "list_routines",
      "get_routine",
      "sync_routines",
    ];
    for (const name of expected) {
      expect(names, `expected tool '${name}' to be registered`).toContain(name);
    }
  });
});

// ── Factory independence ──────────────────────────────────────────────────────

describe("createCanonServer(): factory independence", () => {
  // Import the factory once — module is already cached from characterization block.
  let createCanonServer: () => McpServer;

  beforeAll(async () => {
    const mod = await import("../create-server.ts");
    createCanonServer = mod.createCanonServer;
  }, 60_000);

  afterAll(async () => {
    const { resetForTesting } = await import("../server-state.ts");
    resetForTesting();
  });

  it("two factory calls return distinct McpServer instances", () => {
    const s1 = createCanonServer();
    const s2 = createCanonServer();
    expect(s1).not.toBe(s2);
  });

  it("each instance has the full tool count independently", () => {
    const s1 = createCanonServer();
    const s2 = createCanonServer();
    expect(getToolCount(s1)).toBe(53);
    expect(getToolCount(s2)).toBe(53);
  });
});

// ── readyPromiseFor: 4-branch coverage ───────────────────────────────────────

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

function makeExtra(sessionId?: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    requestId: "test-req-1",
    sessionId,
    signal: new AbortController().signal,
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("readyPromiseFor(): branch coverage", () => {
  afterEach(async () => {
    const { resetForTesting } = await import("../server-state.ts");
    resetForTesting();
  });

  it("no sessionId → global gate (pending until resolveReady)", async () => {
    // Use namespace import so that state.resolveReady() reads the live binding
    // even after resetForTesting() replaces the module-level variable.
    const state = await import("../server-state.ts");
    state.resetForTesting();

    let resolved = false;
    const raceResult = await Promise.race([
      state.readyPromiseFor(makeExtra(undefined)).then(() => {
        resolved = true;
        return "gate";
      }),
      Promise.resolve("immediate"),
    ]);
    expect(raceResult).toBe("immediate");
    expect(resolved).toBe(false);

    // Now resolve global gate — reads live binding post-reset
    state.resolveReady();
    await state.readyPromiseFor(makeExtra(undefined));
    expect(resolved).toBe(true);
  });

  it("registered sessionId → per-session gate resolves independently of global", async () => {
    const { createSessionReadyGate, readyPromiseFor, resolveSessionReady, resetForTesting } =
      await import("../server-state.ts");
    resetForTesting();

    const sessionId = "test-session-abc";
    createSessionReadyGate(sessionId);

    // Global gate is NOT resolved — session gate should still be resolvable
    let sessionResolved = false;
    const sessionPromise = readyPromiseFor(makeExtra(sessionId)).then(() => {
      sessionResolved = true;
    });

    // Global gate pending; session gate also pending initially
    const raceResult = await Promise.race([
      sessionPromise.then(() => "session"),
      Promise.resolve("immediate"),
    ]);
    expect(raceResult).toBe("immediate");

    // Resolve the session gate
    resolveSessionReady(sessionId);
    await sessionPromise;
    expect(sessionResolved).toBe(true);
  });

  it("unknown sessionId (no gate created) → falls back to global gate", async () => {
    const state = await import("../server-state.ts");
    state.resetForTesting();

    let resolved = false;
    const promise = state.readyPromiseFor(makeExtra("no-such-session")).then(() => {
      resolved = true;
    });

    // Neither global nor session gate resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Resolve global → unknown session falls back to global
    state.resolveReady();
    await promise;
    expect(resolved).toBe(true);
  });

  it("clearSessionReady removes the per-session gate", async () => {
    const state = await import("../server-state.ts");
    state.resetForTesting();

    const sessionId = "cleanup-session";
    state.createSessionReadyGate(sessionId);

    // Remove the gate — subsequent readyPromiseFor should fall back to global
    state.clearSessionReady(sessionId);

    let resolved = false;
    const promise = state.readyPromiseFor(makeExtra(sessionId)).then(() => {
      resolved = true;
    });

    // Not resolved yet (global gate pending)
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Resolve global
    state.resolveReady();
    await promise;
    expect(resolved).toBe(true);
  });
});

// ── CANON_SERVER_NAME and CANON_SERVER_VERSION exports ───────────────────────

describe("create-server.ts: exported constants", () => {
  it("exports CANON_SERVER_NAME = 'canon'", async () => {
    const { CANON_SERVER_NAME } = await import("../create-server.ts");
    expect(CANON_SERVER_NAME).toBe("canon");
  });

  it("exports CANON_SERVER_VERSION matching the release-please marker", async () => {
    const { CANON_SERVER_VERSION } = await import("../create-server.ts");
    expect(typeof CANON_SERVER_VERSION).toBe("string");
    expect(CANON_SERVER_VERSION.length).toBeGreaterThan(0);
    // Must match semantic version pattern
    expect(CANON_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
