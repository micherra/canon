/**
 * ADR-002 Integration Tests (Part 1)
 *
 * Tests the contracts that implementors could not test at the unit level:
 *
 * 1. ProcessResult shape contract: all 5 fields present across both adapters
 * 2. Security boundary: gitExec never has shell, runShell always has shell
 * 3. Contract-checker adapter routing: file_changed uses gitExec (no shell),
 *    bash_check uses runShell (shell: true) — unit-level mock verification
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Section 1: ProcessResult shape contract
// Both adapters must return an object with all 5 ProcessResult fields.
// These tests import the adapters through mocked child_process.

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
    // Handle both spawnSync(cmd, opts) and spawnSync(cmd, args, opts) overloads
    const opts = Array.isArray(argsOrOpts) ? (optsArg ?? {}) : (argsOrOpts ?? {});
    lastSpawnSyncOpts = opts as Record<string, unknown>;
    if (spawnSyncImpl) return spawnSyncImpl();
    return { signal: null, status: 0, stderr: "", stdout: "" };
  },
}));

import { gitDiff, gitExec, gitStatus } from "@platform/adapters/git-adapter.ts";
import { gitExecAsync } from "@platform/adapters/git-adapter-async.ts";
import { runShell } from "@platform/adapters/process-adapter.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

beforeEach(() => {
  spawnSyncImpl = null;
  execFileImpl = null;
  lastSpawnSyncOpts = {};
});

// 1. ProcessResult shape contract

describe("ProcessResult shape contract — gitExec", () => {
  it("returns all 5 required fields on the success path", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "warn\n", stdout: "main\n" });
    const result = gitExec(["branch"], "/project");
    // All 5 fields must be present and correctly typed
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("returns all 5 required fields on the error path", () => {
    spawnSyncImpl = () => ({ signal: null, status: 128, stderr: "fatal error", stdout: "" });
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
      signal: null,
      status: 0,
      stderr: null as unknown as string,
      stdout: null as unknown as string,
    });
    const result = gitExec(["status"], "/project");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("ProcessResult shape contract — runShell", () => {
  it("returns all 5 required fields on the success path", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "output\n" });
    const result = runShell("echo hello", "/project");
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("returns all 5 required fields on the error path", () => {
    spawnSyncImpl = () => ({ signal: null, status: 127, stderr: "command not found", stdout: "" });
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
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "file.ts\n" });
    const result = gitDiff(["HEAD~1", "HEAD"], "/project");
    const fields: Array<keyof ProcessResult> = ["ok", "stdout", "stderr", "exitCode", "timedOut"];
    for (const field of fields) {
      expect(field in result).toBe(true);
    }
  });

  it("gitStatus shapes match ProcessResult contract (convenience wrapper)", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "M file.ts\n" });
    const result = gitStatus("/project");
    const fields: Array<keyof ProcessResult> = ["ok", "stdout", "stderr", "exitCode", "timedOut"];
    for (const field of fields) {
      expect(field in result).toBe(true);
    }
  });
});

// 2. Security boundary: gitExec never sets shell; runShell always sets shell

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

// 3. Contract-checker adapter routing
// Declared Known Gap in adr002-02: "contract-checker.ts adapter routing is
// verified via integration tests only (no unit-level mock verifying gitExec
// vs runShell routing)".
//
// We use a fresh vi.doMock approach here to isolate the module under test.

describe("Contract-checker adapter routing — gitExec used for file_changed (not runShell)", () => {
  it("file_changed assertion calls gitExec (array args) — no shell injection possible", async () => {
    // We verify that the gitExec mock is called (not runShell) for file_changed.
    // This test uses vitest's module isolation: import fresh copies with doMock.
    const gitExecCalls: { args: string[]; cwd: string }[] = [];
    const runShellCalls: { cmd: string; cwd: string }[] = [];

    vi.doMock("@platform/adapters/git-adapter.ts", () => ({
      gitDiff: vi.fn(),
      gitExec: (args: string[], cwd: string) => {
        gitExecCalls.push({ args, cwd });
        // Simulate 'file changed' — non-empty stdout means changed
        return { exitCode: 0, ok: true, stderr: "", stdout: "initial.ts\n", timedOut: false };
      },
      gitStatus: vi.fn(),
    }));

    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: (cmd: string, cwd: string) => {
        runShellCalls.push({ cmd, cwd });
        return { exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false };
      },
    }));

    vi.resetModules();
    const { evaluatePostconditions } = await import("../services/contract-checker.ts");

    const results = evaluatePostconditions(
      [{ target: "initial.ts", type: "file_changed" }],
      "/project",
      "abc1234",
    );

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    // gitExec was called (array args routing — no shell)
    expect(gitExecCalls).toHaveLength(1);
    expect(Array.isArray(gitExecCalls[0].args)).toBe(true);
    expect(gitExecCalls[0].args).toContain("diff");
    expect(gitExecCalls[0].args).toContain("initial.ts");
    // runShell was NOT called for file_changed
    expect(runShellCalls).toHaveLength(0);

    vi.doUnmock("../../../platform/adapters/git-adapter.ts");
    vi.doUnmock("../../../platform/adapters/process-adapter.ts");
  });

  it("bash_check assertion calls runShell (shell: true) — not gitExec", async () => {
    const gitExecCalls: string[][] = [];
    const runShellCalls: string[] = [];

    vi.doMock("@platform/adapters/git-adapter.ts", () => ({
      gitDiff: vi.fn(),
      gitExec: (args: string[]) => {
        gitExecCalls.push(args);
        return { exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false };
      },
      gitStatus: vi.fn(),
    }));

    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: (cmd: string) => {
        runShellCalls.push(cmd);
        return { exitCode: 0, ok: true, stderr: "", stdout: "test passed", timedOut: false };
      },
    }));

    vi.resetModules();
    const { evaluatePostconditions } = await import("../services/contract-checker.ts");

    const results = evaluatePostconditions(
      [{ command: "echo ok", type: "bash_check" }],
      "/project",
    );

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    // runShell was called for bash_check
    expect(runShellCalls).toHaveLength(1);
    expect(runShellCalls[0]).toBe("echo ok");
    // gitExec was NOT called for bash_check
    expect(gitExecCalls).toHaveLength(0);

    vi.doUnmock("../../../platform/adapters/git-adapter.ts");
    vi.doUnmock("../../../platform/adapters/process-adapter.ts");
  });
});
