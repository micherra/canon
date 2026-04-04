import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessResult } from "../utils/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;

/**
 * Execute a git command asynchronously using execFile wrapped in a Promise.
 *
 * This adapter is for callers that need async/await patterns (e.g. codebase-graph,
 * pr-review-data). It never rejects — errors are returned as ProcessResult with ok:false.
 *
 * SECURITY: Uses array args like git-adapter.ts — no shell: true.
 */
/** Build a ProcessResult from an execFile error callback. */
function buildErrorResult(
  err: Error,
  stdout: string | null,
  stderr: string | null,
  duration_ms: number,
): ProcessResult {
  const rawCode = (err as NodeJS.ErrnoException & { killed?: boolean }).code;
  // err.code can be a number (exit status) or a string (e.g. "ENOENT", "EACCES").
  // exitCode must always be a number; fall back to 1 for string codes.
  const exitCode = typeof rawCode === "number" ? rawCode : 1;
  const isTimedOut =
    (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    rawCode === "ETIMEDOUT";
  // Include the string code in stderr when stderr is empty, for diagnostics.
  const diagnosticStderr =
    (stderr ?? "") || (typeof rawCode === "string" ? `${rawCode}: ${err.message}` : "");
  return {
    duration_ms,
    exitCode,
    ok: false,
    stderr: diagnosticStderr,
    stdout: stdout ?? "",
    timedOut: isTimedOut,
  };
}

export function gitExecAsync(
  args: string[],
  cwd: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<ProcessResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (err, stdout, stderr) => {
      const duration_ms = Math.round(performance.now() - start);
      if (err) {
        resolve(buildErrorResult(err, stdout, stderr, duration_ms));
        return;
      }
      resolve({
        duration_ms,
        exitCode: 0,
        ok: true,
        stderr: stderr ?? "",
        stdout: stdout ?? "",
        timedOut: false,
      });
    });
  });
}
