import { spawnSync } from "node:child_process";
import type { ProcessResult } from "../utils/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;

/**
 * Execute a git command synchronously using spawnSync with array args.
 *
 * SECURITY: shell is NEVER set to true here — git commands always use
 * array args to prevent shell injection.
 */
export function gitExec(args: string[], cwd: string, timeout = DEFAULT_TIMEOUT): ProcessResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
  });

  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
    timedOut:
      result.error?.message?.includes("ETIMEDOUT") === true ||
      result.error?.message?.includes("timed out") === true ||
      result.signal === "SIGTERM",
  };
}

/** Convenience wrapper: runs `git diff [args]`. */
export function gitDiff(args: string[], cwd: string, timeout?: number): ProcessResult {
  return gitExec(["diff", ...args], cwd, timeout);
}

/** Convenience wrapper: runs `git status --porcelain`. */
export function gitStatus(cwd: string, timeout?: number): ProcessResult {
  return gitExec(["status", "--porcelain"], cwd, timeout);
}
