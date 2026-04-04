import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessResult } from "../shared/lib/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;

/**
 * Execute a git command synchronously using spawnSync with array args.
 *
 * SECURITY: shell is NEVER set to true here — git commands always use
 * array args to prevent shell injection.
 */
export function gitExec(args: string[], cwd: string, timeout = DEFAULT_TIMEOUT): ProcessResult {
  const start = performance.now();
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
  });
  const duration_ms = Math.round(performance.now() - start);

  return {
    duration_ms,
    exitCode: result.status ?? 1,
    ok: result.status === 0 && !result.error,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
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

/**
 * Convenience wrapper: runs `git log --oneline -n <maxCount> -- <filePaths>`.
 *
 * Uses a 5s timeout (not the 30s default) since git log on scoped files is fast.
 *
 * SECURITY NOTE: This function returns raw ProcessResult. All agent-sourced text
 * in the output (e.g., commit messages) must be escaped via escapeDollarBrace
 * before prompt injection. The caller is responsible for escaping.
 */
export function gitLog(
  filePaths: string[],
  maxCount: number,
  cwd: string,
  timeout?: number,
): ProcessResult {
  return gitExec(
    ["log", "--oneline", `-n`, String(maxCount), "--", ...filePaths],
    cwd,
    timeout ?? 5000,
  );
}

/** Options for creating a git worktree. */
export type GitWorktreeAddOptions = {
  branchName: string;
  baseCommit: string;
  timeout?: number;
};

/** Convenience wrapper: runs `git worktree add`. */
export function gitWorktreeAdd(
  worktreePath: string,
  cwd: string,
  options: GitWorktreeAddOptions,
): ProcessResult {
  const { branchName, baseCommit, timeout } = options;
  return gitExec(["worktree", "add", worktreePath, "-b", branchName, baseCommit], cwd, timeout);
}
