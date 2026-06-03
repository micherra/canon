/**
 * Scope migration tests — HTTP Epic 1b
 *
 * For each of the five migrated tool boundaries, asserts:
 *   (a) A registered session resolves its own project dir
 *   (b) STDIO fallback (no sessionId / STDIO_SESSION_ID) resolves the global
 *
 * Uses the makeExtra(sessionId?) helper pattern from server-state.test.ts.
 * Mocks all underlying service functions so the tests isolate scope resolution.
 *
 * Architecture note: to avoid blocking on readyPromise in gatedWrapHandler,
 * we mock gatedWrapHandler as an immediate passthrough. This is safe because:
 * - The ready-gate behavior is tested in server-state.test.ts
 * - These tests focus exclusively on scope resolution (which dir is passed)
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeExtra(sessionId?: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestId: "test-req-1",
    sessionId,
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

/**
 * Extract the handler registered for a given tool name.
 * server.registerTool calls are of the form (name, meta, handler).
 */
function getRegisteredHandler(
  registerToolCalls: unknown[][],
  toolName: string,
): (
  input: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<unknown> {
  const call = registerToolCalls.find((c) => c[0] === toolName);
  if (!call)
    throw new Error(
      `Tool "${toolName}" was not registered. Available: ${registerToolCalls.map((c) => c[0]).join(", ")}`,
    );
  return call[2] as (
    input: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<unknown>;
}

// ── Global server-state mock ──────────────────────────────────────────────────
// Mock gatedWrapHandler as an immediate passthrough (no ready-gate) and
// re-export the real resolveScope/registerConnectionScope so scope resolution
// is exercised faithfully.

vi.mock("@app/server-state.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server-state.ts")>();
  return {
    ...real,
    // Immediate passthrough — no ready-gate; tests focus on scope resolution
    gatedWrapHandler:
      <T>(
        handler: (
          input: T,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => Promise<unknown>,
      ) =>
      async (input: T, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        return handler(input, extra);
      },
    server: { registerTool: vi.fn() },
    registerToolWithUi: vi.fn(),
  };
});

// ── Service mocks ─────────────────────────────────────────────────────────────

vi.mock("@features/orchestration/tools/init-workspace.ts", () => ({
  initWorkspaceFlow: vi.fn().mockResolvedValue({ ok: true, workspace: "/fake/ws" }),
}));

vi.mock("@features/orchestration/tools/resolve-agent-skills.ts", () => ({
  resolveAgentSkills: vi.fn().mockResolvedValue({ ok: true, preload_prompt: "" }),
}));

vi.mock("@features/orchestration/tools/write-review.ts", () => ({
  writeReview: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/orchestration/tools/write-implementation-summary.ts", () => ({
  writeImplementationSummary: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/orchestration/tools/write-plan-index.ts", () => ({
  writePlanIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/orchestration/tools/write-test-report.ts", () => ({
  writeTestReport: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/orchestration/services/review-confidence-adapter.ts", () => ({
  computeViolationConfidence: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@features/diagnostics/services/prediction-tracker.ts", () => ({
  reconcilePredictions: vi.fn(),
  recordPrediction: vi.fn(),
}));

vi.mock("@features/pr-review/tools/show-pr-impact.ts", () => ({
  showPrImpact: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/pr-review/tools/review-code.ts", () => ({
  reviewCode: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/pr-review/tools/store-pr-review.ts", () => ({
  storePrReview: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/pr-review/tools/present-review.ts", () => ({
  presentReview: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/principles/tools/get-compliance.ts", () => ({
  getCompliance: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/principles/tools/get-principles.ts", () => ({
  getPrinciples: vi.fn().mockResolvedValue({ ok: true }),
  getPrinciplesBatch: vi.fn().mockResolvedValue({
    graph_context_by_file: {},
    principles: [],
    total_in_canon: 0,
    total_matched: 0,
  }),
}));

vi.mock("@features/principles/tools/list-principles.ts", () => ({
  listPrinciples: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@features/orchestration/tools/report.ts", () => ({
  report: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@platform/storage/drift/drift-db-cache.ts", () => ({
  getDriftDb: vi.fn().mockReturnValue({
    getAreaMemory: vi.fn().mockReturnValue(undefined),
    getSignals: vi.fn().mockReturnValue(undefined),
  }),
}));

vi.mock("@features/knowledge-graph/tools/graph-query.ts", () => ({
  graphQuery: vi
    .fn()
    .mockReturnValue({ ok: true, count: 0, query_type: "blast_radius", results: [] }),
}));

vi.mock("@features/file-context/tools/get-file-context.ts", () => ({
  getFileContext: vi.fn().mockResolvedValue({
    content: "",
    exports: [],
    file_path: "src/foo.ts",
    imported_by: [],
    imported_by_layer: {},
    imports: [],
    imports_by_layer: {},
    last_verdict: null,
    layer: "app",
    layer_stack: [],
    ok: true as const,
    project_max_impact: 0,
    role: "internal",
    shape: { description: "Leaf.", label: "Leaf" },
    summary: null,
    violation_count: 0,
    violations: [],
  }),
}));

vi.mock("@features/diagnostics/tools/get-drift-report.ts", () => ({
  getDriftReport: vi.fn().mockResolvedValue({ formatted: "", pr_reviews: [], report: {} }),
}));

vi.mock("@features/diagnostics/tools/store-summaries.ts", () => ({ storeSummaries: vi.fn() }));
vi.mock("@features/diagnostics/tools/wiki-lint.ts", () => ({ wikiLint: vi.fn() }));
vi.mock("@features/diagnostics/tools/get-history.ts", () => ({ getHistory: vi.fn() }));

vi.mock("@features/knowledge-graph/tools/codebase-graph.ts", () => ({
  codebaseGraph: vi.fn(),
  compactGraph: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/codebase-graph-materialize.ts", () => ({
  codebaseGraphMaterialize: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/codebase-graph-poll.ts", () => ({
  codebaseGraphPoll: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/codebase-graph-submit.ts", () => ({
  codebaseGraphSubmit: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/semantic-search.ts", () => ({
  semanticSearch: vi.fn(),
}));

vi.mock("@shared/lib/progressive-disclosure.ts", () => ({
  applyDisclosure: vi.fn().mockResolvedValue({ truncated: false }),
}));

vi.mock("@features/diagnostics/services/signal-compiler.ts", () => ({
  compileSignals: vi.fn().mockReturnValue([]),
}));

vi.mock("@features/diagnostics/services/prediction-accuracy.ts", () => ({
  buildAccuracySummary: vi.fn().mockReturnValue(undefined),
  computeAccuracy: vi.fn().mockReturnValue(new Map()),
}));

// ── Import mocked modules ─────────────────────────────────────────────────────

import * as mockedAppState from "@app/server-state.ts";

import { initWorkspaceFlow } from "@features/orchestration/tools/init-workspace.ts";
import { report } from "@features/orchestration/tools/report.ts";
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { storePrReview } from "@features/pr-review/tools/store-pr-review.ts";
import { getCompliance } from "@features/principles/tools/get-compliance.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { registerAgentTeamsTools } from "../register-agent-teams.ts";
import { registerArtifactTools } from "../register-artifacts.ts";
import { registerInitWorkspaceTool } from "../register-init-workspace.ts";
import { handleGetContext } from "../register-knowledge.ts";
import { registerPrincipleTools } from "../register-principles.ts";
import { registerConnectionScope, resetForTesting, STDIO_SESSION_ID } from "../server-state.ts";

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetForTesting();

  // Re-register all tools on the fresh mock server
  const mockServer = mockedAppState.server as unknown as { registerTool: ReturnType<typeof vi.fn> };
  mockServer.registerTool.mockClear();

  registerInitWorkspaceTool();
  registerArtifactTools();
  registerPrincipleTools();
  registerAgentTeamsTools();
});

afterEach(() => {
  resetForTesting();
});

function getRegisterToolCalls(): unknown[][] {
  const mockServer = mockedAppState.server as unknown as { registerTool: ReturnType<typeof vi.fn> };
  return mockServer.registerTool.mock.calls as unknown[][];
}

// ── Tests: register-init-workspace.ts ────────────────────────────────────────

describe("scope migration: register-init-workspace.ts — init_workspace", () => {
  it("(a) per-session: resolves the registered session dir", async () => {
    registerConnectionScope("session-A", "/project/A");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "init_workspace");
    await handler(
      { base_commit: "abc", branch: "main", flow_name: "test", task: "test-task", tier: "small" },
      makeExtra("session-A"),
    );

    expect(vi.mocked(initWorkspaceFlow)).toHaveBeenCalledWith(
      expect.anything(),
      "/project/A",
      expect.anything(),
    );
  });

  it("(b) STDIO fallback: resolves global dir when no sessionId", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/project");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "init_workspace");
    await handler(
      { base_commit: "abc", branch: "main", flow_name: "test", task: "test-task", tier: "small" },
      makeExtra(undefined),
    );

    expect(vi.mocked(initWorkspaceFlow)).toHaveBeenCalledWith(
      expect.anything(),
      "/global/project",
      expect.anything(),
    );
  });

  it("(b) STDIO sentinel: resolves global dir via STDIO_SESSION_ID", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/stdio/project");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "init_workspace");
    await handler(
      { base_commit: "abc", branch: "main", flow_name: "test", task: "test-task", tier: "small" },
      makeExtra(STDIO_SESSION_ID),
    );

    expect(vi.mocked(initWorkspaceFlow)).toHaveBeenCalledWith(
      expect.anything(),
      "/stdio/project",
      expect.anything(),
    );
  });
});

// ── Tests: register-artifacts.ts — write_review ──────────────────────────────

describe("scope migration: register-artifacts.ts — write_review", () => {
  const reviewInput = {
    files: [],
    honored: [],
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 0, total: 0 },
    },
    slug: "test",
    verdict: "approved" as const,
    violations: [],
    workspace: "/ws",
  };

  it("(a) per-session: resolves the registered session dir for getDriftDb", async () => {
    registerConnectionScope("session-B", "/project/B");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "write_review");
    await handler(reviewInput, makeExtra("session-B"));

    expect(vi.mocked(getDriftDb)).toHaveBeenCalledWith("/project/B");
  });

  it("(b) STDIO fallback: resolves global dir for getDriftDb when no sessionId", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/artifacts");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "write_review");
    await handler(reviewInput, makeExtra(undefined));

    expect(vi.mocked(getDriftDb)).toHaveBeenCalledWith("/global/artifacts");
  });
});

// ── Tests: register-principles.ts ────────────────────────────────────────────

describe("scope migration: register-principles.ts — get_compliance, report, store_pr_review", () => {
  it("(a) per-session: get_compliance resolves the registered session dir", async () => {
    registerConnectionScope("session-C", "/project/C");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "get_compliance");
    await handler({ principle_id: "simplicity-first" }, makeExtra("session-C"));

    expect(vi.mocked(getCompliance)).toHaveBeenCalledWith(
      expect.anything(),
      "/project/C",
      expect.anything(),
    );
  });

  it("(b) STDIO fallback: get_compliance resolves global dir when no sessionId", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/principles");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "get_compliance");
    await handler({ principle_id: "simplicity-first" }, makeExtra(undefined));

    expect(vi.mocked(getCompliance)).toHaveBeenCalledWith(
      expect.anything(),
      "/global/principles",
      expect.anything(),
    );
  });

  it("(a) per-session: report resolves the registered session dir", async () => {
    registerConnectionScope("session-D", "/project/D");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "report");
    await handler(
      { type: "pattern", description: "test", principle_id: "test" },
      makeExtra("session-D"),
    );

    // Check the dir positionally (signals can be undefined from getDriftDb mock)
    expect(vi.mocked(report)).toHaveBeenCalled();
    const callArgs = vi.mocked(report).mock.calls[0];
    expect(callArgs[1]).toBe("/project/D");
  });

  it("(a) per-session: store_pr_review resolves the registered session dir", async () => {
    registerConnectionScope("session-E", "/project/E");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "store_pr_review");
    await handler(
      {
        files: ["src/foo.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      makeExtra("session-E"),
    );

    expect(vi.mocked(storePrReview)).toHaveBeenCalledWith(expect.anything(), "/project/E");
  });
});

// ── Tests: register-agent-teams.ts — resolve_agent_skills ────────────────────

describe("scope migration: register-agent-teams.ts — resolve_agent_skills", () => {
  it("(a) per-session: resolves the registered session dir via widened wrapHandler", async () => {
    registerConnectionScope("session-F", "/project/F");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "resolve_agent_skills");
    await handler({ agent_name: "engineer" }, makeExtra("session-F"));

    expect(vi.mocked(resolveAgentSkills)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(), // pluginDir
      "/project/F",
      expect.anything(),
    );
  });

  it("(b) STDIO fallback: resolves global dir when no sessionId", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/teams");

    const handler = getRegisteredHandler(getRegisterToolCalls(), "resolve_agent_skills");
    await handler({ agent_name: "engineer" }, makeExtra(undefined));

    expect(vi.mocked(resolveAgentSkills)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(), // pluginDir
      "/global/teams",
      expect.anything(),
    );
  });
});

// ── Tests: register-knowledge.ts — handleGetContext ──────────────────────────

describe("scope migration: register-knowledge.ts — handleGetContext", () => {
  it("(a) per-session: handleGetContext resolves the registered session dir for signals", async () => {
    registerConnectionScope("session-G", "/project/G");
    registerConnectionScope(STDIO_SESSION_ID, "/global/knowledge");

    await handleGetContext(
      { file_paths: ["src/foo.ts"], include: ["signals"] },
      makeExtra("session-G"),
    );

    expect(vi.mocked(getDriftDb)).toHaveBeenCalledWith("/project/G");
  });

  it("(b) STDIO fallback: handleGetContext with no extra resolves the global dir", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/global/knowledge");

    await handleGetContext(
      { file_paths: ["src/bar.ts"], include: ["signals"] },
      // No extra — optional param, falls back to global
    );

    expect(vi.mocked(getDriftDb)).toHaveBeenCalledWith("/global/knowledge");
  });

  it("(b) STDIO sentinel: handleGetContext with STDIO session resolves global dir", async () => {
    registerConnectionScope(STDIO_SESSION_ID, "/stdio/knowledge");

    await handleGetContext(
      { file_paths: ["src/baz.ts"], include: ["signals"] },
      makeExtra(STDIO_SESSION_ID),
    );

    expect(vi.mocked(getDriftDb)).toHaveBeenCalledWith("/stdio/knowledge");
  });
});
