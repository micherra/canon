import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

type ExecFileCallRecord = {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
};

let execFileImpl: ((cb: ExecFileCallback) => void) | null = null;
let execFileCalls: ExecFileCallRecord[] = [];

vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], opts: Record<string, unknown>, cb: ExecFileCallback) => {
    execFileCalls.push({ args, cmd, opts });
    if (execFileImpl) {
      execFileImpl(cb);
    } else {
      cb(null, "", "");
    }
    // Return a fake child process handle (not used)
    return { pid: 12345 };
  },
}));

// Import after mocks

import { gitExecAsync } from "../adapters/git-adapter-async.ts";

beforeEach(() => {
  execFileImpl = null;
  execFileCalls = [];
});

// gitExecAsync — call shape

describe("gitExecAsync — execFile call shape", () => {
  it("calls execFile with 'git' as the command", async () => {
    await gitExecAsync(["status"], "/project");
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe("git");
  });

  it("passes args array as second argument", async () => {
    await gitExecAsync(["log", "--oneline", "-5"], "/project");
    expect(execFileCalls[0].args).toEqual(["log", "--oneline", "-5"]);
  });

  it("passes cwd in options", async () => {
    await gitExecAsync(["status"], "/my/repo");
    expect(execFileCalls[0].opts.cwd).toBe("/my/repo");
  });

  it("passes the provided timeout in options", async () => {
    await gitExecAsync(["status"], "/project", 15_000);
    expect(execFileCalls[0].opts.timeout).toBe(15_000);
  });

  it("uses default 30s timeout when none specified", async () => {
    await gitExecAsync(["status"], "/project");
    expect(execFileCalls[0].opts.timeout).toBe(30_000);
  });
});

// gitExecAsync — resolves with ok:true on success

describe("gitExecAsync — resolves ok:true on success", () => {
  it("resolves with ok:true when no error", async () => {
    execFileImpl = (cb) => cb(null, "output\n", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(true);
  });

  it("resolves with stdout from callback", async () => {
    execFileImpl = (cb) => cb(null, "branch: main\n", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.stdout).toBe("branch: main\n");
  });

  it("resolves with stderr from callback (even on success)", async () => {
    execFileImpl = (cb) => cb(null, "", "some warning\n");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.stderr).toBe("some warning\n");
  });

  it("resolves with exitCode: 0 on success", async () => {
    execFileImpl = (cb) => cb(null, "", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.exitCode).toBe(0);
  });

  it("resolves with timedOut: false on success", async () => {
    execFileImpl = (cb) => cb(null, "", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.timedOut).toBe(false);
  });
});

// gitExecAsync — resolves with ok:false on error (never rejects)

describe("gitExecAsync — resolves ok:false on error (never rejects)", () => {
  it("resolves (not rejects) with ok:false when error is provided", async () => {
    const err = Object.assign(new Error("fatal: not a git repo"), { code: 128 });
    execFileImpl = (cb) => cb(err, "", "fatal: not a git repo\n");
    // Must not throw
    const result = await gitExecAsync(["status"], "/notarepo");
    expect(result.ok).toBe(false);
  });

  it("includes stdout and stderr from error callback", async () => {
    const err = Object.assign(new Error("error"), { code: 1 });
    execFileImpl = (cb) => cb(err, "partial output", "error text");
    const result = await gitExecAsync(["log"], "/project");
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toBe("error text");
  });

  it("never rejects — always resolves", async () => {
    const err = new Error("unexpected spawn error");
    execFileImpl = (cb) => cb(err, "", "");
    // Should resolve, not throw
    await expect(gitExecAsync(["status"], "/project")).resolves.toBeDefined();
  });
});

// gitExecAsync — timeout detection

describe("gitExecAsync — timeout detection", () => {
  it("sets timedOut:true when error has killed:true", async () => {
    const err = Object.assign(new Error("Process killed"), { code: 1, killed: true });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["log"], "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:true when error code is ETIMEDOUT", async () => {
    const err = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["log"], "/project");
    expect(result.timedOut).toBe(true);
  });

  it("sets timedOut:false for a regular non-zero exit", async () => {
    const err = Object.assign(new Error("exit code 1"), { code: 1, killed: false });
    execFileImpl = (cb) => cb(err, "", "error output");
    const result = await gitExecAsync(["log"], "/project");
    expect(result.timedOut).toBe(false);
  });
});
