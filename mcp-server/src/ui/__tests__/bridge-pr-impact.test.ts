/**
 * bridge-pr-impact.test.ts
 *
 * Tests that bridge.callTool() correctly routes to MCP server tools.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  set onhostcontextchanged(_cb: unknown) {
    /* no-op */
  }
  set onerror(_cb: unknown) {
    /* no-op */
  }
}

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: MockApp,
  applyDocumentTheme: vi.fn(),
  applyHostFonts: vi.fn(),
  applyHostStyleVariables: vi.fn(),
}));

// Import bridge after mocking
const { bridge } = await import("../stores/bridge.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolResult(json: unknown) {
  return {
    content: [{ text: JSON.stringify(json), type: "text" as const }],
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
      has_review: false,
      hotspots: [],
      prep: {
        blast_radius: [],
        diff_command: "git diff main",
        files: [],
        impact_files: [],
        incremental: false,
        layers: [],
        narrative: "No changes found.",
        net_new_files: 0,
        total_files: 0,
        total_violations: 0,
      },
      status: "ok",
      subgraph: { edges: [], layers: [], nodes: [] },
    };
    mockCallServerTool.mockResolvedValue(makeToolResult(payload));

    const result = await bridge.callTool("show_pr_impact");

    expect(mockCallServerTool).toHaveBeenCalledWith({
      arguments: {},
      name: "show_pr_impact",
    });
    expect(result).toEqual(payload);
  });

  it("returns parsed JSON with prep field when no stored review", async () => {
    // status is always "ok" in UnifiedPrOutput — has_review: false signals no stored review
    const payload = {
      empty_state: "No stored review — run the Canon reviewer first",
      has_review: false,
      hotspots: [],
      prep: {
        blast_radius: [],
        diff_command: "git diff main",
        files: [{ layer: "tools", path: "src/a.ts", status: "modified" }],
        impact_files: [],
        incremental: false,
        layers: [{ file_count: 1, name: "tools" }],
        narrative: "1 file changed.",
        net_new_files: 0,
        total_files: 1,
        total_violations: 0,
      },
      status: "ok",
      subgraph: { edges: [], layers: [], nodes: [] },
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
      arguments: { principle_id: "deep-modules" },
      name: "get_compliance",
    });
  });
});
