import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: string | null;
  error?: Error;
};

type SpawnSyncCallRecord = {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
};

let spawnSyncImpl: (() => SpawnSyncResult) | null = null;
let spawnSyncCalls: SpawnSyncCallRecord[] = [];

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: unknown, opts?: unknown) => {
    // Handle both spawnSync(cmd, opts) and spawnSync(cmd, args, opts) overloads
    let resolvedArgs: string[];
    let resolvedOpts: Record<string, unknown>;
    if (Array.isArray(args)) {
      resolvedArgs = args as string[];
      resolvedOpts = (opts ?? {}) as Record<string, unknown>;
    } else {
      resolvedArgs = [];
      resolvedOpts = (args ?? {}) as Record<string, unknown>;
    }
    spawnSyncCalls.push({ args: resolvedArgs, cmd, opts: resolvedOpts });
    if (spawnSyncImpl) return spawnSyncImpl();
    return { signal: null, status: 0, stderr: "", stdout: "" };
  },
}));

// Import after mocks

import { gitDiff, gitExec, gitLog, gitStatus } from "../platform/adapters/git-adapter.ts";

beforeEach(() => {
  spawnSyncImpl = null;
  spawnSyncCalls = [];
});

// gitExec — basic call verification

describe("gitExec — spawnSync call shape", () => {
  it("calls spawnSync with 'git' as the command", () => {
    gitExec(["status"], "/project");
    expect(spawnSyncCalls).toHaveLength(1);
    expect(spawnSyncCalls[0].cmd).toBe("git");
  });

  it("passes args array directly as second argument", () => {
    gitExec(["log", "--oneline", "-5"], "/project");
    expect(spawnSyncCalls[0].args).toEqual(["log", "--oneline", "-5"]);
  });

  it("passes cwd in options", () => {
    gitExec(["status"], "/my/repo");
    expect(spawnSyncCalls[0].opts.cwd).toBe("/my/repo");
  });

  it("passes encoding: utf-8 in options", () => {
    gitExec(["status"], "/project");
    expect(spawnSyncCalls[0].opts.encoding).toBe("utf-8");
  });

  it("passes the provided timeout in options", () => {
    gitExec(["status"], "/project", 15_000);
    expect(spawnSyncCalls[0].opts.timeout).toBe(15_000);
  });

  it("uses default 30s timeout when none specified", () => {
    gitExec(["status"], "/project");
    expect(spawnSyncCalls[0].opts.timeout).toBe(30_000);
  });
});

// gitExec — SECURITY: shell MUST NOT be true

describe("gitExec — security: no shell:true", () => {
  it("does NOT pass shell:true in options", () => {
    gitExec(["status"], "/project");
    const opts = spawnSyncCalls[0].opts;
    expect(opts.shell).not.toBe(true);
  });

  it("does not even set shell property (or it is falsy)", () => {
    gitExec(["log"], "/project");
    const opts = spawnSyncCalls[0].opts;
    // shell must not be true — undefined or false are both acceptable
    expect(!!opts.shell).toBe(false);
  });
});

// gitExec — ProcessResult on success

describe("gitExec — ProcessResult on success (exit 0)", () => {
  it("returns ok:true when exit status is 0", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "main\n" });
    const result = gitExec(["branch"], "/project");
    expect(result.ok).toBe(true);
  });

  it("returns stdout from spawnSync result", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "hello\n" });
    const result = gitExec(["status"], "/project");
    expect(result.stdout).toBe("hello\n");
  });

  it("returns stderr from spawnSync result", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "warning\n", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.stderr).toBe("warning\n");
  });

  it("returns exitCode: 0 on success", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.exitCode).toBe(0);
  });

  it("returns timedOut:false on success", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.timedOut).toBe(false);
  });
});

// gitExec — ProcessResult on failure

describe("gitExec — ProcessResult on non-zero exit", () => {
  it("returns ok:false when exit status is non-zero", () => {
    spawnSyncImpl = () => ({
      signal: null,
      status: 128,
      stderr: "fatal: not a git repo",
      stdout: "",
    });
    const result = gitExec(["status"], "/notarepo");
    expect(result.ok).toBe(false);
  });

  it("returns the correct non-zero exitCode", () => {
    spawnSyncImpl = () => ({ signal: null, status: 128, stderr: "error", stdout: "" });
    const result = gitExec(["status"], "/notarepo");
    expect(result.exitCode).toBe(128);
  });

  it("returns ok:false when spawnSync sets an error property", () => {
    spawnSyncImpl = () => ({
      error: new Error("spawn error"),
      signal: null,
      status: 0,
      stderr: "",
      stdout: "",
    });
    const result = gitExec(["status"], "/project");
    expect(result.ok).toBe(false);
  });

  it("uses exitCode 1 fallback when status is null", () => {
    spawnSyncImpl = () => ({
      error: new Error("ETIMEDOUT"),
      signal: null,
      status: null,
      stderr: "",
      stdout: "",
    });
    const result = gitExec(["status"], "/project");
    expect(result.exitCode).toBe(1);
  });
});

// gitExec — timeout detection

describe("gitExec — timeout detection", () => {
  it("sets timedOut:true when signal is SIGTERM", () => {
    spawnSyncImpl = () => ({ signal: "SIGTERM", status: null, stderr: "", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:true when error message contains ETIMEDOUT", () => {
    const err = new Error("ETIMEDOUT");
    spawnSyncImpl = () => ({ error: err, signal: null, status: null, stderr: "", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:true when error message contains 'timed out'", () => {
    const err = new Error("process timed out");
    spawnSyncImpl = () => ({ error: err, signal: null, status: null, stderr: "", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:false when there is no timeout signal or error", () => {
    spawnSyncImpl = () => ({ signal: null, status: 1, stderr: "error", stdout: "" });
    const result = gitExec(["status"], "/project");
    expect(result.timedOut).toBe(false);
  });
});

// gitDiff — convenience wrapper

describe("gitDiff — convenience wrapper", () => {
  it("prepends 'diff' to the provided args", () => {
    gitDiff(["HEAD", "--", "src/"], "/project");
    expect(spawnSyncCalls[0].args).toEqual(["diff", "HEAD", "--", "src/"]);
  });

  it("calls spawnSync with 'git' as command", () => {
    gitDiff([], "/project");
    expect(spawnSyncCalls[0].cmd).toBe("git");
  });

  it("passes the timeout through to gitExec", () => {
    gitDiff(["HEAD"], "/project", 10_000);
    expect(spawnSyncCalls[0].opts.timeout).toBe(10_000);
  });
});

// gitStatus — convenience wrapper

describe("gitStatus — convenience wrapper", () => {
  it("passes ['status', '--porcelain'] as args", () => {
    gitStatus("/project");
    expect(spawnSyncCalls[0].args).toEqual(["status", "--porcelain"]);
  });

  it("calls spawnSync with 'git' as command", () => {
    gitStatus("/project");
    expect(spawnSyncCalls[0].cmd).toBe("git");
  });

  it("passes the cwd correctly", () => {
    gitStatus("/my/repo");
    expect(spawnSyncCalls[0].opts.cwd).toBe("/my/repo");
  });

  it("passes the timeout through when provided", () => {
    gitStatus("/project", 5_000);
    expect(spawnSyncCalls[0].opts.timeout).toBe(5_000);
  });
});

// gitLog — convenience wrapper

describe("gitLog — convenience wrapper", () => {
  it("passes correct args for git log with file paths", () => {
    gitLog(["file1.ts", "file2.ts"], 5, "/project");
    expect(spawnSyncCalls[0].args).toEqual([
      "log",
      "--oneline",
      "-n",
      "5",
      "--",
      "file1.ts",
      "file2.ts",
    ]);
  });

  it("calls spawnSync with 'git' as command", () => {
    gitLog(["src/foo.ts"], 10, "/project");
    expect(spawnSyncCalls[0].cmd).toBe("git");
  });

  it("uses 5000ms timeout by default", () => {
    gitLog(["src/foo.ts"], 5, "/project");
    expect(spawnSyncCalls[0].opts.timeout).toBe(5000);
  });

  it("passes explicit timeout override when provided", () => {
    gitLog(["src/foo.ts"], 5, "/project", 10_000);
    expect(spawnSyncCalls[0].opts.timeout).toBe(10_000);
  });

  it("passes cwd correctly", () => {
    gitLog(["src/foo.ts"], 3, "/my/repo");
    expect(spawnSyncCalls[0].opts.cwd).toBe("/my/repo");
  });

  it("uses the provided maxCount as the -n argument (string)", () => {
    gitLog(["file.ts"], 15, "/project");
    const nIdx = spawnSyncCalls[0].args.indexOf("-n");
    expect(nIdx).toBeGreaterThan(-1);
    expect(spawnSyncCalls[0].args[nIdx + 1]).toBe("15");
  });

  it("handles empty file paths array (log of all files)", () => {
    gitLog([], 5, "/project");
    expect(spawnSyncCalls[0].args).toEqual(["log", "--oneline", "-n", "5", "--"]);
  });
});
