import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFile, spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_BYTES = 512_000; // 512KB output truncation

/**
 * Open a URL in the default system browser. Fire-and-forget — platform-aware.
 * Uses execFile with an args array (no shell) to prevent command injection.
 */
export function openBrowser(url: string): void {
  let file: string;
  let args: string[];
  if (process.platform === "darwin") {
    file = "open";
    args = [url];
  } else if (process.platform === "win32") {
    file = "cmd";
    args = ["/c", "start", "", url];
  } else {
    file = "xdg-open";
    args = [url];
  }

  execFile(file, args, (err) => {
    if (err) {
      process.stderr.write(`[openBrowser] browser open failed: ${err.message}\n`);
    }
  });
}

/**
 * Execute a shell command synchronously using spawnSync with shell: true.
 *
 * This adapter is for arbitrary shell commands (build scripts, gates, etc.).
 * For git operations use git-adapter.ts which enforces no shell: true.
 */
export function runShell(command: string, cwd: string, timeout = DEFAULT_TIMEOUT): ProcessResult {
  const start = performance.now();
  const result = spawnSync(command, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: true,
    timeout,
  });
  const duration_ms = Math.round(performance.now() - start);

  // When stderr is empty but result.error exists (e.g., ENOENT spawn failure),
  // incorporate result.error.message so callers get diagnostic information.
  const rawStderr = result.stderr ?? "";
  const stderr = rawStderr || (result.error ? result.error.message : "");

  return {
    duration_ms,
    exitCode: result.status ?? 1,
    ok: result.status === 0 && !result.error,
    stderr,
    stdout: result.stdout ?? "",
    timedOut:
      result.error?.message?.includes("ETIMEDOUT") === true ||
      result.error?.message?.includes("timed out") === true ||
      result.signal === "SIGTERM",
  };
}

/** Function shape of `node:child_process`'s `spawn` — the injectable seam callers use. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Raw passthrough to `node:child_process`'s `spawn` — the sole non-shell,
 * non-git subprocess launch primitive besides `runShell`/`execFile`/`spawnSync`
 * above. Exists so callers elsewhere in the codebase (e.g. the T2
 * live-forward-checker recorder trigger, `services/t2-recorder-trigger.ts`)
 * can compose a detached, fire-and-forget process launch without importing
 * `node:child_process` directly — ADR-002 confines `child_process` imports to
 * this directory. The caller owns all spawn-option semantics (detached,
 * stdio, error handling, unref); this function performs zero bookkeeping
 * of its own.
 *
 * Deliberately a wrapper function, not `= spawn` directly — reading `spawn`
 * eagerly at module-eval time throws in any test that mocks
 * `node:child_process` without providing every export this module imports
 * (`execFile`/`spawnSync`); a lazy call site only touches the real binding
 * when `spawnProcess` is actually invoked.
 */
export const spawnProcess: SpawnFn = (command, args, options) => spawn(command, args, options);
