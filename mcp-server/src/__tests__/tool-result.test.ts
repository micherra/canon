import { describe, expect, it } from "vitest";
import {
  type CanonErrorCode,
  isToolError,
  type ToolResult,
  toolError,
  toolOk,
} from "../utils/tool-result.ts";

// toolError()

describe("toolError — shape and defaults", () => {
  it("returns an object with ok:false", () => {
    const err = toolError("UNEXPECTED", "something went wrong");
    expect(err.ok).toBe(false);
  });

  it("sets error_code from first arg", () => {
    const err = toolError("WORKSPACE_NOT_FOUND", "not found");
    expect(err.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("sets message from second arg", () => {
    const err = toolError("INVALID_INPUT", "bad input");
    expect(err.message).toBe("bad input");
  });

  it("defaults recoverable to false when not provided", () => {
    const err = toolError("UNEXPECTED", "oops");
    expect(err.recoverable).toBe(false);
  });

  it("sets recoverable to true when explicitly passed", () => {
    const err = toolError("BOARD_LOCKED", "locked", true);
    expect(err.recoverable).toBe(true);
  });

  it("sets context when provided", () => {
    const err = toolError("KG_NOT_INDEXED", "not indexed", false, { file: "foo.ts" });
    expect(err.context).toEqual({ file: "foo.ts" });
  });

  it("leaves context undefined when not provided", () => {
    const err = toolError("UNEXPECTED", "oops");
    expect(err.context).toBeUndefined();
  });

  it("accepts all CanonErrorCode values without type error", () => {
    const codes: CanonErrorCode[] = [
      "WORKSPACE_NOT_FOUND",
      "FLOW_NOT_FOUND",
      "FLOW_PARSE_ERROR",
      "KG_NOT_INDEXED",
      "BOARD_LOCKED",
      "CONVERGENCE_EXCEEDED",
      "INVALID_INPUT",
      "PREFLIGHT_FAILED",
      "UNEXPECTED",
    ];
    for (const code of codes) {
      const err = toolError(code, "msg");
      expect(err.error_code).toBe(code);
    }
  });
});

// toolOk()

describe("toolOk — shape", () => {
  it("returns an object with ok:true", () => {
    const result = toolOk({ workspace: "ws-1" });
    expect(result.ok).toBe(true);
  });

  it("spreads data fields directly onto the result", () => {
    const result = toolOk({ flow: "build", workspace: "ws-1" });
    expect(result.workspace).toBe("ws-1");
    expect(result.flow).toBe("build");
  });

  it("does NOT wrap data in a nested data field", () => {
    const result = toolOk({ workspace: "ws-1" }) as any;
    expect(result.data).toBeUndefined();
  });

  it("works with empty data object", () => {
    const result = toolOk({});
    expect(result.ok).toBe(true);
  });
});

// isToolError()

describe("isToolError — type guard", () => {
  it("returns true for a CanonToolError shape", () => {
    const err = toolError("UNEXPECTED", "oops");
    expect(isToolError(err)).toBe(true);
  });

  it("returns false for a toolOk result", () => {
    const ok = toolOk({ workspace: "ws-1" });
    expect(isToolError(ok)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isToolError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isToolError(undefined)).toBe(false);
  });

  it("returns false for a plain object without ok:false", () => {
    expect(isToolError({ message: "hello" })).toBe(false);
  });

  it("returns false for an object with ok:true and error_code", () => {
    expect(isToolError({ error_code: "UNEXPECTED", ok: true })).toBe(false);
  });

  it("returns false for an object with ok:false but no error_code", () => {
    expect(isToolError({ message: "bad", ok: false })).toBe(false);
  });
});

// ToolResult<T> — discriminated union usage

describe("ToolResult<T> — discriminated union", () => {
  it("ToolResult can hold a toolOk value", () => {
    const result: ToolResult<{ workspace: string }> = toolOk({ workspace: "ws-1" });
    if (result.ok) {
      expect(result.workspace).toBe("ws-1");
    }
  });

  it("ToolResult can hold a toolError value", () => {
    const result: ToolResult<{ workspace: string }> = toolError("UNEXPECTED", "oops");
    if (!result.ok) {
      expect(result.error_code).toBe("UNEXPECTED");
    }
  });
});
