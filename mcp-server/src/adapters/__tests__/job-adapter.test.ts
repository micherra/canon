import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { forkJob, sendWorkerInput, killJob } from "../job-adapter.ts";
import type { JobMessage, WorkerInput } from "../job-adapter.ts";

beforeEach(() => {
  forkImpl = null;
  lastChild = null;
});

// ---------------------------------------------------------------------------
// forkJob — spawns a child process
// ---------------------------------------------------------------------------

describe("forkJob — spawns a child process", () => {
  it("returns a ChildProcess handle", () => {
    const child = forkJob({
      workerPath: "/path/to/worker.ts",
      onMessage: vi.fn(),
      onExit: vi.fn(),
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
      workerPath: "/workers/graph-worker.ts",
      onMessage: vi.fn(),
      onExit: vi.fn(),
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
      workerPath: "/workers/graph-worker.ts",
      onMessage: vi.fn(),
      onExit: vi.fn(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((capturedOpts as any)?.stdio).toContain("ipc");
  });

  it("calls onMessage when child emits a message", () => {
    const onMessage = vi.fn();
    forkJob({
      workerPath: "/worker.ts",
      onMessage,
      onExit: vi.fn(),
    });

    const msg: JobMessage = { type: "progress", phase: "scan", current: 1, total: 10 };
    lastChild!.emit("message", msg);

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("calls onExit when child exits", () => {
    const onExit = vi.fn();
    forkJob({
      workerPath: "/worker.ts",
      onMessage: vi.fn(),
      onExit,
    });

    lastChild!.emit("exit", 0, null);

    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it("calls onMessage with error message when child emits error", () => {
    const onMessage = vi.fn();
    forkJob({
      workerPath: "/worker.ts",
      onMessage,
      onExit: vi.fn(),
    });

    const err = new Error("spawn error");
    lastChild!.emit("error", err);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "spawn error" }),
    );
  });
});

// ---------------------------------------------------------------------------
// sendWorkerInput — delivers message to child
// ---------------------------------------------------------------------------

describe("sendWorkerInput — delivers message to child", () => {
  it("sends the WorkerInput to the child via IPC", () => {
    forkJob({
      workerPath: "/worker.ts",
      onMessage: vi.fn(),
      onExit: vi.fn(),
    });

    const sentMessages: unknown[] = [];
    lastChild!.on("_sent", (msg) => sentMessages.push(msg));

    const input: WorkerInput = {
      type: "start",
      projectDir: "/my/project",
      dbPath: "/my/project/.canon/knowledge-graph.db",
      sourceDirs: ["src"],
    };

    sendWorkerInput(lastChild as unknown as ChildProcess, input);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// killJob — terminates child process
// ---------------------------------------------------------------------------

describe("killJob — terminates child process", () => {
  it("kills the child with SIGTERM when not already killed", () => {
    forkJob({
      workerPath: "/worker.ts",
      onMessage: vi.fn(),
      onExit: vi.fn(),
    });

    expect(lastChild!.killed).toBe(false);
    killJob(lastChild as unknown as ChildProcess, 100);
    expect(lastChild!.killed).toBe(true);
  });

  it("does not kill an already-killed child", () => {
    forkJob({
      workerPath: "/worker.ts",
      onMessage: vi.fn(),
      onExit: vi.fn(),
    });

    // Pre-kill
    lastChild!.killed = true;
    lastChild!.exitCode = 0;

    const killSpy = vi.spyOn(lastChild! as unknown as ChildProcess, "kill");
    killJob(lastChild as unknown as ChildProcess, 100);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
