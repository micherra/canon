/**
 * bridge-pr-impact.test.ts
 *
 * Tests that the three new bridge tool mappings (getPrImpact, graphQuery, getDecisions)
 * correctly route to their corresponding MCP tools with the right argument shapes.
 *
 * Follows the exact mock pattern of bridge.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the ext-apps module before importing bridge
// ---------------------------------------------------------------------------

const mockCallServerTool = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockGetHostContext = vi.fn().mockReturnValue(null);

class MockApp {
  constructor(
    public _info: unknown,
    public _caps: unknown,
    public _opts: unknown,
  ) {}
  connect = mockConnect;
  getHostContext = mockGetHostContext;
  callServerTool = mockCallServerTool;
  set onhostcontextchanged(_cb: unknown) { /* no-op */ }
  set onerror(_cb: unknown) { /* no-op */ }
}

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: MockApp,
  applyDocumentTheme: vi.fn(),
  applyHostStyleVariables: vi.fn(),
  applyHostFonts: vi.fn(),
}));

// Import bridge after mocking
const { bridge } = await import("../stores/bridge.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolResult(json: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(json) }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bridge.request() — getPrImpact", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls show_pr_impact with no arguments", async () => {
    const payload = {
      status: "ok",
      hotspots: [],
      subgraph: { nodes: [], edges: [], layers: [] },
      decisions: [],
    };
    mockCallServerTool.mockResolvedValue(makeToolResult(payload));

    const result = await bridge.request("getPrImpact");

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "show_pr_impact",
      arguments: {},
    });
    expect(result).toEqual(payload);
  });

  it("returns parsed JSON from show_pr_impact", async () => {
    const payload = {
      status: "no_review",
      hotspots: [],
      subgraph: { nodes: [], edges: [], layers: [] },
      decisions: [],
      empty_state: "No PR review found — run the reviewer first",
    };
    mockCallServerTool.mockResolvedValue(makeToolResult(payload));

    const result = await bridge.request("getPrImpact");
    expect(result.status).toBe("no_review");
    expect(result.empty_state).toBe("No PR review found — run the reviewer first");
  });
});

describe("bridge.request() — graphQuery", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls graph_query with queryType mapped to query_type", async () => {
    const queryResult = { callers: ["src/a.ts", "src/b.ts"] };
    mockCallServerTool.mockResolvedValue(makeToolResult(queryResult));

    const result = await bridge.request("graphQuery", {
      queryType: "callers",
      target: "src/index.ts",
    });

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "graph_query",
      arguments: {
        query_type: "callers",
        target: "src/index.ts",
        options: undefined,
      },
    });
    expect(result).toEqual(queryResult);
  });

  it("passes options when provided", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ blast_radius: [] }));

    await bridge.request("graphQuery", {
      queryType: "blast_radius",
      target: "src/utils/config.ts",
      options: { max_depth: 3 },
    });

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "graph_query",
      arguments: {
        query_type: "blast_radius",
        target: "src/utils/config.ts",
        options: { max_depth: 3 },
      },
    });
  });

  it("passes undefined target when not provided", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ dead_code: [] }));

    await bridge.request("graphQuery", { queryType: "dead_code" });

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "graph_query",
      arguments: {
        query_type: "dead_code",
        target: undefined,
        options: undefined,
      },
    });
  });
});

describe("bridge.request() — getDecisions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls get_decisions with no arguments when payload is empty", async () => {
    const decisions = [{ principle_id: "functions-do-one-thing", justification: "justified" }];
    mockCallServerTool.mockResolvedValue(makeToolResult(decisions));

    const result = await bridge.request("getDecisions");

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_decisions",
      arguments: {
        principle_id: undefined,
        limit: undefined,
      },
    });
    expect(result).toEqual(decisions);
  });

  it("passes principleId mapped to principle_id", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult([]));

    await bridge.request("getDecisions", { principleId: "information-hiding" });

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_decisions",
      arguments: {
        principle_id: "information-hiding",
        limit: undefined,
      },
    });
  });

  it("passes limit when provided", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult([]));

    await bridge.request("getDecisions", { principleId: "deep-modules", limit: 5 });

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_decisions",
      arguments: {
        principle_id: "deep-modules",
        limit: 5,
      },
    });
  });
});
