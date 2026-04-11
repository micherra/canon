/**
 * Tests for PR #52 adapter-level review fixes that exercise the
 * platform adapters directly via a `node:child_process` mock.
 *
 * These are adapter-layer tests: they validate gitExecAsync and
 * runShell by stubbing the underlying child_process primitives.
 * Downstream consumer tests (Fix 2: codebase-graph, Fix 3:
 * pr-review-data shell escaping) live in the sibling file
 * pr52-downstream-fixes.test.ts with hoisted adapter mocks instead.
 * Splitting by mock layer keeps both styles race-free under vitest's
 * file-parallel execution.
 *
 * Covered fixes in this file:
 *   - Fix 1: git-adapter-async.ts — normalize err.code (string vs
 *            number) for exitCode
 *   - Fix 4: wrap-handler.ts — ok:false ToolResult passes through
 *            jsonResponse (verified here via import + behavior test)
 *   - Fix 5: process-adapter.ts — incorporate result.error.message
 *            into stderr when empty
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Fix 1 setup: mock node:child_process so gitExecAsync's execFile call
// is routed through `execFileImpl` and runShell's spawnSync is routed
// through `spawnSyncImpl`. Each test overrides these impls.

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

let execFileImpl: ((cb: ExecFileCallback) => void) | null = null;

type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: string | null;
  error?: Error;
};

let spawnSyncImpl: (() => SpawnSyncResult) | null = null;

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
      cb(null, "", "");
    }
    return { pid: 12345 };
  },
  spawnSync: (_cmd: string, _opts?: unknown) => {
    if (spawnSyncImpl) return spawnSyncImpl();
    return { signal: null, status: 0, stderr: "", stdout: "" };
  },
}));

import { gitExecAsync } from "@platform/adapters/git-adapter-async.ts";
import { runShell } from "@platform/adapters/process-adapter.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";

beforeEach(() => {
  execFileImpl = null;
  spawnSyncImpl = null;
});

describe("Fix 1: gitExecAsync — exitCode normalization for string err.code", () => {
  it("uses numeric err.code directly as exitCode", async () => {
    const err = Object.assign(new Error("exit 2"), { code: 2 });
    execFileImpl = (cb) => cb(err, "", "error");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("falls back to exitCode 1 when err.code is a string (e.g. ENOENT)", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(false);
    // String code must not be assigned directly — must fall back to 1
    expect(result.exitCode).toBe(1);
    expect(typeof result.exitCode).toBe("number");
  });

  it("falls back to exitCode 1 when err.code is EACCES (string)", async () => {
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("ETIMEDOUT string code still produces exitCode 1 (not the string)", async () => {
    const err = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["log"], "/project");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
  });

  it("numeric code 128 still used directly as exitCode", async () => {
    const err = Object.assign(new Error("fatal"), { code: 128 });
    execFileImpl = (cb) => cb(err, "", "fatal: not a git repo");
    const result = await gitExecAsync(["status"], "/notarepo");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(128);
  });

  it("string code is included in stderr for diagnostics", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["status"], "/project");
    // stderr should contain the string code or error message for diagnostics
    expect(result.stderr).toContain("ENOENT");
  });
});

// Fix 5: process-adapter — incorporate result.error.message into stderr

describe("Fix 5: runShell — error.message incorporated into stderr when stderr is empty", () => {
  it("includes result.error.message in stderr when stderr is empty and error exists", () => {
    const err = new Error("spawn ENOENT");
    spawnSyncImpl = () => ({ error: err, signal: null, status: null, stderr: "", stdout: "" });
    const result = runShell("nonexistent-command", "/project");
    expect(result.ok).toBe(false);
    // stderr must contain the error message for diagnostics
    expect(result.stderr).toContain("spawn ENOENT");
  });

  it("does NOT overwrite non-empty stderr with error.message", () => {
    const err = new Error("spawn error");
    spawnSyncImpl = () => ({
      error: err,
      signal: null,
      status: 127,
      stderr: "command not found: nonexistent-command",
      stdout: "",
    });
    const result = runShell("nonexistent-command", "/project");
    // Original stderr content is preserved
    expect(result.stderr).toBe("command not found: nonexistent-command");
    expect(result.stderr).not.toContain("spawn error");
  });

  it("stderr remains empty when there is no error and stderr is empty", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "output" });
    const result = runShell("echo output", "/project");
    expect(result.stderr).toBe("");
  });

  it("returns ok:false when error exists even with empty stderr", () => {
    const err = new Error("ENOENT");
    spawnSyncImpl = () => ({ error: err, signal: null, status: null, stderr: "", stdout: "" });
    const result = runShell("missing", "/project");
    expect(result.ok).toBe(false);
  });
});

// Fix 4: wrap-handler — docstring accuracy (verified via import + behavior test)

describe("Fix 4: wrapHandler — ok:false ToolResult passes through jsonResponse (not converted to MCP error)", () => {
  it("returns ok:false result as JSON (not converted to SDK error format)", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      error_code: "INVALID_INPUT",
      message: "invalid ref",
      ok: false,
      recoverable: false,
    }));
    const response = await handler({});
    // Result should be parseable JSON, not an SDK error
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("INVALID_INPUT");
    // Must be in content[0].text JSON format, not MCP isError:true format
    expect(response.content[0].type).toBe("text");
  });

  it("returns ok:true result as JSON (passthrough, no conversion)", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      nodes: [],
      ok: true,
    }));
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(true);
  });
});
