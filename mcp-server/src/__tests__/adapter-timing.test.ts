import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

// --- Shared spawnSync mock (used by git-adapter.ts and process-adapter.ts) ---

type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: string | null;
  error?: Error;
};

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

let spawnSyncImpl: (() => SpawnSyncResult) | null = null;
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
      cb(null, "", "");
    }
    return { pid: 99999 };
  },
  spawnSync: (_cmd: string, _argsOrOpts?: unknown, _opts?: unknown) => {
    if (spawnSyncImpl) return spawnSyncImpl();
    return { signal: null, status: 0, stderr: "", stdout: "" };
  },
}));

// Mock performance.now() so we can control timing values
let performanceNowValue = 0;
vi.mock("node:perf_hooks", () => ({
  performance: {
    now: () => performanceNowValue,
  },
}));

// Import after mocks

import { gitExec } from "../platform/adapters/git-adapter.ts";
import { gitExecAsync } from "../platform/adapters/git-adapter-async.ts";
import { runShell } from "../platform/adapters/process-adapter.ts";

beforeEach(() => {
  spawnSyncImpl = null;
  execFileImpl = null;
  performanceNowValue = 0;
});

// gitExec — duration_ms field

describe("gitExec — duration_ms timing", () => {
  it("returns duration_ms as a non-negative number on success", () => {
    // start=100, after call=250 → Math.round(150) = 150
    performanceNowValue = 100;
    spawnSyncImpl = () => {
      performanceNowValue = 250;
      return { signal: null, status: 0, stderr: "", stdout: "" };
    };
    const result = gitExec(["status"], "/project");
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("duration_ms reflects elapsed time from performance.now()", () => {
    performanceNowValue = 1000;
    spawnSyncImpl = () => {
      performanceNowValue = 1350;
      return { signal: null, status: 0, stderr: "", stdout: "" };
    };
    const result = gitExec(["log"], "/project");
    expect(result.duration_ms).toBe(350);
  });

  it("returns duration_ms on failed commands (non-zero exit)", () => {
    performanceNowValue = 0;
    spawnSyncImpl = () => {
      performanceNowValue = 80;
      return { signal: null, status: 128, stderr: "fatal error", stdout: "" };
    };
    const result = gitExec(["status"], "/notarepo");
    expect(result.ok).toBe(false);
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns duration_ms rounded to nearest integer", () => {
    performanceNowValue = 0;
    spawnSyncImpl = () => {
      performanceNowValue = 123.7;
      return { signal: null, status: 0, stderr: "", stdout: "" };
    };
    const result = gitExec(["status"], "/project");
    expect(result.duration_ms).toBe(124); // Math.round(123.7) = 124
  });

  it("returns duration_ms on timed-out commands", () => {
    performanceNowValue = 0;
    spawnSyncImpl = () => {
      performanceNowValue = 5000;
      return { signal: "SIGTERM", status: null, stderr: "", stdout: "" };
    };
    const result = gitExec(["log"], "/project", 5_000);
    expect(result.timedOut).toBe(true);
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBe(5000);
  });
});

// runShell — duration_ms field

describe("runShell — duration_ms timing", () => {
  it("returns duration_ms as a non-negative number on success", () => {
    performanceNowValue = 200;
    spawnSyncImpl = () => {
      performanceNowValue = 450;
      return { signal: null, status: 0, stderr: "", stdout: "hello\n" };
    };
    const result = runShell("echo hello", "/project");
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("duration_ms reflects elapsed time from performance.now()", () => {
    performanceNowValue = 500;
    spawnSyncImpl = () => {
      performanceNowValue = 700;
      return { signal: null, status: 0, stderr: "", stdout: "" };
    };
    const result = runShell("true", "/project");
    expect(result.duration_ms).toBe(200);
  });

  it("returns duration_ms on failed shell commands", () => {
    performanceNowValue = 0;
    spawnSyncImpl = () => {
      performanceNowValue = 30;
      return { signal: null, status: 127, stderr: "command not found", stdout: "" };
    };
    const result = runShell("nonexistent-cmd", "/project");
    expect(result.ok).toBe(false);
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns duration_ms on timed-out shell commands", () => {
    performanceNowValue = 0;
    spawnSyncImpl = () => {
      performanceNowValue = 10_000;
      return { signal: "SIGTERM", status: null, stderr: "", stdout: "" };
    };
    const result = runShell("sleep 30", "/project", 10_000);
    expect(result.timedOut).toBe(true);
    expect(result.duration_ms).toBe(10_000);
  });
});

// gitExecAsync — duration_ms field

describe("gitExecAsync — duration_ms timing", () => {
  it("returns duration_ms as a non-negative number on success", async () => {
    performanceNowValue = 100;
    execFileImpl = (cb) => {
      performanceNowValue = 300;
      cb(null, "output\n", "");
    };
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(true);
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("duration_ms reflects elapsed time from performance.now()", async () => {
    performanceNowValue = 1000;
    execFileImpl = (cb) => {
      performanceNowValue = 1600;
      cb(null, "", "");
    };
    const result = await gitExecAsync(["log"], "/project");
    expect(result.duration_ms).toBe(600);
  });

  it("returns duration_ms on failed async commands", async () => {
    performanceNowValue = 0;
    execFileImpl = (cb) => {
      performanceNowValue = 45;
      const err = Object.assign(new Error("fatal"), { code: 128 });
      cb(err, "", "fatal: not a git repo\n");
    };
    const result = await gitExecAsync(["status"], "/notarepo");
    expect(result.ok).toBe(false);
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns duration_ms rounded to nearest integer for async", async () => {
    performanceNowValue = 0;
    execFileImpl = (cb) => {
      performanceNowValue = 99.4;
      cb(null, "", "");
    };
    const result = await gitExecAsync(["status"], "/project");
    expect(result.duration_ms).toBe(99); // Math.round(99.4) = 99
  });

  it("returns duration_ms on timed-out async commands", async () => {
    performanceNowValue = 0;
    execFileImpl = (cb) => {
      performanceNowValue = 30_000;
      const err = Object.assign(new Error("Process killed"), { code: 1, killed: true });
      cb(err, "", "");
    };
    const result = await gitExecAsync(["log"], "/project", 30_000);
    expect(result.timedOut).toBe(true);
    expect(result.duration_ms).toBe(30_000);
  });
});
