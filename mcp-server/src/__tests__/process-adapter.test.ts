import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: string | null;
  error?: Error;
};

type SpawnSyncCallRecord = {
  cmd: string;
  opts: Record<string, unknown>;
};

let spawnSyncImpl: (() => SpawnSyncResult) | null = null;
let spawnSyncCalls: SpawnSyncCallRecord[] = [];

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, opts?: unknown) => {
    spawnSyncCalls.push({ cmd, opts: (opts ?? {}) as Record<string, unknown> });
    if (spawnSyncImpl) return spawnSyncImpl();
    return { stdout: "", stderr: "", status: 0, signal: null };
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { runShell } from "../adapters/process-adapter.ts";

beforeEach(() => {
  spawnSyncImpl = null;
  spawnSyncCalls = [];
});

// ---------------------------------------------------------------------------
// runShell — shell:true requirement
// ---------------------------------------------------------------------------

describe("runShell — shell:true is set", () => {
  it("passes shell:true in options", () => {
    runShell("echo hello", "/project");
    expect(spawnSyncCalls[0].opts.shell).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runShell — call shape
// ---------------------------------------------------------------------------

describe("runShell — spawnSync call shape", () => {
  it("passes the command string as first argument", () => {
    runShell("ls -la", "/project");
    expect(spawnSyncCalls[0].cmd).toBe("ls -la");
  });

  it("passes cwd in options", () => {
    runShell("echo test", "/my/dir");
    expect(spawnSyncCalls[0].opts.cwd).toBe("/my/dir");
  });

  it("passes encoding: utf-8 in options", () => {
    runShell("echo hello", "/project");
    expect(spawnSyncCalls[0].opts.encoding).toBe("utf-8");
  });

  it("uses default 30s timeout when none specified", () => {
    runShell("echo hello", "/project");
    expect(spawnSyncCalls[0].opts.timeout).toBe(30_000);
  });

  it("uses the provided timeout when specified", () => {
    runShell("npm test", "/project", 120_000);
    expect(spawnSyncCalls[0].opts.timeout).toBe(120_000);
  });

  it("passes maxBuffer option (512KB)", () => {
    runShell("echo hello", "/project");
    expect(spawnSyncCalls[0].opts.maxBuffer).toBe(512_000);
  });
});

// ---------------------------------------------------------------------------
// runShell — ProcessResult on success
// ---------------------------------------------------------------------------

describe("runShell — ProcessResult on success", () => {
  it("returns ok:true when exit status is 0", () => {
    spawnSyncImpl = () => ({ stdout: "done\n", stderr: "", status: 0, signal: null });
    const result = runShell("echo done", "/project");
    expect(result.ok).toBe(true);
  });

  it("returns stdout from spawnSync result", () => {
    spawnSyncImpl = () => ({ stdout: "output text\n", stderr: "", status: 0, signal: null });
    const result = runShell("cat file.txt", "/project");
    expect(result.stdout).toBe("output text\n");
  });

  it("returns stderr from spawnSync result", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "warning: deprecated\n", status: 0, signal: null });
    const result = runShell("npm install", "/project");
    expect(result.stderr).toBe("warning: deprecated\n");
  });

  it("returns exitCode: 0 on success", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 0, signal: null });
    const result = runShell("true", "/project");
    expect(result.exitCode).toBe(0);
  });

  it("returns timedOut:false on success", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 0, signal: null });
    const result = runShell("true", "/project");
    expect(result.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runShell — ProcessResult on failure
// ---------------------------------------------------------------------------

describe("runShell — ProcessResult on failure", () => {
  it("returns ok:false when exit status is non-zero", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "command not found", status: 127, signal: null });
    const result = runShell("nonexistent-command", "/project");
    expect(result.ok).toBe(false);
  });

  it("returns the correct non-zero exitCode", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "error", status: 2, signal: null });
    const result = runShell("false", "/project");
    expect(result.exitCode).toBe(2);
  });

  it("returns ok:false when spawnSync sets an error property", () => {
    spawnSyncImpl = () => ({
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
      error: new Error("spawn error"),
    });
    const result = runShell("echo hi", "/project");
    expect(result.ok).toBe(false);
  });

  it("uses exitCode 1 fallback when status is null", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: null, signal: null, error: new Error("ETIMEDOUT") });
    const result = runShell("sleep 100", "/project");
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runShell — timeout detection
// ---------------------------------------------------------------------------

describe("runShell — timeout detection", () => {
  it("sets timedOut:true when signal is SIGTERM", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: null, signal: "SIGTERM" });
    const result = runShell("sleep 100", "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:true when error message contains ETIMEDOUT", () => {
    const err = new Error("ETIMEDOUT");
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: null, signal: null, error: err });
    const result = runShell("sleep 100", "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:true when error message contains 'timed out'", () => {
    const err = new Error("process timed out");
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: null, signal: null, error: err });
    const result = runShell("sleep 100", "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:false for a normal failure (no timeout)", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "error", status: 1, signal: null });
    const result = runShell("false", "/project");
    expect(result.timedOut).toBe(false);
  });
});
