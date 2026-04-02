import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessResult } from "../utils/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;

function buildErrorResult(err: Error, stdout: string | null, stderr: string | null, durationMs: number): ProcessResult {
  const errWithCode = err as Error & { code?: number | string; killed?: boolean };
  const rawCode = errWithCode.code;
  // err.code can be a number (exit status) or a string (e.g. "ENOENT", "EACCES").
  // exitCode must always be a number; fall back to 1 for string codes.
  const exitCode = typeof rawCode === "number" ? rawCode : 1;
  const isTimedOut = errWithCode.killed === true || rawCode === "ETIMEDOUT";
  // Include the string code in stderr when stderr is empty, for diagnostics.
  const diagnosticStderr = (stderr ?? "") || (typeof rawCode === "string" ? `${rawCode}: ${err.message}` : "");
  return {
    ok: false,
    stdout: stdout ?? "",
    stderr: diagnosticStderr,
    exitCode,
    timedOut: isTimedOut,
    duration_ms: durationMs,
  };
}

function buildSuccessResult(stdout: string | null, stderr: string | null, durationMs: number): ProcessResult {
  return {
    ok: true,
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    exitCode: 0,
    timedOut: false,
    duration_ms: durationMs,
  };
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
  const start = performance.now();
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (err, stdout, stderr) => {
      const durationMs = Math.round(performance.now() - start);
      if (err) {
        resolve(buildErrorResult(err, stdout, stderr, durationMs));
        return;
      }
      resolve(buildSuccessResult(stdout, stderr, durationMs));
    });
  });
}
