/**
 * candidate-injection.ts — ADR-0022 + ADR-0025: Throwaway temp-dir candidate injection.
 *
 * Two injection modes:
 *
 * 1. Eval-surface mode (`withInjectedCandidate`): copies only `skills/canon/evals/` into
 *    a temp dir and writes the candidate at its target_path. Used for eval-surface targets
 *    (skills/canon/evals/**).
 *
 * 2. Guardrail mode (`withInjectedGuardrailCandidate`): copies the full plugin markdown
 *    artifact tree (PLUGIN_ARTIFACT_ROOTS) into a temp dir, then writes the candidate at
 *    its target_path. The sandbox is a valid `--plugin-dir` target so run-evals.sh can
 *    load the rewritten guardrail artifact instead of the installed marketplace plugin.
 *
 * NEVER mutates the real project tree. Path-traversal protection and harness-entrypoint
 * guard apply to both modes.
 *
 * ADR-0022: uses fs.cp (in-process, no shell) — never shell cp.
 * ADR-0025: guardrail mode extends the temp-dir copy to the full plugin markdown footprint.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";

/**
 * Plugin markdown artifact roots copied into the guardrail sandbox.
 * Excludes mcp-server/, node_modules/, .git/, .canon/ — these are not
 * plugin-loaded artifacts and must not be copied.
 */
export const PLUGIN_ARTIFACT_ROOTS = [
  ".claude-plugin",
  "skills",
  "agents",
  "rules",
  "principles",
  "templates",
  "references",
  "primers",
] as const;

/** The eval surface path relative to the project root, per PROBE-FINDINGS P1. */
const EVAL_SURFACE_RELATIVE = join("skills", "canon", "evals");

/**
 * Harness entrypoints that a candidate must never be allowed to overwrite.
 * If the candidate's resolved target matches any of these filenames, injection
 * is rejected — a candidate that controls run-evals.sh can print a fake winning
 * summary and bypass the gate entirely.
 */
const HARNESS_ENTRYPOINTS = new Set(["run-evals.sh"]);

/**
 * isGuardrailTarget — pure predicate. No I/O.
 *
 * Returns true iff targetPath refers to a guardrail-corpus artifact:
 * - Its first path segment is one of PLUGIN_ARTIFACT_ROOTS, AND
 * - It is NOT under the eval surface (skills/canon/evals/).
 *
 * Eval-surface paths stay in eval-surface mode (withInjectedCandidate).
 * Non-plugin-root paths (mcp-server/, node_modules/, traversal, empty) return false.
 *
 * @param targetPath - Path relative to the project root. May be unnormalized.
 */
export function isGuardrailTarget(targetPath: string): boolean {
  if (!targetPath) return false;

  const normalized = normalize(targetPath);

  // Reject if at or under the eval surface — those stay in eval-surface mode.
  const evalSurfacePrefix = EVAL_SURFACE_RELATIVE;
  if (normalized === evalSurfacePrefix || normalized.startsWith(evalSurfacePrefix + sep)) {
    return false;
  }

  // The first path segment must be a recognized plugin artifact root.
  const firstSegment = normalized.split(sep)[0];
  return (PLUGIN_ARTIFACT_ROOTS as readonly string[]).includes(firstSegment);
}

/**
 * withInjectedCandidate — eval-surface mode (ADR-0022).
 *
 * Copy the eval surface, inject the candidate, run fn, clean up.
 *
 * @param projectDir - Root of the Canon project (not the mcp-server dir).
 * @param candidateText - Text content to write to the target path.
 * @param targetPath - Path relative to projectDir where the candidate should be written.
 *   Must resolve to a path inside the eval surface (within `skills/canon/evals/`).
 *   Path traversal is rejected.
 * @param fn - Callback receives the temp dir root. The eval surface is at
 *   `join(tmpDir, "skills", "canon", "evals")`.
 *
 * @throws If targetPath escapes the temp root (path-traversal guard).
 * @throws If targetPath is a harness entrypoint (run-evals.sh guard).
 * @throws If fs operations fail (ENOENT, EACCES, etc.).
 */
export async function withInjectedCandidate<T>(
  projectDir: string,
  candidateText: string,
  targetPath: string,
  fn: (tmpDir: string) => Promise<T>,
): Promise<T> {
  const tmpDir = await mkdtemp(join(tmpdir(), "canon-evolve-"));

  try {
    // Copy the eval surface into the temp dir, preserving structure.
    // Result: tmpDir/skills/canon/evals/...
    const evalSource = join(projectDir, EVAL_SURFACE_RELATIVE);
    const evalDest = join(tmpDir, EVAL_SURFACE_RELATIVE);

    await cp(evalSource, evalDest, { recursive: true });

    // Resolve the target path within the temp tree.
    // targetPath may be relative to projectDir (e.g., "skills/canon/evals/eval-set.json")
    // or just relative to the evals dir (e.g., "eval-set.json").
    // We support both: first try resolving against the project root within tmpDir,
    // then fall back to resolving against the eval surface.
    const resolvedTarget = resolveTarget(tmpDir, targetPath);

    // Harness-path guard: reject any target that would overwrite the trusted runner.
    // A candidate controlling run-evals.sh can print a fake winning summary and bypass
    // the gate. Check the filename (basename) of the resolved target.
    const targetFilename = basename(resolvedTarget);
    if (HARNESS_ENTRYPOINTS.has(targetFilename)) {
      throw new Error(
        `Forbidden target path: "${targetPath}" resolves to the harness entrypoint ` +
          `"${targetFilename}", which is reserved and cannot be overwritten by a candidate.`,
      );
    }

    // Write the candidate content.
    await writeFile(resolvedTarget, candidateText, "utf-8");

    return await fn(tmpDir);
  } finally {
    // Always clean up — even on error or thrown exception.
    await rm(tmpDir, { force: true, recursive: true });
  }
}

/**
 * withInjectedGuardrailCandidate — guardrail mode (ADR-0025).
 *
 * Copies the full plugin markdown artifact tree (PLUGIN_ARTIFACT_ROOTS) into a fresh
 * temp dir, writes the candidate at target_path, then calls fn(tmpDir). The temp dir
 * root is a valid `--plugin-dir` sandbox: run-evals.sh can load the rewritten artifact
 * via `claude -p --plugin-dir <tmpDir>` instead of the installed marketplace plugin.
 *
 * Fail-open for missing roots: entries that do not exist in projectDir are skipped
 * without error. The eval surface (skills/canon/evals/) is included via the skills/ root.
 *
 * @param projectDir - Absolute path to the project root.
 * @param candidateText - Text to write at targetPath in the sandbox.
 * @param targetPath - Path relative to projectDir. Must not escape the sandbox root;
 *   must not be a harness entrypoint (run-evals.sh).
 * @param fn - Callback receives the sandbox temp dir root (a valid plugin-dir value).
 *
 * @throws If targetPath escapes the temp root (path-traversal guard).
 * @throws If targetPath is a harness entrypoint (harness bypass guard).
 * @throws If critical fs operations fail.
 */
export async function withInjectedGuardrailCandidate<T>(
  projectDir: string,
  candidateText: string,
  targetPath: string,
  fn: (tmpDir: string) => Promise<T>,
): Promise<T> {
  const tmpDir = await mkdtemp(join(tmpdir(), "canon-evolve-guardrail-"));

  try {
    // Copy each plugin artifact root into the sandbox — fail-open for missing roots.
    // Do NOT copy mcp-server/, node_modules/, .git/, .canon/ (excluded by enumeration).
    for (const root of PLUGIN_ARTIFACT_ROOTS) {
      const src = join(projectDir, root);
      const dest = join(tmpDir, root);
      try {
        // biome-ignore lint/performance/noAwaitInLoops: per-root fail-open isolation requires separate try/catch per iteration; Promise.all loses that granularity
        await cp(src, dest, { recursive: true });
      } catch {
        // Root does not exist in projectDir — skip silently (fail-open).
      }
    }

    // Resolve the target path with the same traversal guard as eval-surface mode.
    const resolvedTarget = resolveTarget(tmpDir, targetPath);

    // Harness-path guard: reject any target that would overwrite the trusted runner.
    const targetFilename = basename(resolvedTarget);
    if (HARNESS_ENTRYPOINTS.has(targetFilename)) {
      throw new Error(
        `Forbidden target path: "${targetPath}" resolves to the harness entrypoint ` +
          `"${targetFilename}", which is reserved and cannot be overwritten by a candidate.`,
      );
    }

    // Ensure the parent directory exists — the root copy may not have created it
    // when the target is a new file not present in the original tree.
    await mkdir(dirname(resolvedTarget), { recursive: true });

    // Write the candidate.
    await writeFile(resolvedTarget, candidateText, "utf-8");

    return await fn(tmpDir);
  } finally {
    // Always clean up — even on error.
    await rm(tmpDir, { force: true, recursive: true });
  }
}

/**
 * resolveTarget — resolves targetPath within tmpDir, with path-traversal protection.
 *
 * targetPath may be:
 * 1. Relative to projectDir: "skills/canon/evals/eval-set.json"
 * 2. Absolute: rejected (must resolve within tmp root)
 * 3. Path-traversal attempt: "../../../etc/passwd" → rejected
 *
 * Returns the absolute resolved path within tmpDir.
 * Throws if the resolved path is outside tmpDir.
 */
function resolveTarget(tmpDir: string, targetPath: string): string {
  // Normalize to prevent .. tricks
  const normalizedTarget = normalize(targetPath);

  // Build candidate absolute path
  const candidate = resolve(tmpDir, normalizedTarget);

  // Path-traversal guard: resolved path must be inside tmpDir
  const tmpDirNorm = normalize(tmpDir);
  if (!candidate.startsWith(`${tmpDirNorm}/`) && candidate !== tmpDirNorm) {
    throw new Error(
      `Path traversal detected: target path "${targetPath}" resolves outside the temp root "${tmpDir}"`,
    );
  }

  return candidate;
}
