/**
 * ADR-002 Integration Tests (Part 2)
 *
 * Tests the contracts that implementors could not test at the unit level:
 *
 * 4. assertOk failure path (declared Known Gap in adr002-06)
 * 5. ToolResult ok:true/ok:false discrimination end-to-end through wrapHandler JSON serialization
 * 6. loadFlow ToolResult contract (cross-module: tool → wrapHandler chain)
 * 7. Timeout propagation through adapter boundaries (gate-runner 300s, defaults 30s)
 * 8. CanonErrorCode exhaustiveness — all 9 codes produce valid CanonToolErrors
 * 9. ProcessResult ok discriminant alignment
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: string | null;
  error?: Error;
};

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

let spawnSyncImpl: (() => SpawnSyncResult) | null = null;
let lastSpawnSyncOpts: Record<string, unknown> = {};
let execFileImpl: ((cb: ExecFileCallback) => void) | null = null;

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>,
    cb: ExecFileCallback,
  ) => {
    if (execFileImpl) {
      execFileImpl(cb);
    } else {
      cb(null, "async-output", "");
    }
    return { pid: 99999 };
  },
  spawnSync: (_cmd: string, argsOrOpts: unknown, optsArg?: unknown) => {
    const opts = Array.isArray(argsOrOpts) ? (optsArg ?? {}) : (argsOrOpts ?? {});
    lastSpawnSyncOpts = opts as Record<string, unknown>;
    if (spawnSyncImpl) return spawnSyncImpl();
    return { signal: null, status: 0, stderr: "", stdout: "" };
  },
}));

import { gitDiff, gitExec, gitStatus } from "@platform/adapters/git-adapter.ts";
import { gitExecAsync } from "@platform/adapters/git-adapter-async.ts";
import { runShell } from "@platform/adapters/process-adapter.ts";
import {
  assertOk,
  isToolError,
  type ToolResult,
  toolError,
  toolOk,
} from "@shared/lib/tool-result.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";

beforeEach(() => {
  spawnSyncImpl = null;
  execFileImpl = null;
  lastSpawnSyncOpts = {};
});

// 4. assertOk failure path (declared Known Gap in adr002-06)
// The assertOk helper's assertion failure path is not directly unit-tested.

describe("assertOk — failure path (declared Known Gap adr002-06)", () => {
  it("throws when result is a CanonToolError", () => {
    const err = toolError("WORKSPACE_NOT_FOUND", "workspace missing");
    expect(() => assertOk(err as ToolResult<Record<string, unknown>>)).toThrow();
  });

  it("throws with an informative message containing the error_code", () => {
    const err = toolError("INVALID_INPUT", "bad value");
    expect(() => assertOk(err as ToolResult<Record<string, unknown>>)).toThrow(/INVALID_INPUT/);
  });

  it("throws with a message containing the error message", () => {
    const err = toolError("FLOW_NOT_FOUND", "flow-xyz not found");
    expect(() => assertOk(err as ToolResult<Record<string, unknown>>)).toThrow(
      /flow-xyz not found/,
    );
  });

  it("does NOT throw when result is ok:true", () => {
    const ok = toolOk({ workspace: "ws-1" }) as ToolResult<{ workspace: string }>;
    expect(() => assertOk(ok)).not.toThrow();
  });

  it("narrows type after assertOk — property access is safe", () => {
    const result = toolOk({ count: 42 }) as ToolResult<{ count: number }>;
    assertOk(result);
    // After assertOk passes, TypeScript narrows to { ok: true } & { count: number }
    expect(result.count).toBe(42);
  });
});

// 5. ToolResult ok:true/ok:false discrimination end-to-end through wrapHandler

describe("wrapHandler × ToolResult end-to-end JSON serialization", () => {
  it("ok:true result serializes with all data fields at top level (no nesting)", async () => {
    const handler = wrapHandler(async (_input: unknown) =>
      toolOk({ count: 3, state: "build", workspace: "ws-abc" }),
    );
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace).toBe("ws-abc");
    expect(parsed.state).toBe("build");
    expect(parsed.count).toBe(3);
    // DEC-05: no nested data wrapper
    expect(parsed.data).toBeUndefined();
  });

  it("ok:false CanonToolError serializes with all required fields", async () => {
    const handler = wrapHandler(async (_input: unknown) =>
      toolError("WORKSPACE_NOT_FOUND", "workspace not found", false, { workspace: "ws-missing" }),
    );
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(parsed.message).toBe("workspace not found");
    expect(parsed.recoverable).toBe(false);
    expect(parsed.context).toEqual({ workspace: "ws-missing" });
  });

  it("isToolError correctly identifies error result deserialized from JSON", async () => {
    const handler = wrapHandler(async (_input: unknown) =>
      toolError("FLOW_NOT_FOUND", "flow not found"),
    );
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    // After round-tripping through JSON, isToolError must still identify this correctly
    expect(isToolError(parsed)).toBe(true);
  });

  it("isToolError returns false for ok:true result deserialized from JSON", async () => {
    const handler = wrapHandler(async (_input: unknown) => toolOk({ board: { status: "done" } }));
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(isToolError(parsed)).toBe(false);
  });

  it("wrapHandler catches throw from ToolResult-returning tool and wraps as UNEXPECTED", async () => {
    // Simulate a tool that returns ToolResult normally but throws on an unexpected path
    const handler = wrapHandler(async (input: { shouldThrow: boolean }) => {
      if (input.shouldThrow) throw new Error("internal db error");
      return toolOk({ done: true });
    });

    const errorResponse = await handler({ shouldThrow: true });
    const parsed = JSON.parse(errorResponse.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("UNEXPECTED");
    expect(parsed.message).toBe("An unexpected error occurred");

    // Normal path still works after an error
    const okResponse = await handler({ shouldThrow: false });
    const okParsed = JSON.parse(okResponse.content[0].text);
    expect(okParsed.ok).toBe(true);
  });

  it("recoverable:true is preserved through wrapHandler JSON round-trip", async () => {
    const handler = wrapHandler(async (_input: unknown) =>
      toolError("KG_NOT_INDEXED", "graph not indexed", true),
    );
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.recoverable).toBe(true);
  });

  it("MCP response envelope has correct shape: content[0].type === 'text'", async () => {
    const handler = wrapHandler(async (_input: unknown) => toolOk({ x: 1 }));
    const response = await handler({});
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect(typeof response.content[0].text).toBe("string");
  });
});

// 6. loadFlow ToolResult contract (cross-module: tool → wrapHandler chain)

describe("loadFlow ToolResult — ok:false error paths", () => {
  it("returns FLOW_NOT_FOUND when flow does not exist (not a throw)", async () => {
    const { loadFlow } = await import("../tools/load-flow.ts");
    const result = await loadFlow({ flow_name: "flow-that-does-not-exist-xyz" }, "/nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // FLOW_NOT_FOUND or FLOW_PARSE_ERROR are both acceptable for a missing flow
      expect(["FLOW_NOT_FOUND", "FLOW_PARSE_ERROR"]).toContain(result.error_code);
      expect(typeof result.message).toBe("string");
      expect(typeof result.recoverable).toBe("boolean");
    }
  });

  it("loadFlow error result passes through wrapHandler as valid JSON with ok:false", async () => {
    const { loadFlow } = await import("../tools/load-flow.ts");
    const handler = wrapHandler(async (input: { flow_name: string }) =>
      loadFlow(input, "/nonexistent"),
    );
    const response = await handler({ flow_name: "no-such-flow" });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(["FLOW_NOT_FOUND", "FLOW_PARSE_ERROR"]).toContain(parsed.error_code);
    expect(isToolError(parsed)).toBe(true);
  });
});

// 7. Timeout propagation through adapter chain

describe("Timeout propagation — default 30s on all adapters", () => {
  it("gitExec uses 30s default when no timeout specified", () => {
    gitExec(["status"], "/project");
    expect(lastSpawnSyncOpts.timeout).toBe(30_000);
  });

  it("runShell uses 30s default when no timeout specified", () => {
    runShell("echo hello", "/project");
    expect(lastSpawnSyncOpts.timeout).toBe(30_000);
  });

  it("gitExec accepts explicit timeout override", () => {
    gitExec(["log"], "/project", 5_000);
    expect(lastSpawnSyncOpts.timeout).toBe(5_000);
  });

  it("runShell accepts explicit timeout override (e.g. gate-runner 300s)", () => {
    runShell("npm test", "/project", 300_000);
    expect(lastSpawnSyncOpts.timeout).toBe(300_000);
  });

  it("gitDiff inherits default 30s timeout when none specified", () => {
    gitDiff(["HEAD~1"], "/project");
    expect(lastSpawnSyncOpts.timeout).toBe(30_000);
  });

  it("gitStatus inherits default 30s timeout when none specified", () => {
    gitStatus("/project");
    expect(lastSpawnSyncOpts.timeout).toBe(30_000);
  });
});

describe("Timeout propagation — gate-runner uses 300s for shell gates", () => {
  // This test verifies the contract from adr002-02: gate-runner passes 300_000ms to runShell.
  // We test via direct runShell mock verification (not re-testing gate-runner internals).
  it("runShell correctly receives 300_000ms and passes it to spawnSync (gate-runner contract)", () => {
    runShell("npm run lint", "/project", 300_000);
    expect(lastSpawnSyncOpts.timeout).toBe(300_000);
    // The shell: true flag must be set even for long-running gate commands
    expect(lastSpawnSyncOpts.shell).toBe(true);
  });
});

// 8. CanonErrorCode exhaustiveness — all 9 codes produce valid CanonToolErrors

describe("CanonErrorCode exhaustiveness — all 9 codes produce valid ToolResult errors", () => {
  const ALL_CODES = [
    "WORKSPACE_NOT_FOUND",
    "FLOW_NOT_FOUND",
    "FLOW_PARSE_ERROR",
    "KG_NOT_INDEXED",
    "BOARD_LOCKED",
    "CONVERGENCE_EXCEEDED",
    "INVALID_INPUT",
    "PREFLIGHT_FAILED",
    "UNEXPECTED",
  ] as const;

  for (const code of ALL_CODES) {
    it(`toolError("${code}") produces a valid CanonToolError recognized by isToolError`, () => {
      const err = toolError(code, `test message for ${code}`);
      expect(isToolError(err)).toBe(true);
      expect(err.ok).toBe(false);
      expect(err.error_code).toBe(code);
    });

    it(`toolError("${code}") round-trips through JSON and isToolError still returns true`, () => {
      const err = toolError(code, `msg`);
      const roundTripped = JSON.parse(JSON.stringify(err));
      expect(isToolError(roundTripped)).toBe(true);
      expect(roundTripped.error_code).toBe(code);
    });
  }
});

// 9. ProcessResult ok discriminant alignment
// ok:true === (exitCode === 0 && !error) — both adapters must be consistent

describe("ProcessResult ok discriminant alignment across adapters", () => {
  it("gitExec: ok:true when exitCode 0 and no error", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "out" });
    const r = gitExec(["status"], "/p");
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("gitExec: ok:false when exitCode nonzero", () => {
    spawnSyncImpl = () => ({ signal: null, status: 1, stderr: "err", stdout: "" });
    const r = gitExec(["status"], "/p");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("gitExec: ok:false when error is present even with status 0", () => {
    spawnSyncImpl = () => ({
      error: new Error("spawn error"),
      signal: null,
      status: 0,
      stderr: "",
      stdout: "",
    });
    const r = gitExec(["status"], "/p");
    expect(r.ok).toBe(false);
  });

  it("runShell: ok:true when exitCode 0 and no error", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "out" });
    const r = runShell("echo hello", "/p");
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("runShell: ok:false when exitCode nonzero", () => {
    spawnSyncImpl = () => ({ signal: null, status: 2, stderr: "err", stdout: "" });
    const r = runShell("false", "/p");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
  });

  it("gitExecAsync: ok:true when no error callback", async () => {
    execFileImpl = (cb) => cb(null, "output", "");
    const r = await gitExecAsync(["status"], "/p");
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("gitExecAsync: ok:false when error callback fires", async () => {
    const err = Object.assign(new Error("fatal"), { code: 128 });
    execFileImpl = (cb) => cb(err, "", "fatal: not a git repo");
    const r = await gitExecAsync(["status"], "/p");
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it("all three adapters agree: ok === (exitCode 0 && !timedOut) on success", async () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "x" });
    execFileImpl = (cb) => cb(null, "x", "");

    const sync = gitExec(["status"], "/p");
    const shell = runShell("echo x", "/p");
    const async_ = await gitExecAsync(["status"], "/p");

    for (const r of [sync, shell, async_]) {
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
    }
  });
});
