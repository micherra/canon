/**
 * bridge-pr-impact.test.ts
 *
 * Tests that bridge.callTool() correctly routes to MCP server tools.
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

describe("bridge.callTool()", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls show_pr_impact with no arguments", async () => {
    // UnifiedPrOutput: status always "ok", prep always present, has_review boolean
    const payload = {
      status: "ok",
      prep: {
        files: [],
        impact_files: [],
        layers: [],
        total_files: 0,
        total_violations: 0,
        net_new_files: 0,
        incremental: false,
        diff_command: "git diff main",
        narrative: "No changes found.",
        blast_radius: [],
      },
      hotspots: [],
      subgraph: { nodes: [], edges: [], layers: [] },
      has_review: false,
    };
    mockCallServerTool.mockResolvedValue(makeToolResult(payload));

    const result = await bridge.callTool("show_pr_impact");

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "show_pr_impact",
      arguments: {},
    });
    expect(result).toEqual(payload);
  });

  it("returns parsed JSON with prep field when no stored review", async () => {
    // status is always "ok" in UnifiedPrOutput — has_review: false signals no stored review
    const payload = {
      status: "ok",
      prep: {
        files: [{ path: "src/a.ts", layer: "tools", status: "modified" }],
        impact_files: [],
        layers: [{ name: "tools", file_count: 1 }],
        total_files: 1,
        total_violations: 0,
        net_new_files: 0,
        incremental: false,
        diff_command: "git diff main",
        narrative: "1 file changed.",
        blast_radius: [],
      },
      hotspots: [],
      subgraph: { nodes: [], edges: [], layers: [] },
      has_review: false,
      empty_state: "No stored review — run the Canon reviewer first",
    };
    mockCallServerTool.mockResolvedValue(makeToolResult(payload));

    const result = await bridge.callTool("show_pr_impact");
    expect(result.status).toBe("ok");
    expect(result.has_review).toBe(false);
    expect(result.prep.total_files).toBe(1);
    expect(result.empty_state).toBe("No stored review — run the Canon reviewer first");
  });

  it("passes arguments to the tool call", async () => {
    mockCallServerTool.mockResolvedValue(makeToolResult({ found: true }));

    await bridge.callTool("get_compliance", { principle_id: "deep-modules" });

    expect(mockCallServerTool).toHaveBeenCalledWith({
      name: "get_compliance",
      arguments: { principle_id: "deep-modules" },
    });
  });

});
