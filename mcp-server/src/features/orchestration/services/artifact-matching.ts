/**
 * artifact-matching — pure artifact-path resolution for the orchestration journal.
 *
 * All functions here are pure compute or narrow I/O (fs existence check only).
 * They are separated from orchestration-journal.ts to keep that file within the
 * noExcessiveLinesPerFile limit and to honour compute/effect separation.
 */

import { globSync } from "node:fs";
import { join } from "node:path";
import type { JournalStep } from "../tools/orchestration-journal.ts";

// Pure compute: for a literal *-SUMMARY.md path (no glob *), return the
// directory-scoped *-SUMMARY.md glob so artifactExists can discover the real
// slug/task_id-named summary. null for globs and non-SUMMARY stems (fixed-stem
// artifacts must exact-match to keep the safety property).
export function summaryGlobFallback(artifact: string): string | null {
  if (artifact.includes("*") || !/-SUMMARY\.md$/.test(artifact)) return null;
  const slash = artifact.lastIndexOf("/");
  return `${slash === -1 ? "" : artifact.slice(0, slash + 1)}*-SUMMARY.md`;
}

/**
 * True when `artifact` (plain path or glob) exists under `workspace` or its
 * `worktree/` subdir. For a literal *-SUMMARY.md expectation that misses,
 * retries once with a directory-scoped glob (via summaryGlobFallback) to
 * discover the real auto-named summary without relaxing fixed-stem checks.
 */
export function artifactExists(workspace: string, artifact: string): boolean {
  if (globSync(artifact, { cwd: workspace }).length > 0) return true;
  const worktreePath = join(workspace, "worktree");
  if (globSync(artifact, { cwd: worktreePath }).length > 0) return true;
  const fallback = summaryGlobFallback(artifact);
  if (fallback) {
    if (globSync(fallback, { cwd: workspace }).length > 0) return true;
    if (globSync(fallback, { cwd: worktreePath }).length > 0) return true;
  }
  return false;
}

/**
 * Scan a list of artifact paths for missing files.
 *
 * Skips entries that are:
 * - Prefixed with `outcome:` — these are outcome descriptions, not file paths
 * - Containing `${` — these are unresolved template variables
 *
 * Returns an array of artifact paths that are missing from disk. Returns an
 * empty array when all artifacts are present (or all entries are skipped).
 */
export function scanArtifactList(workspace: string, artifacts: readonly string[]): string[] {
  const missing: string[] = [];
  for (const art of artifacts) {
    if (art.startsWith("outcome:")) continue;
    if (art.includes("${")) continue;
    if (!artifactExists(workspace, art)) {
      missing.push(art);
    }
  }
  return missing;
}

export type ArtifactScan = {
  expected: string[];
  missing: string[];
  skipped_unresolved: string[];
};

/**
 * Classify a single artifact path into one of three buckets: skip (outcome/unresolved),
 * missing, or present. Returns "outcome" | "unresolved" | "missing" | "present".
 */
export function classifyArtifact(
  workspace: string,
  art: string,
): "outcome" | "unresolved" | "missing" | "present" {
  if (art.startsWith("outcome:")) return "outcome";
  if (art.includes("${")) return "unresolved";
  return artifactExists(workspace, art) ? "present" : "missing";
}

export function scanArtifacts(workspace: string, completed: readonly JournalStep[]): ArtifactScan {
  const expected: string[] = [];
  const missing: string[] = [];
  const skipped_unresolved: string[] = [];
  for (const step of completed) {
    for (const art of step.artifacts_expected ?? []) {
      expected.push(art);
      const classification = classifyArtifact(workspace, art);
      if (classification === "unresolved") skipped_unresolved.push(art);
      else if (classification === "missing") missing.push(art);
    }
  }
  return { expected, missing, skipped_unresolved };
}
