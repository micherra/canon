import { execFile } from "node:child_process";
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
export function gitExecAsync(args: string[], cwd: string, timeout = DEFAULT_TIMEOUT): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (err, stdout, stderr) => {
      if (err) {
        const rawCode = (err as any).code;
        // err.code can be a number (exit status) or a string (e.g. "ENOENT", "EACCES").
        // exitCode must always be a number; fall back to 1 for string codes.
        const exitCode = typeof rawCode === "number" ? rawCode : 1;
        const isTimedOut = (err as any).killed === true || rawCode === "ETIMEDOUT";
        // Include the string code in stderr when stderr is empty, for diagnostics.
        const diagnosticStderr = (stderr ?? "")
          || (typeof rawCode === "string" ? `${rawCode}: ${err.message}` : "");
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: diagnosticStderr,
          exitCode,
          timedOut: isTimedOut,
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
