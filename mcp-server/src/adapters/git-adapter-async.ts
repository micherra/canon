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
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: (err as any).code === "ETIMEDOUT" ? 1 : ((err as any).code ?? 1),
          timedOut: (err as any).killed === true || (err as any).code === "ETIMEDOUT",
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
