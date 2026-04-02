/**
 * Scope Resolver — extracts affected file paths from available sources.
 *
 * Resolution order (first non-empty wins):
 * 1. Board state artifacts — read artifact markdown files, extract backtick-quoted paths
 * 2. Task plan files — parse YAML frontmatter files: array
 * 3. Fallback — return empty array (no error)
 *
 * All file reads are synchronous (matching git adapter pattern) and capped at
 * 50KB to avoid memory issues with large artifact files.
 *
 * This module is fail-closed: any file read error returns empty array (never throws).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Board } from "./flow-schema.ts";
import { extractFilePaths } from "./wave-variables.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to read from a single artifact file. */
const MAX_ARTIFACT_BYTES = 50 * 1024; // 50KB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScopeInput {
  workspace: string;
  stateId: string;
  board: Board;
  planSlug?: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the task scope (affected file paths) from available sources.
 *
 * Resolution order:
 * 1. Board state artifacts (markdown files with backtick-quoted paths)
 * 2. Task plan YAML frontmatter files: array
 * 3. Empty array fallback
 *
 * @returns Deduplicated array of file paths. Never throws.
 */
export function resolveTaskScope(input: ScopeInput): string[] {
  const { workspace, stateId, board, planSlug, taskId } = input;

  // Source 1: board state artifacts
  const artifactPaths = resolveFromBoardArtifacts(board, stateId, workspace);
  if (artifactPaths.length > 0) {
    return artifactPaths;
  }

  // Source 2: task plan YAML frontmatter
  if (planSlug !== undefined && taskId !== undefined) {
    const planPaths = resolveFromTaskPlan(workspace, planSlug, taskId);
    if (planPaths.length > 0) {
      return planPaths;
    }
  }

  // Fallback: no scope sources available
  return [];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract file paths from board state artifacts.
 * Reads each artifact markdown file and extracts backtick-quoted paths.
 * Caps reads at MAX_ARTIFACT_BYTES. Returns deduplicated paths.
 */
function resolveFromBoardArtifacts(board: Board, stateId: string, workspace: string): string[] {
  const state = board.states[stateId];
  if (!state?.artifacts || state.artifacts.length === 0) {
    return [];
  }

  const resolvedWorkspace = resolve(workspace);
  const allPaths = new Set<string>();

  for (const artifactFile of state.artifacts) {
    try {
      // Guard: reject artifact paths that escape the workspace root
      const resolvedArtifact = resolve(artifactFile);
      if (!resolvedArtifact.startsWith(`${resolvedWorkspace}/`) && resolvedArtifact !== resolvedWorkspace) {
        continue;
      }

      if (!existsSync(resolvedArtifact)) {
        continue;
      }
      const raw = readFileSync(resolvedArtifact);
      // Cap at MAX_ARTIFACT_BYTES
      const content = raw.slice(0, MAX_ARTIFACT_BYTES).toString("utf-8");
      for (const p of extractFilePaths(content)) {
        allPaths.add(p);
      }
    } catch {
      // Silently skip unreadable files (fail-closed)
    }
  }

  return Array.from(allPaths);
}

/**
 * Parse a task plan YAML frontmatter to extract the files: array.
 * Uses simple regex parsing (no gray-matter dependency).
 * Returns deduplicated paths.
 */
function resolveFromTaskPlan(workspace: string, planSlug: string, taskId: string): string[] {
  const planPath = join(workspace, "plans", planSlug, `${taskId}-PLAN.md`);

  try {
    if (!existsSync(planPath)) {
      return [];
    }

    const content = readFileSync(planPath, "utf-8");
    return parseFrontmatterFiles(content);
  } catch {
    // Silently return empty on any read/parse error (fail-closed)
    return [];
  }
}

/**
 * Parse the `files:` array from YAML frontmatter delimited by `---` markers.
 * Uses simple regex — no gray-matter dependency.
 *
 * Handles formats:
 *   files:
 *     - path/to/file.ts
 *     - another/file.ts
 */
function parseFrontmatterFiles(content: string): string[] {
  // Extract frontmatter block between --- markers
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return [];
  }

  const frontmatter = frontmatterMatch[1];

  // Find the files: section (from "files:" to the next top-level key or end)
  const filesMatch = frontmatter.match(/^files:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m);
  if (!filesMatch) {
    return [];
  }

  const filesSection = filesMatch[1];

  // Extract list items: "  - path/to/file.ts"
  const paths: string[] = [];
  const itemRegex = /^[ \t]+-\s+(.+)$/gm;
  let m: RegExpExecArray | null;

  while ((m = itemRegex.exec(filesSection)) !== null) {
    const filePath = m[1].trim();
    if (filePath.length > 0) {
      paths.push(filePath);
    }
  }

  // Deduplicate
  return Array.from(new Set(paths));
}
