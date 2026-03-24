/**
 * bridge.ts unit tests
 *
 * Tests that bridge.request() maps message types to correct callServerTool() calls,
 * notifyNodeSelected() calls update_dashboard_state, and openFile() is a no-op.
 *
 * The ext-apps App class is mocked entirely — no real iframe/postMessage connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the ext-apps module before importing bridge
// ---------------------------------------------------------------------------

// Shared mock function references — reset in beforeEach
const mockCallServerTool = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockGetHostContext = vi.fn().mockReturnValue(null);

// Use a class so `new App(...)` works correctly
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

// Import bridge after mocking — must be dynamic to pick up the mock
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

describe("bridge.init()", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls connect()", () => {
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("calls getHostContext() to apply initial theme", () => {
    expect(mockGetHostContext).toHaveBeenCalled();
  });
});

describe("bridge.request() — tool call mapping", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("webviewReady returns empty object without calling tool", async () => {
    const result = await bridge.request("webviewReady");
    expect(result).toEqual({});
    expect(mockCallServerTool).not.toHaveBeenCalled();
  });

  it("getBranch calls get_branch with no arguments", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ branch: "main" }));
    const result = await bridge.request("getBranch");
    expect(mockCallServerTool).toHaveBeenCalledWith({ name: "get_branch", arguments: {} });
    expect(result).toEqual({ branch: "main" });
  });

  it("getFile calls get_file_content with file_path", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ content: "export const x = 1;" }));
    const result = await bridge.request("getFile", { path: "src/index.ts" });
    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_file_content",
      arguments: { file_path: "src/index.ts" },
    });
    expect(result).toEqual({ content: "export const x = 1;" });
  });

  it("getSummary calls get_summary with file_id", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ summary: "Entry point", source: "summaries" }));
    const result = await bridge.request("getSummary", { fileId: "src/index.ts" });
    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_summary",
      arguments: { file_id: "src/index.ts" },
    });
    expect(result).toEqual({ summary: "Entry point", source: "summaries" });
  });

  it("getComplianceTrend calls get_compliance_trend with principle_id", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ trend: [] }));
    const result = await bridge.request("getComplianceTrend", { principleId: "simplicity-first" });
    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_compliance_trend",
      arguments: { principle_id: "simplicity-first" },
    });
    expect(result).toEqual({ trend: [] });
  });

  it("getPrReviews calls get_pr_reviews with no arguments", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ reviews: [] }));
    const result = await bridge.request("getPrReviews");
    expect(mockCallServerTool).toHaveBeenCalledWith({ name: "get_pr_reviews", arguments: {} });
    expect(result).toEqual({ reviews: [] });
  });

  it("refreshGraph calls codebase_graph with no arguments", async () => {
    const graphData = { nodes: [], edges: [] };
    mockCallServerTool.mockResolvedValue(makeToolResult(graphData));
    const result = await bridge.request("refreshGraph");
    expect(mockCallServerTool).toHaveBeenCalledWith({ name: "codebase_graph", arguments: {} });
    expect(result).toEqual(graphData);
  });

  it("unknown type returns empty object with console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await bridge.request("unknownType");
    expect(result).toEqual({});
    expect(mockCallServerTool).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown bridge request type"));
    warnSpy.mockRestore();
  });
});

describe("bridge.notifyNodeSelected()", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls update_dashboard_state with selected node", async () => {
    mockCallServerTool.mockResolvedValue({ content: [] });
    const node = { id: "src/index.ts", layer: "api", summary: "Entry", violation_count: 2 };
    await bridge.notifyNodeSelected(node);
    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "update_dashboard_state",
      arguments: { selectedNode: node },
    });
  });

  it("calls update_dashboard_state with null to clear selection", async () => {
    mockCallServerTool.mockResolvedValue({ content: [] });
    await bridge.notifyNodeSelected(null);
    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "update_dashboard_state",
      arguments: { selectedNode: null },
    });
  });

  it("silently catches errors from callServerTool", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCallServerTool.mockRejectedValue(new Error("Tool failed"));
    // Should not throw
    await expect(bridge.notifyNodeSelected(null)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("bridge.openFile()", () => {
  it("is a no-op — does not throw and does not call any tool", () => {
    vi.clearAllMocks();
    expect(() => bridge.openFile("src/index.ts")).not.toThrow();
    expect(mockCallServerTool).not.toHaveBeenCalled();
  });
});
