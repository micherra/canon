/**
 * bridge-pr-impact.test.ts
 *
 * Tests that bridge.loadData() correctly returns the tool result pushed via
 * ontoolresult, covering the MCP App transport path.
 *
 * Note: bridge.callTool() was removed when bridge was refactored to the
 * BridgeAdapter factory pattern (html-types-and-bridge task). Views that
 * previously called callTool() now use bridge.sendMessage() instead.
 * See PrReview.svelte for the canonical pattern.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOntoolresult: ((params: unknown) => void) | null = null;
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockGetHostContext = vi.fn().mockReturnValue(null);
const mockSendMessage = vi.fn().mockResolvedValue(undefined);

class MockApp {
  constructor(
    public _info: unknown,
    public _caps: unknown,
    public _opts: unknown,
  ) {}
  connect = mockConnect;
  getHostContext = mockGetHostContext;
  sendMessage = mockSendMessage;
  set onhostcontextchanged(_cb: unknown) {
    /* no-op */
  }
  set ontoolresult(cb: (params: unknown) => void) {
    mockOntoolresult = cb;
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

function makeToolResult(json: unknown) {
  return {
    content: [{ text: JSON.stringify(json), type: "text" as const }],
    isError: false,
  };
}

describe("bridge.loadData() — MCP App transport", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockOntoolresult = null;
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("returns the tool result pushed via ontoolresult", async () => {
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
    };

    // Trigger the tool result after loadData is called
    const loadPromise = bridge.loadData();
    mockOntoolresult?.(makeToolResult(payload));

    const result = await loadPromise;
    expect(result).toEqual(payload);
  });

  it("buffers early tool result when loadData is called after ontoolresult", async () => {
    const payload = { early: true, value: 42 };

    // Push the result BEFORE calling loadData
    mockOntoolresult?.(makeToolResult(payload));

    // loadData should return the buffered result immediately
    const result = await bridge.loadData();
    expect(result).toEqual(payload);
  });

  it("returns the nested prep field correctly", async () => {
    const payload = {
      has_review: false,
      prep: {
        files: [
          { layer: "tools", path: "src/a.ts", status: "modified" },
          { layer: "tools", path: "src/b.ts", status: "added" },
          { layer: "ui", path: "src/ui/c.svelte", status: "modified" },
        ],
        narrative: "3 files changed.",
        total_files: 3,
      },
    };

    const loadPromise = bridge.loadData();
    mockOntoolresult?.(makeToolResult(payload));

    const result = await loadPromise;
    expect((result as typeof payload).prep.total_files).toBe(3);
    expect((result as typeof payload).prep.files).toHaveLength(3);
  });
});
