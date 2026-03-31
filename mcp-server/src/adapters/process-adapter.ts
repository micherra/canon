import { spawnSync } from "node:child_process";
import type { ProcessResult } from "../utils/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_BYTES = 512_000; // 512KB output truncation

/**
 * Execute a shell command synchronously using spawnSync with shell: true.
 *
 * This adapter is for arbitrary shell commands (build scripts, gates, etc.).
 * For git operations use git-adapter.ts which enforces no shell: true.
 */
export function runShell(command: string, cwd: string, timeout = DEFAULT_TIMEOUT): ProcessResult {
  const result = spawnSync(command, {
    shell: true,
    cwd,
    encoding: "utf-8",
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
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
