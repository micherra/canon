import { type ExecFileException, execFile } from "node:child_process";
import type { ProcessResult } from "../utils/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;

/** Resolve the exit code from an execFile error, normalizing string/number/missing codes. */
function resolveExitCode(rawCode: string | number | null | undefined): number {
  if (rawCode === "ETIMEDOUT") return 1;
  if (typeof rawCode === "number") return rawCode;
  if (typeof rawCode === "string") {
    const parsed = Number(rawCode);
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : 1;
  }
  return 1;
}

/** Detect whether the error represents a timeout (killed, SIGTERM, or ETIMEDOUT). */
function isTimedOut(err: ExecFileException): boolean {
  return err.killed === true || err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
}

/**
 * Execute a git command asynchronously using execFile wrapped in a Promise.
 *
 * This adapter is for callers that need async/await patterns (e.g. codebase-graph,
 * pr-review-data). It never rejects — errors are returned as ProcessResult with ok:false.
 *
 * SECURITY: Uses array args like git-adapter.ts — no shell: true.
 */
export function gitExecAsync(args: string[], cwd: string, timeout = DEFAULT_TIMEOUT): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (err, stdout, stderr) => {
      if (err) {
        const anyErr = err as ExecFileException;
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: resolveExitCode(anyErr.code),
          timedOut: isTimedOut(anyErr),
        });
        return;
      }
      resolve({
        ok: true,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: 0,
        timedOut: false,
      });
    });
  });
}
