/**
 * artifact-path-resolver.ts — cross-root artifact re-read resolver.
 *
 * Provenance stores artifact paths project-root-relative. The offline evolution
 * tools (attribute_failure, select_mutation_targets) re-read those paths for hash
 * verification + baseline body. When Canon runs as a plugin in another repo
 * (pluginDir !== project_dir), a TRUSTED plugin-tier artifact (rules/, agents/, …)
 * lives under pluginDir but not project_dir, so a project_dir-only re-read
 * spuriously marks it missing/hash_unverified (Codex P2 #1, ADR-0031).
 *
 * Fix: project_dir-first, pluginDir-fallback, gated on the PLUGIN_ARTIFACT_ROOTS
 * trusted-tier path proxy. The committable project_dir copy stays the baseline in
 * self-hosting (mutation-semantics constraint); pluginDir is a read-only fallback
 * used only when the artifact is absent from project_dir. Untrusted-project-local
 * overlay paths (.canon/**) NEVER fall back (trust boundary, ADR-0027).
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: fallback gated on the trusted-tier proxy
 *   - errors-are-values: genuinely-missing → project_dir path (fail-closed, no throw)
 *   - simplicity-first: one pure resolver, no schema/type change
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { PLUGIN_ARTIFACT_ROOTS } from "./candidate-injection.ts";

/**
 * True iff relPath's first segment is a PLUGIN_ARTIFACT_ROOTS dir — the exact
 * path proxy for trust_tier "trusted". Untrusted overlay paths live under
 * `.canon/` (first segment `.canon`, never a plugin root), so they never match.
 */
function isPluginArtifactPath(relPath: string): boolean {
  return (PLUGIN_ARTIFACT_ROOTS as readonly string[]).includes(normalize(relPath).split(sep)[0]);
}

/**
 * Resolve an artifact's on-disk path for RE-READ (hash verify + baseline body).
 *
 * Resolution order:
 *   1. absolute → as-is (honor absolute provenance paths, unchanged).
 *   2. `project_dir/<p>` if it EXISTS → committable copy wins (self-host semantics).
 *   3. `pluginDir/<p>` if `pluginDir` set AND `<p>` is a plugin-artifact root AND it
 *      exists → closes the cross-root gap for a foreign plugin install.
 *   4. else `project_dir/<p>` (fail-closed: genuinely-missing → caller's null /
 *      file_missing / hash_unverified bucket).
 *
 * @param artifactPath - Path from provenance. Absolute or project-root-relative.
 * @param projectDir - Absolute path to the project root (primary read root).
 * @param pluginDir - Optional absolute plugin root; when absent, behavior is the
 *   prior `join(projectDir, artifactPath)` (no fallback).
 * @returns Absolute on-disk path to read. Never throws.
 */
export function resolveArtifactReadPath(
  artifactPath: string,
  projectDir: string,
  pluginDir?: string,
): string {
  if (isAbsolute(artifactPath)) return artifactPath;
  const primary = join(projectDir, artifactPath);
  if (existsSync(primary)) return primary;
  if (pluginDir && isPluginArtifactPath(artifactPath)) {
    const fallback = join(pluginDir, artifactPath);
    if (existsSync(fallback)) return fallback;
  }
  return primary;
}
