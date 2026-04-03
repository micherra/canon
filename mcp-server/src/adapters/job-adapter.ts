import { fork, type ChildProcess } from "node:child_process";

/** Message types sent from child to parent via IPC. */
export interface JobProgressMessage {
  type: "progress";
  phase: string;
  current: number;
  total: number;
}

export interface JobCompleteMessage {
  type: "complete";
  result: Record<string, unknown>;
}

export interface JobErrorMessage {
  type: "error";
  message: string;
  stack?: string;
}

export type JobMessage = JobProgressMessage | JobCompleteMessage | JobErrorMessage;

/** Input passed to the worker process via IPC after fork. */
export interface WorkerInput {
  type: "start";
  projectDir: string;
  dbPath: string;
  sourceDirs?: string[];
  /** File extensions to include when scanning (forwarded from CodebaseGraphInput). */
  include_extensions?: string[];
  /** Directories to exclude when scanning (forwarded from CodebaseGraphInput). */
  exclude_dirs?: string[];
}

export interface ForkJobOptions {
  workerPath: string;
  onMessage: (msg: JobMessage) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

/**
 * Fork a child process to run a background job.
 * Returns the ChildProcess handle for tracking.
 *
 * The caller sends a WorkerInput message after fork to start work.
 * The child sends JobMessage back via IPC.
 */
export function forkJob(options: ForkJobOptions): ChildProcess {
  const child = fork(options.workerPath, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Ensure the child can resolve TypeScript modules
    execArgv: ["--import", "tsx"],
  });

  // Drain stdout/stderr to prevent pipe backpressure from blocking the child
  // (stdio is ['ignore','pipe','pipe','ipc'], so pipes must be consumed).
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  child.on("message", (msg: unknown) => {
    options.onMessage(msg as JobMessage);
  });

  child.on("exit", (code, signal) => {
    options.onExit(code, signal);
  });

  child.on("error", (err) => {
    options.onMessage({ type: "error", message: err.message, stack: err.stack });
  });

  return child;
}

/** Send the start command to a forked worker. */
export function sendWorkerInput(child: ChildProcess, input: WorkerInput): void {
  child.send(input);
}

/** Kill a child process gracefully (SIGTERM), then force (SIGKILL) after timeout. */
export function killJob(child: ChildProcess, gracePeriodMs = 5000): void {
  if (!child.killed && child.exitCode === null) {
    child.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, gracePeriodMs);
    child.on("exit", () => clearTimeout(forceTimer));
  }
}
