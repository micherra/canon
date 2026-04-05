import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

type ForkOptions = {
  stdio: unknown;
  execArgv?: string[];
};

let forkImpl: ((path: string, args: string[], opts: ForkOptions) => MockChildProcess) | null = null;

class MockChildProcess {
  private listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();
  killed = false;
  exitCode: number | null = null;
  pid = 12345;
  stdin = null;
  stdout = { on: vi.fn() };
  stderr = { on: vi.fn() };

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  send(msg: unknown): boolean {
    // Capture sent messages for assertion
    this.emit("_sent", msg);
    return true;
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 143;
    // Emit exit event synchronously for test
    this.emit("exit", this.exitCode, signal ?? null);
    return true;
  }
}

let lastChild: MockChildProcess | null = null;

vi.mock("node:child_process", () => ({
  fork: (path: string, args: string[], opts: ForkOptions) => {
    const child = forkImpl ? forkImpl(path, args, opts) : new MockChildProcess();
    lastChild = child;
    return child;
  },
}));

// Import after mocks

import type { JobMessage, WorkerInput } from "../job-adapter.ts";
import { forkJob, killJob, sendWorkerInput } from "../job-adapter.ts";

beforeEach(() => {
  forkImpl = null;
  lastChild = null;
});

// forkJob — spawns a child process

describe("forkJob — spawns a child process", () => {
  it("returns a ChildProcess handle", () => {
    const child = forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/path/to/worker.ts",
    });
    expect(child).toBeDefined();
    expect(child.pid).toBe(12345);
  });

  it("calls fork with the provided workerPath", () => {
    let capturedPath = "";
    forkImpl = (path) => {
      capturedPath = path;
      return new MockChildProcess();
    };

    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/workers/graph-worker.ts",
    });

    expect(capturedPath).toBe("/workers/graph-worker.ts");
  });

  it("calls fork with ipc in stdio", () => {
    let capturedOpts: ForkOptions | null = null;
    forkImpl = (_, __, opts) => {
      capturedOpts = opts;
      return new MockChildProcess();
    };

    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/workers/graph-worker.ts",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((capturedOpts as any)?.stdio).toContain("ipc");
  });

  it("calls onMessage when child emits a message", () => {
    const onMessage = vi.fn();
    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage,
      workerPath: "/worker.ts",
    });

    const msg: JobMessage = { current: 1, phase: "scan", total: 10, type: "progress" };
    lastChild!.emit("message", msg);

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("calls onExit when child exits", () => {
    const onExit = vi.fn();
    forkJob({
      cwd: "/mock/cwd",
      onExit,
      onMessage: vi.fn(),
      workerPath: "/worker.ts",
    });

    lastChild!.emit("exit", 0, null);

    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it("registers drain handlers on stdout and stderr to prevent pipe backpressure", () => {
    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/worker.ts",
    });

    // stdout.on and stderr.on should each be called with 'data' and a noop handler
    expect(lastChild!.stdout.on).toHaveBeenCalledWith("data", expect.any(Function));
    expect(lastChild!.stderr.on).toHaveBeenCalledWith("data", expect.any(Function));
  });

  it("calls onMessage with error message when child emits error", () => {
    const onMessage = vi.fn();
    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage,
      workerPath: "/worker.ts",
    });

    const err = new Error("spawn error");
    lastChild!.emit("error", err);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "spawn error", type: "error" }),
    );
  });
});

// sendWorkerInput — delivers message to child

describe("sendWorkerInput — delivers message to child", () => {
  it("sends the WorkerInput to the child via IPC", () => {
    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/worker.ts",
    });

    const sentMessages: unknown[] = [];
    lastChild!.on("_sent", (msg) => sentMessages.push(msg));

    const input: WorkerInput = {
      dbPath: "/my/project/.canon/knowledge-graph.db",
      projectDir: "/my/project",
      sourceDirs: ["src"],
      type: "start",
    };

    sendWorkerInput(lastChild as unknown as ChildProcess, input);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual(input);
  });
});

// killJob — terminates child process

describe("killJob — terminates child process", () => {
  it("kills the child with SIGTERM when not already killed", () => {
    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/worker.ts",
    });

    expect(lastChild!.killed).toBe(false);
    killJob(lastChild as unknown as ChildProcess, 100);
    expect(lastChild!.killed).toBe(true);
  });

  it("does not kill an already-killed child", () => {
    forkJob({
      cwd: "/mock/cwd",
      onExit: vi.fn(),
      onMessage: vi.fn(),
      workerPath: "/worker.ts",
    });

    // Pre-kill
    lastChild!.killed = true;
    lastChild!.exitCode = 0;

    const killSpy = vi.spyOn(lastChild! as unknown as ChildProcess, "kill");
    killJob(lastChild as unknown as ChildProcess, 100);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
