/**
 * Tests for wrapHandler — top-level MCP catch-all utility.
 *
 * wrapHandler wraps an async tool handler to:
 * 1. Pass through ok:true results unchanged
 * 2. Pass through ok:false ToolResult results unchanged
 * 3. Catch unexpected throws and convert to { ok:false, error_code:"UNEXPECTED", ... }
 * 4. Handle non-Error throws (strings, objects) gracefully
 */

import { describe, expect, it } from "vitest";
import { wrapHandler } from "../utils/wrap-handler.ts";

describe("wrapHandler — happy path (ok:true)", () => {
  it("passes through result with ok:true and data fields unchanged", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      ok: true,
      data: "x",
    }));

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe("x");
  });

  it("passes through result with ok:true and nested structure unchanged", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      ok: true,
      workspace: "ws-1",
      status: "complete",
    }));

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace).toBe("ws-1");
    expect(parsed.status).toBe("complete");
  });
});

describe("wrapHandler — ok:false ToolResult passthrough", () => {
  it("passes through ok:false CanonToolError result unchanged", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      ok: false,
      error_code: "INVALID_INPUT",
      message: "bad",
      recoverable: false,
    }));

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("INVALID_INPUT");
    expect(parsed.message).toBe("bad");
    expect(parsed.recoverable).toBe(false);
  });

  it("does NOT transform ok:false result — no extra wrapping", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      ok: false,
      error_code: "WORKSPACE_NOT_FOUND",
      message: "not found",
      recoverable: false,
    }));

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    // Should not have a double-wrapped structure
    expect(parsed.content).toBeUndefined();
    expect(parsed.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("wrapHandler — catch-all: Error throws", () => {
  it("converts Error throw to UNEXPECTED error shape", async () => {
    const handler = wrapHandler(async (_input: unknown) => {
      throw new Error("boom");
    });

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
    // Raw error detail must NOT be forwarded to caller (security: error leakage prevention)
    expect(parsed.message).toBe("An unexpected error occurred");
    expect(parsed.recoverable).toBe(false);
  });

  it("returns generic message in UNEXPECTED result (not raw error detail)", async () => {
    const handler = wrapHandler(async (_input: unknown) => {
      throw new Error("database connection failed");
    });

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    // Raw error detail is logged to console.error only, not forwarded to MCP caller
    expect(parsed.message).toBe("An unexpected error occurred");
  });

  it("result is valid JSON (content[0].text is parseable)", async () => {
    const handler = wrapHandler(async (_input: unknown) => {
      throw new Error("unexpected failure");
    });

    const response = await handler({});
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect(() => JSON.parse(response.content[0].text)).not.toThrow();
  });
});

describe("wrapHandler — catch-all: non-Error throws", () => {
  it("converts string throw to UNEXPECTED error with generic message", async () => {
    const handler = wrapHandler(async (_input: unknown) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "something bad happened";
    });

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
    // Raw string detail is logged to console.error only, not forwarded to MCP caller
    expect(parsed.message).toBe("An unexpected error occurred");
  });

  it("converts number throw to UNEXPECTED error with generic message", async () => {
    const handler = wrapHandler(async (_input: unknown) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 42;
    });

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
    // Raw number detail is logged to console.error only, not forwarded to MCP caller
    expect(parsed.message).toBe("An unexpected error occurred");
  });

  it("converts object throw to UNEXPECTED error", async () => {
    const handler = wrapHandler(async (_input: unknown) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: "OOPS", detail: "unexpected object" };
    });

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
    // String(object) produces "[object Object]"
    expect(typeof parsed.message).toBe("string");
  });
});

describe("wrapHandler — input passthrough", () => {
  it("passes input to the wrapped handler", async () => {
    let receivedInput: unknown = null;
    const handler = wrapHandler(async (input: { value: string }) => {
      receivedInput = input;
      return { ok: true, echoed: input.value };
    });

    await handler({ value: "hello" });
    expect(receivedInput).toEqual({ value: "hello" });
  });
});
