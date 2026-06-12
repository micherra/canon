/**
 * decisions-ledger — tests for logDecision + getDecisions handlers.
 *
 * Tests cover:
 *  1. Happy path: logDecision appends; getDecisions returns the record
 *  2. CQS / ordering: two logDecision calls → getDecisions returns both in order
 *  3. Authoritative-error path: appendEvent throws → handler returns ToolResult error
 *  4. Validation: empty workspace / relative path / empty summary → INVALID_INPUT
 *  5. Render: empty records → "_No decisions logged yet._"
 *  6. Render: pipe char in summary is escaped
 *  7. Payload reader: event with only summary (no rationale/outcome) maps cleanly
 *
 * Mock strategy:
 *  - Mock getExecutionStore to return a real in-memory ExecutionStore
 *    (same pattern as compute-autonomy-tier.test.ts)
 */

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (before imports) ----
// vi.mock is hoisted before variable declarations. Must use inline vi.fn().

vi.mock("@domains/workspaces/execution-store-cache.ts", () => {
  const stores = new Map<string, ExecutionStore>();
  return {
    clearStoreCache: vi.fn(() => stores.clear()),
    getExecutionStore: vi.fn((workspace: string) => {
      const existing = stores.get(workspace);
      if (existing) return existing;
      const db = initExecutionDb(":memory:");
      const store = new ExecutionStore(db);
      stores.set(workspace, store);
      return store;
    }),
  };
});

import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";

import { getDecisions, logDecision, renderDecisionsTable } from "../decisions-ledger.ts";

const MOCK_WORKSPACE = "/mock/.canon/workspaces/test-workspace";

beforeEach(() => {
  vi.mocked(clearStoreCache).mockClear();
});

afterEach(() => {
  vi.mocked(clearStoreCache)();
});

describe("logDecision", () => {
  it("happy path: appends a decision record and returns logged:true", async () => {
    const result = await logDecision({
      decision_type: "hitl_gate",
      gate: "plan_approval",
      outcome: "approved",
      rationale: "User reviewed and approved",
      summary: "Plan approved by user",
      workspace: MOCK_WORKSPACE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.logged).toBe(true);
    expect(result.decision_type).toBe("hitl_gate");
  });

  it("persists to execution store so getDecisions retrieves it", async () => {
    await logDecision({
      decision_type: "scope_cut",
      outcome: "descoped",
      summary: "AC#3 descoped",
      workspace: MOCK_WORKSPACE,
    });

    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.summary).toBe("AC#3 descoped");
    expect(result.decisions[0]?.decision_type).toBe("scope_cut");
    expect(result.decisions[0]?.outcome).toBe("descoped");
  });

  it("validation: empty workspace → INVALID_INPUT", async () => {
    const result = await logDecision({
      decision_type: "other",
      summary: "test",
      workspace: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("validation: relative workspace → INVALID_INPUT", async () => {
    const result = await logDecision({
      decision_type: "other",
      summary: "test",
      workspace: "relative/path",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("validation: empty summary → INVALID_INPUT", async () => {
    const result = await logDecision({
      decision_type: "other",
      summary: "",
      workspace: MOCK_WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("validation: whitespace-only summary → INVALID_INPUT", async () => {
    const result = await logDecision({
      decision_type: "other",
      summary: "   ",
      workspace: MOCK_WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("WORKSPACE_NOT_FOUND when getExecutionStore throws", async () => {
    vi.mocked(getExecutionStore).mockImplementationOnce(() => {
      throw new Error("workspace not found");
    });
    const result = await logDecision({
      decision_type: "other",
      summary: "test",
      workspace: MOCK_WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("authoritative-error path: appendEvent throws → propagates (not silently swallowed)", async () => {
    // The authoritative write does NOT wrap appendEvent in a fail-open catch.
    // When appendEvent throws, wrapHandler surfaces UNEXPECTED to the orchestrator.
    // In direct handler calls (not via wrapHandler), the throw propagates — this
    // is the correct behaviour: the orchestrator MUST know the write failed.
    const mockStore = {
      appendEvent: vi.fn(() => {
        throw new Error("SQLite BUSY");
      }),
      getEventsByType: vi.fn(() => []),
    };
    vi.mocked(getExecutionStore).mockReturnValueOnce(mockStore as unknown as ExecutionStore);

    // Direct handler call: the throw propagates (wrapHandler would catch it as UNEXPECTED)
    await expect(
      logDecision({
        decision_type: "hitl_gate",
        summary: "Gate outcome",
        workspace: MOCK_WORKSPACE,
      }),
    ).rejects.toThrow("SQLite BUSY");
  });
});

describe("getDecisions", () => {
  it("returns empty array and rendered placeholder for empty store", async () => {
    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.decisions).toHaveLength(0);
    expect(result.rendered).toContain("No decisions logged yet");
  });

  it("CQS / ordering: two logDecision calls return both in insert order", async () => {
    await logDecision({
      decision_type: "hitl_gate",
      summary: "First decision",
      workspace: MOCK_WORKSPACE,
    });
    await logDecision({
      decision_type: "scope_cut",
      summary: "Second decision",
      workspace: MOCK_WORKSPACE,
    });

    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]?.summary).toBe("First decision");
    expect(result.decisions[1]?.summary).toBe("Second decision");
  });

  it("returns all fields: id, timestamp, decision_type, summary, rationale, outcome, gate, refs", async () => {
    await logDecision({
      decision_type: "tier_override",
      gate: "plan_approval",
      outcome: "overridden",
      rationale: "User requested supervised mode",
      refs: ["DESIGN.md", "AC#1"],
      summary: "Tier forced to supervised",
      workspace: MOCK_WORKSPACE,
    });

    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const record = result.decisions[0];
    expect(record).toBeDefined();
    expect(record?.id).toBeGreaterThan(0);
    expect(record?.timestamp).toBeTruthy();
    expect(record?.decision_type).toBe("tier_override");
    expect(record?.summary).toBe("Tier forced to supervised");
    expect(record?.rationale).toBe("User requested supervised mode");
    expect(record?.outcome).toBe("overridden");
    expect(record?.gate).toBe("plan_approval");
    expect(record?.refs).toEqual(["DESIGN.md", "AC#1"]);
  });

  it("payload reader: event with only summary (no rationale/outcome) maps cleanly", async () => {
    // Inject a raw event directly into the store to simulate a minimal payload
    const store = getExecutionStore(MOCK_WORKSPACE);
    store.appendEvent("orchestrator_decision", {
      decision_type: "other",
      summary: "Minimal decision",
      timestamp: new Date().toISOString(),
    });

    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.decisions).toHaveLength(1);
    const record = result.decisions[0];
    expect(record?.summary).toBe("Minimal decision");
    expect(record?.rationale).toBeUndefined();
    expect(record?.outcome).toBeUndefined();
    expect(record?.gate).toBeUndefined();
    expect(record?.refs).toBeUndefined();
  });

  it("validation: relative workspace → INVALID_INPUT", async () => {
    const result = await getDecisions({ workspace: "relative/path" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("WORKSPACE_NOT_FOUND when getExecutionStore throws", async () => {
    vi.mocked(getExecutionStore).mockImplementationOnce(() => {
      throw new Error("workspace not found");
    });
    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("rendered includes summary content in table", async () => {
    await logDecision({
      decision_type: "hitl_gate",
      summary: "Plan approved by user",
      workspace: MOCK_WORKSPACE,
    });
    const result = await getDecisions({ workspace: MOCK_WORKSPACE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.rendered).toContain("Plan approved by user");
  });
});

describe("renderDecisionsTable", () => {
  it("returns placeholder for empty input", () => {
    const rendered = renderDecisionsTable([]);
    expect(rendered).toContain("No decisions logged yet");
  });

  it("escapes pipe characters in summary", () => {
    const rendered = renderDecisionsTable([
      {
        decision_type: "other",
        id: 1,
        summary: "Decision with | pipe",
        timestamp: "2026-06-12T00:00:00.000Z",
      },
    ]);
    expect(rendered).not.toContain("Decision with | pipe");
    expect(rendered).toContain("Decision with \\| pipe");
  });

  it("includes header row", () => {
    const rendered = renderDecisionsTable([
      {
        decision_type: "hitl_gate",
        id: 1,
        summary: "test",
        timestamp: "2026-06-12T00:00:00.000Z",
      },
    ]);
    expect(rendered).toContain("#");
    expect(rendered).toContain("Type");
    expect(rendered).toContain("Summary");
  });

  it("truncates long rationale to ~80 chars", () => {
    const longRationale = "x".repeat(120);
    const rendered = renderDecisionsTable([
      {
        decision_type: "other",
        id: 1,
        rationale: longRationale,
        summary: "test",
        timestamp: "2026-06-12T00:00:00.000Z",
      },
    ]);
    // Should not contain the full 120-char string
    expect(rendered).not.toContain(longRationale);
    // Should contain a truncated version ending with ...
    expect(rendered).toContain("...");
  });
});
