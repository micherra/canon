/**
 * ADR-002 Integration Tests
 *
 * Tests the contracts that implementors could not test at the unit level:
 *
 * 1. Adapter → tool → handler chain (end-to-end ToolResult flow through wrapHandler)
 * 2. Contract-checker adapter routing: file_changed uses gitExec (no shell),
 *    bash_check uses runShell (shell: true) — unit-level mock verification
 * 3. ProcessResult shape contract: all 5 fields present across both adapters
 * 4. Security boundary: gitExec never has shell, runShell always has shell
 * 5. assertOk failure path (declared Known Gap in adr002-06)
 * 6. Timeout propagation through adapter boundaries (gate-runner 300s, defaults 30s)
 * 7. ToolResult ok:true/ok:false discrimination end-to-end through wrapHandler JSON serialization
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Section 1: ProcessResult shape contract
// Both adapters must return an object with all 5 ProcessResult fields.
// These tests import the adapters through mocked child_process.
// ---------------------------------------------------------------------------

// We need separate vi.mock blocks per describe context — vitest hoists all
// vi.mock calls to the top of the module. We accept that both adapters
// share one child_process mock in this file; we distinguish them via the
// recorded call shapes (shell property).

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
  spawnSync: (_cmd: string, argsOrOpts: unknown, optsArg?: unknown) => {
    // Handle both spawnSync(cmd, opts) and spawnSync(cmd, args, opts) overloads
    const opts = Array.isArray(argsOrOpts) ? (optsArg ?? {}) : (argsOrOpts ?? {});
    lastSpawnSyncOpts = opts as Record<string, unknown>;
    if (spawnSyncImpl) return spawnSyncImpl();
    return { stdout: "", stderr: "", status: 0, signal: null };
  },
  execFile: (_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecFileCallback) => {
    if (execFileImpl) {
      execFileImpl(cb);
    } else {
      cb(null, "async-output", "");
    }
    return { pid: 99999 };
  },
}));

import { gitDiff, gitExec, gitStatus } from "../adapters/git-adapter.ts";
import { gitExecAsync } from "../adapters/git-adapter-async.ts";
import { runShell } from "../adapters/process-adapter.ts";
import { assertOk, isToolError, type ProcessResult, type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";
import { wrapHandler } from "../utils/wrap-handler.ts";

beforeEach(() => {
  spawnSyncImpl = null;
  execFileImpl = null;
  lastSpawnSyncOpts = {};
});

// ---------------------------------------------------------------------------
// 1. ProcessResult shape contract
// ---------------------------------------------------------------------------

describe("ProcessResult shape contract — gitExec", () => {
  it("returns all 5 required fields on the success path", () => {
    spawnSyncImpl = () => ({ stdout: "main\n", stderr: "warn\n", status: 0, signal: null });
    const result = gitExec(["branch"], "/project");
    // All 5 fields must be present and correctly typed
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("returns all 5 required fields on the error path", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "fatal error", status: 128, signal: null });
    const result = gitExec(["status"], "/notarepo");
    expect(typeof result.ok).toBe("boolean");
    expect(result.ok).toBe(false);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("stdout and stderr never return undefined (empty string fallback)", () => {
    // Simulate spawnSync returning null for stdout/stderr (can happen on some platforms)
    spawnSyncImpl = () => ({
      stdout: null as unknown as string,
      stderr: null as unknown as string,
      status: 0,
      signal: null,
    });
    const result = gitExec(["status"], "/project");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("ProcessResult shape contract — runShell", () => {
  it("returns all 5 required fields on the success path", () => {
    spawnSyncImpl = () => ({ stdout: "output\n", stderr: "", status: 0, signal: null });
    const result = runShell("echo hello", "/project");
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("returns all 5 required fields on the error path", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "command not found", status: 127, signal: null });
    const result = runShell("notacommand", "/project");
    expect(typeof result.ok).toBe("boolean");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(typeof result.timedOut).toBe("boolean");
  });
});

describe("ProcessResult shape contract — gitExecAsync", () => {
  it("resolves all 5 required fields on the success path", async () => {
    execFileImpl = (cb) => cb(null, "branch-name\n", "");
    const result = await gitExecAsync(["rev-parse", "--abbrev-ref", "HEAD"], "/project");
    expect(typeof result.ok).toBe("boolean");
    expect(result.ok).toBe(true);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("resolves all 5 required fields on the error path (never rejects)", async () => {
    const err = Object.assign(new Error("not a repo"), { code: 128 });
    execFileImpl = (cb) => cb(err, "", "fatal: not a git repository");
    const result = await gitExecAsync(["status"], "/notarepo");
    expect(typeof result.ok).toBe("boolean");
    expect(result.ok).toBe(false);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("gitDiff shapes match ProcessResult contract (convenience wrapper)", () => {
    spawnSyncImpl = () => ({ stdout: "file.ts\n", stderr: "", status: 0, signal: null });
    const result = gitDiff(["HEAD~1", "HEAD"], "/project");
    const fields: Array<keyof ProcessResult> = ["ok", "stdout", "stderr", "exitCode", "timedOut"];
    for (const field of fields) {
      expect(field in result).toBe(true);
    }
  });

  it("gitStatus shapes match ProcessResult contract (convenience wrapper)", () => {
    spawnSyncImpl = () => ({ stdout: "M file.ts\n", stderr: "", status: 0, signal: null });
    const result = gitStatus("/project");
    const fields: Array<keyof ProcessResult> = ["ok", "stdout", "stderr", "exitCode", "timedOut"];
    for (const field of fields) {
      expect(field in result).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Security boundary: gitExec never sets shell; runShell always sets shell
// ---------------------------------------------------------------------------

describe("Security boundary — git adapter never uses shell", () => {
  it("gitExec does not pass shell:true when called directly", () => {
    gitExec(["log", "--oneline", "-1"], "/project");
    expect(lastSpawnSyncOpts.shell).not.toBe(true);
  });

  it("gitDiff convenience wrapper never passes shell:true", () => {
    gitDiff(["HEAD~1", "HEAD"], "/project");
    expect(lastSpawnSyncOpts.shell).not.toBe(true);
  });

  it("gitStatus convenience wrapper never passes shell:true", () => {
    gitStatus("/project");
    expect(lastSpawnSyncOpts.shell).not.toBe(true);
  });
});

describe("Security boundary — process adapter always uses shell", () => {
  it("runShell passes shell:true", () => {
    runShell("echo hello", "/project");
    expect(lastSpawnSyncOpts.shell).toBe(true);
  });

  it("runShell passes shell:true even with custom timeout", () => {
    runShell("npm test", "/project", 300_000);
    expect(lastSpawnSyncOpts.shell).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Contract-checker adapter routing
// Declared Known Gap in adr002-02: "contract-checker.ts adapter routing is
// verified via integration tests only (no unit-level mock verifying gitExec
// vs runShell routing)".
//
// We use a fresh vi.doMock approach here to isolate the module under test.
// ---------------------------------------------------------------------------

describe("Contract-checker adapter routing — gitExec used for file_changed (not runShell)", () => {
  it("file_changed assertion calls gitExec (array args) — no shell injection possible", async () => {
    // We verify that the gitExec mock is called (not runShell) for file_changed.
    // This test uses vitest's module isolation: import fresh copies with doMock.
    const gitExecCalls: { args: string[]; cwd: string }[] = [];
    const runShellCalls: { cmd: string; cwd: string }[] = [];

    vi.doMock("../adapters/git-adapter.ts", () => ({
      gitExec: (args: string[], cwd: string) => {
        gitExecCalls.push({ args, cwd });
        // Simulate 'file changed' — non-empty stdout means changed
        return { ok: true, stdout: "initial.ts\n", stderr: "", exitCode: 0, timedOut: false };
      },
      gitDiff: vi.fn(),
      gitStatus: vi.fn(),
    }));

    vi.doMock("../adapters/process-adapter.ts", () => ({
      runShell: (cmd: string, cwd: string) => {
        runShellCalls.push({ cmd, cwd });
        return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    }));

    vi.resetModules();
    const { evaluatePostconditions } = await import("../orchestration/contract-checker.ts");

    const results = evaluatePostconditions([{ type: "file_changed", target: "initial.ts" }], "/project", "abc1234");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    // gitExec was called (array args routing — no shell)
    expect(gitExecCalls).toHaveLength(1);
    expect(Array.isArray(gitExecCalls[0].args)).toBe(true);
    expect(gitExecCalls[0].args).toContain("diff");
    expect(gitExecCalls[0].args).toContain("initial.ts");
    // runShell was NOT called for file_changed
    expect(runShellCalls).toHaveLength(0);

    vi.doUnmock("../adapters/git-adapter.ts");
    vi.doUnmock("../adapters/process-adapter.ts");
  });

  it("bash_check assertion calls runShell (shell: true) — not gitExec", async () => {
    const gitExecCalls: string[][] = [];
    const runShellCalls: string[] = [];

    vi.doMock("../adapters/git-adapter.ts", () => ({
      gitExec: (args: string[]) => {
        gitExecCalls.push(args);
        return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
      gitDiff: vi.fn(),
      gitStatus: vi.fn(),
    }));

    vi.doMock("../adapters/process-adapter.ts", () => ({
      runShell: (cmd: string) => {
        runShellCalls.push(cmd);
        return { ok: true, stdout: "test passed", stderr: "", exitCode: 0, timedOut: false };
      },
    }));

    vi.resetModules();
    const { evaluatePostconditions } = await import("../orchestration/contract-checker.ts");

    const results = evaluatePostconditions([{ type: "bash_check", command: "echo ok" }], "/project");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    // runShell was called for bash_check
    expect(runShellCalls).toHaveLength(1);
    expect(runShellCalls[0]).toBe("echo ok");
    // gitExec was NOT called for bash_check
    expect(gitExecCalls).toHaveLength(0);

    vi.doUnmock("../adapters/git-adapter.ts");
    vi.doUnmock("../adapters/process-adapter.ts");
  });
});

// ---------------------------------------------------------------------------
// 4. assertOk failure path (declared Known Gap in adr002-06)
// The assertOk helper's assertion failure path is not directly unit-tested.
// ---------------------------------------------------------------------------

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
    expect(() => assertOk(err as ToolResult<Record<string, unknown>>)).toThrow(/flow-xyz not found/);
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

// ---------------------------------------------------------------------------
// 5. ToolResult ok:true/ok:false discrimination end-to-end through wrapHandler
// ---------------------------------------------------------------------------

describe("wrapHandler × ToolResult end-to-end JSON serialization", () => {
  it("ok:true result serializes with all data fields at top level (no nesting)", async () => {
    const handler = wrapHandler(async (_input: unknown) => toolOk({ workspace: "ws-abc", state: "build", count: 3 }));
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
    const handler = wrapHandler(async (_input: unknown) => toolError("FLOW_NOT_FOUND", "flow not found"));
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
    const handler = wrapHandler(async (_input: unknown) => toolError("KG_NOT_INDEXED", "graph not indexed", true));
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

// ---------------------------------------------------------------------------
// 6. loadFlow ToolResult contract (cross-module: tool → wrapHandler chain)
// ---------------------------------------------------------------------------

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
    const handler = wrapHandler(async (input: { flow_name: string }) => loadFlow(input, "/nonexistent"));
    const response = await handler({ flow_name: "no-such-flow" });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(["FLOW_NOT_FOUND", "FLOW_PARSE_ERROR"]).toContain(parsed.error_code);
    expect(isToolError(parsed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Timeout propagation through adapter chain
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 8. CanonErrorCode exhaustiveness — all 9 codes produce valid CanonToolErrors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 9. ProcessResult ok discriminant alignment
// ok:true === (exitCode === 0 && !error) — both adapters must be consistent
// ---------------------------------------------------------------------------

describe("ProcessResult ok discriminant alignment across adapters", () => {
  it("gitExec: ok:true when exitCode 0 and no error", () => {
    spawnSyncImpl = () => ({ stdout: "out", stderr: "", status: 0, signal: null });
    const r = gitExec(["status"], "/p");
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("gitExec: ok:false when exitCode nonzero", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "err", status: 1, signal: null });
    const r = gitExec(["status"], "/p");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("gitExec: ok:false when error is present even with status 0", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 0, signal: null, error: new Error("spawn error") });
    const r = gitExec(["status"], "/p");
    expect(r.ok).toBe(false);
  });

  it("runShell: ok:true when exitCode 0 and no error", () => {
    spawnSyncImpl = () => ({ stdout: "out", stderr: "", status: 0, signal: null });
    const r = runShell("echo hello", "/p");
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("runShell: ok:false when exitCode nonzero", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "err", status: 2, signal: null });
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
    spawnSyncImpl = () => ({ stdout: "x", stderr: "", status: 0, signal: null });
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
