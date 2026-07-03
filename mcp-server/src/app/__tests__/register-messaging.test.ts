/**
 * Tests for register-messaging.ts — MCP tool registration.
 *
 * Covers:
 * - post_message, tail_messages, list_active_workspaces are all registered
 *   (tool-count delta +3 alongside the pre-existing post_event)
 * - post_message / tail_messages descriptions contain the best-effort-poll
 *   disclaimer verbatim substring (dc-07)
 * - each new handler threads projectDir via resolveScope(extra)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/server-state.ts", () => ({
  gatedWrapHandler: (handler: (input: unknown, extra: unknown) => unknown) => handler,
  resolveScope: () => "/mock/project",
}));

vi.mock("@features/orchestration/tools/post-message.ts", () => ({
  postMessage: vi.fn().mockResolvedValue({ id: 1, logged: true, ok: true, timestamp: "t" }),
}));
vi.mock("@features/orchestration/tools/tail-messages.ts", () => ({
  tailMessages: vi.fn().mockResolvedValue({ last_id: 0, messages: [], ok: true, peer_lock: null }),
}));
vi.mock("@features/orchestration/tools/list-active-workspaces.ts", () => ({
  listActiveWorkspaces: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }),
}));

const BEST_EFFORT_POLL_DISCLAIMER =
  "Best-effort ordered poll. No delivery guarantee, no push/subscribe: messages are visible on " +
  "the next tail_messages poll, ordered by id. SQLite is a store, not a bus.";

describe("registerMessagingTools", () => {
  let mockServer: { registerTool: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../register-messaging.ts");
    mockServer = { registerTool: vi.fn() };
    mod.registerMessagingTools(mockServer as never);
  });

  it("registers 4 tools: post_event + the 3 new chatter/discovery tools", () => {
    const names = mockServer.registerTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain("post_event");
    expect(names).toContain("post_message");
    expect(names).toContain("tail_messages");
    expect(names).toContain("list_active_workspaces");
    expect(mockServer.registerTool).toHaveBeenCalledTimes(4);
  });

  it("post_message description contains the best-effort-poll disclaimer verbatim", () => {
    const call = mockServer.registerTool.mock.calls.find((c: unknown[]) => c[0] === "post_message");
    expect(call).toBeDefined();
    const config = call?.[1] as { description: string };
    expect(config.description).toContain(BEST_EFFORT_POLL_DISCLAIMER);
  });

  it("tail_messages description contains the best-effort-poll disclaimer verbatim", () => {
    const call = mockServer.registerTool.mock.calls.find(
      (c: unknown[]) => c[0] === "tail_messages",
    );
    expect(call).toBeDefined();
    const config = call?.[1] as { description: string };
    expect(config.description).toContain(BEST_EFFORT_POLL_DISCLAIMER);
  });

  it("list_active_workspaces description states it is a discovery index", () => {
    const call = mockServer.registerTool.mock.calls.find(
      (c: unknown[]) => c[0] === "list_active_workspaces",
    );
    expect(call).toBeDefined();
    const config = call?.[1] as { description: string };
    expect(config.description.toLowerCase()).toContain("discovery");
  });

  it("post_message handler threads projectDir via resolveScope(extra)", async () => {
    const { postMessage } = await import("@features/orchestration/tools/post-message.ts");
    const call = mockServer.registerTool.mock.calls.find((c: unknown[]) => c[0] === "post_message");
    const handler = call?.[2] as (input: unknown, extra: unknown) => Promise<unknown>;
    await handler({ content: "hi", sender: "engineer", workspace: "/ws" }, {});
    expect(postMessage).toHaveBeenCalledWith(
      { content: "hi", sender: "engineer", workspace: "/ws" },
      "/mock/project",
    );
  });

  it("tail_messages handler threads projectDir via resolveScope(extra)", async () => {
    const { tailMessages } = await import("@features/orchestration/tools/tail-messages.ts");
    const call = mockServer.registerTool.mock.calls.find(
      (c: unknown[]) => c[0] === "tail_messages",
    );
    const handler = call?.[2] as (input: unknown, extra: unknown) => Promise<unknown>;
    await handler({ workspace: "/ws" }, {});
    expect(tailMessages).toHaveBeenCalledWith({ workspace: "/ws" }, "/mock/project");
  });

  it("list_active_workspaces handler threads projectDir via resolveScope(extra)", async () => {
    const { listActiveWorkspaces } = await import(
      "@features/orchestration/tools/list-active-workspaces.ts"
    );
    const call = mockServer.registerTool.mock.calls.find(
      (c: unknown[]) => c[0] === "list_active_workspaces",
    );
    const handler = call?.[2] as (input: unknown, extra: unknown) => Promise<unknown>;
    await handler({}, {});
    expect(listActiveWorkspaces).toHaveBeenCalledWith({}, "/mock/project");
  });
});
