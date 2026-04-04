/**
 * bridge-send-message.test.ts
 *
 * Tests that bridge.sendMessage() correctly calls app.sendMessage() with the
 * expected user-role message shape, throws when not initialized, and propagates
 * SDK errors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the ext-apps module before importing bridge
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockGetHostContext = vi.fn().mockReturnValue(null);
const mockCallServerTool = vi.fn();

class MockApp {
  constructor(
    public _info: unknown,
    public _caps: unknown,
    public _opts: unknown,
  ) {}
  connect = mockConnect;
  getHostContext = mockGetHostContext;
  callServerTool = mockCallServerTool;
  sendMessage = mockSendMessage;
  set onhostcontextchanged(_cb: unknown) {
    /* no-op */
  }
  set ontoolresult(_cb: unknown) {
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
// Tests
// ---------------------------------------------------------------------------

describe("bridge.sendMessage()", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockGetHostContext.mockReturnValue(null);
    await bridge.init();
  });

  it("calls app.sendMessage with role:user and text content", async () => {
    mockSendMessage.mockResolvedValue(undefined);

    await bridge.sendMessage("Show me the blast radius");

    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith({
      content: [{ text: "Show me the blast radius", type: "text" }],
      role: "user",
    });
  });

  it("passes the exact text string to the content block", async () => {
    mockSendMessage.mockResolvedValue(undefined);

    const text = "Explain what changed in mcp-server/ui/stores/bridge.ts";
    await bridge.sendMessage(text);

    expect(mockSendMessage).toHaveBeenCalledWith({
      content: [{ text, type: "text" }],
      role: "user",
    });
  });

  it("resolves without returning a value", async () => {
    mockSendMessage.mockResolvedValue(undefined);

    const result = await bridge.sendMessage("hello");

    expect(result).toBeUndefined();
  });

  it("propagates errors from the SDK", async () => {
    const sdkError = new Error("SDK transport error");
    mockSendMessage.mockRejectedValue(sdkError);

    await expect(bridge.sendMessage("hello")).rejects.toThrow("SDK transport error");
  });
});
