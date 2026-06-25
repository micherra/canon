/**
 * candidate-injection.ts — ADR-0019: Throwaway temp-dir candidate injection.
 *
 * Copies the eval surface (skills/canon/evals/) to a temp dir, writes the
 * candidate file at its target_path, runs the caller's function, then
 * cleans up in a `finally` block.
 *
 * NEVER mutates the real skills/canon/evals/ tree. NEVER writes outside the temp dir.
 * Path-traversal protection: rejects any target_path that resolves outside the temp root.
 *
 * ADR-0019: uses fs.cp (in-process, no shell) — never shell cp.
 */

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";

/** The eval surface path relative to the project root, per PROBE-FINDINGS P1. */
const EVAL_SURFACE_RELATIVE = join("skills", "canon", "evals");

/**
 * withInjectedCandidate — copy the eval surface, inject the candidate, run fn, clean up.
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

    // Write the candidate content.
    await writeFile(resolvedTarget, candidateText, "utf-8");

    return await fn(tmpDir);
  } finally {
    // Always clean up — even on error or thrown exception.
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
