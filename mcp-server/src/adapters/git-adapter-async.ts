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
        const anyErr = err as any;
        const rawCode = anyErr.code;

        let exitCode: number;
        if (rawCode === "ETIMEDOUT") {
          exitCode = 1;
        } else if (typeof rawCode === "number") {
          exitCode = rawCode;
        } else if (typeof rawCode === "string") {
          const parsed = Number(rawCode);
          exitCode = Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : 1;
        } else {
          exitCode = 1;
        }

        const timedOut =
          anyErr.killed === true ||
          anyErr.signal === "SIGTERM" ||
          rawCode === "ETIMEDOUT";

        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
          timedOut,
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
