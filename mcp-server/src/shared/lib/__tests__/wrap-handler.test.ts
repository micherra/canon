/**
 * Tests for wrap-handler.ts
 *
 * Covers:
 * - wrapHandler forwards `extra` to the inner handler
 * - A handler that ignores `extra` still produces the same { content: [{ text }] } shape
 * - Unexpected throws produce UNEXPECTED error responses
 * - "directory does not exist" throws produce WORKSPACE_NOT_FOUND error responses
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { wrapHandler } from "../wrap-handler.ts";

function makeExtra(sessionId?: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestId: "test-req-1",
    sessionId,
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("wrapHandler", () => {
  it("forwards extra to the inner handler", async () => {
    const receivedExtras: unknown[] = [];
    const wrapped = wrapHandler(
      async (_input: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        receivedExtras.push(extra);
        return "ok";
      },
    );

    const extra = makeExtra("session-X");
    await wrapped({}, extra);
    expect(receivedExtras).toHaveLength(1);
    expect(receivedExtras[0]).toBe(extra);
  });

  it("a handler that ignores extra still produces the { content: [{ text }] } shape", async () => {
    const wrapped = wrapHandler(async (_input: { value: number }) => {
      return { result: "ignored-extra" };
    });

    const result = await wrapped({ value: 42 }, makeExtra(undefined));
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining("ignored-extra"), type: "text" }],
    });
  });

  it("propagates different extra sessions to the handler", async () => {
    const sessionIds: (string | undefined)[] = [];
    const wrapped = wrapHandler(
      async (_input: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        sessionIds.push(extra.sessionId);
        return "ok";
      },
    );

    await wrapped({}, makeExtra("session-A"));
    await wrapped({}, makeExtra("session-B"));
    await wrapped({}, makeExtra(undefined));

    expect(sessionIds).toEqual(["session-A", "session-B", undefined]);
  });

  it("catches unexpected throws and returns UNEXPECTED error", async () => {
    const wrapped = wrapHandler(async (_input: unknown) => {
      throw new Error("something went wrong");
    });

    const result = await wrapped({}, makeExtra(undefined));
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean; error_code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
  });

  it("converts 'directory does not exist' to WORKSPACE_NOT_FOUND", async () => {
    const wrapped = wrapHandler(async (_input: unknown) => {
      throw new Error("workspace directory does not exist on disk");
    });

    const result = await wrapped({}, makeExtra(undefined));
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean; error_code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});
