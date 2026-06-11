import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

/**
 * Resolve the git repository root from a given directory.
 *
 * Returns the git toplevel path when the directory is inside a git repo;
 * returns the raw `cwd` when git is unavailable or the directory is not a
 * git repo.  Accepts an injected `gitTopLevelFn` for testability.
 *
 * @param cwd          - Directory to resolve from (usually process.cwd())
 * @param gitTopLevelFn - Injected function that runs `git rev-parse --show-toplevel`
 */
export function resolveGitRoot(
  cwd: string,
  gitTopLevelFn: (args: string[], cwd: string) => ProcessResult,
): string {
  try {
    const result = gitTopLevelFn(["rev-parse", "--show-toplevel"], cwd);
    if (result.ok) return result.stdout.trim();
  } catch (err) {
    console.error(
      "[canon] git root resolution failed, using cwd fallback:",
      err instanceof Error ? err.message : err,
    );
  }
  return cwd;
}

/**
 * Resolve the project directory using the MCP roots priority chain.
 *
 * Priority:
 *   1. CANON_PROJECT_DIR env var (only when set AND is an absolute path)
 *   2. roots/list first root from MCP client
 *   3. cwdFallback
 *
 * @param canonProjectDir - Value of CANON_PROJECT_DIR env var (may be undefined or relative)
 * @param listRootsFn     - Injected function to call the MCP roots/list endpoint
 * @param cwdFallback     - Fallback path when roots cannot be resolved
 */
export async function resolveProjectDir(
  canonProjectDir: string | undefined,
  listRootsFn: () => Promise<{ roots: Array<{ uri: string; name?: string }> }>,
  cwdFallback: string,
): Promise<string> {
  // Priority 1: explicit absolute path override — validate before trusting.
  // Explicit token reject: ${...} tokens indicate the harness did not expand the variable.
  // isAbsolute() already rejects the bare ${VAR} form (non-absolute), but an absolute path
  // containing a token mid-segment (e.g. "/some/${VAR}/path") would slip through without this
  // check. Reject both forms for defense-in-depth and log clearly so the cause is obvious.
  if (canonProjectDir && /\$\{[^}]*\}/.test(canonProjectDir)) {
    console.warn(
      `[canon] CANON_PROJECT_DIR ignored — contains an unexpanded token: ${canonProjectDir}`,
    );
  } else if (canonProjectDir && isAbsolute(canonProjectDir)) {
    console.error(`[canon] project dir from CANON_PROJECT_DIR: ${canonProjectDir}`);
    return canonProjectDir;
  }

  // Priority 2: first root from MCP client.
  try {
    const result = await listRootsFn();
    const firstRoot = result.roots[0];
    if (firstRoot?.uri) {
      const dir = fileURLToPath(firstRoot.uri);
      console.error(`[canon] project dir from MCP roots: ${dir}`);
      return dir;
    }
  } catch (err) {
    console.error("[canon] MCP roots unavailable:", err instanceof Error ? err.message : err);
  }

  // Priority 3: cwd fallback — loudly log so HTTP-mode scope leaks are observable.
  console.warn(
    `[canon] project scope fell back to cwd-derived git root: ${cwdFallback} — ` +
      `no CANON_PROJECT_DIR and roots/list returned no usable root`,
  );
  return cwdFallback;
}
