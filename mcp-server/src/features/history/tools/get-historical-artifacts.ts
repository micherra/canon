/**
 * get_historical_artifacts tool — retrieve archived artifacts from a previous build.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: Zod schema on all inputs; isPathContained for path safety
 *   - fail-closed-by-default: deny access when path traversal detected
 *   - bounded-context-boundaries: imports from shared kernel and history-types only
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { isPathContained } from "@shared/lib/worktree-guard.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import type { HistoricalArtifact, HistoricalArtifactsResult } from "../history-types.ts";

// 1 MB file read cap
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

export const GetHistoricalArtifactsInputSchema = z.object({
  project_dir: z.string().describe("Project root directory path"),
  archive_id: z.string().describe("Archive ID to retrieve artifacts from"),
  artifact_types: z
    .array(z.string())
    .optional()
    .describe(
      'Subdirectory names to read (e.g. ["plans","reviews"]). Use "run-summary" for run-summary.json.',
    ),
  file_pattern: z
    .string()
    .optional()
    .describe("Optional filename substring filter (case-insensitive)"),
});

export type GetHistoricalArtifactsInput = z.input<typeof GetHistoricalArtifactsInputSchema>;

/**
 * Retrieve artifacts from an archived build.
 *
 * Looks up the archive by ID, resolves its directory, reads the requested
 * artifact subdirectories (or all when artifact_types is absent), and returns
 * file content capped at 1 MB per file.
 *
 * Path safety: every resolved path is validated with isPathContained before
 * reading. Any path that escapes the archive directory is denied (fail-closed).
 *
 * @param rawInput - Raw tool input; validated by Zod before use
 */
export async function getHistoricalArtifacts(
  rawInput: GetHistoricalArtifactsInput,
): Promise<ToolResult<HistoricalArtifactsResult>> {
  const input = GetHistoricalArtifactsInputSchema.parse(rawInput);
  const { project_dir, archive_id, artifact_types, file_pattern } = input;

  const db = getDriftDb(project_dir);
  const archive = db.getArchiveById(archive_id);

  if (archive === null) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `No archive found with ID: ${archive_id}`,
      false,
    );
  }

  const archivePath = archive.archive_path;

  if (!existsSync(archivePath)) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Archive directory no longer exists: ${archivePath}`,
      false,
    );
  }

  const artifacts: HistoricalArtifact[] = [];

  // Determine which artifact types to read
  const typesToRead = artifact_types ?? getDefaultArtifactTypes(archivePath);

  for (const artifactType of typesToRead) {
    if (artifactType === "run-summary") {
      // Special case: run-summary.json in the archive root
      const summaryPath = join(archivePath, "run-summary.json");

      // Path safety check
      if (!isPathContained(archivePath, summaryPath)) {
        // fail-closed: skip this artifact
        continue;
      }

      if (!existsSync(summaryPath)) continue;

      const artifact = readFileSafe(summaryPath, archivePath, file_pattern, "run-summary.json");
      if (artifact !== null) artifacts.push(artifact);
      continue;
    }

    // Subdirectory case
    const subdirPath = join(archivePath, artifactType);

    // Path safety: validate the subdir path is inside archivePath
    if (!isPathContained(archivePath, subdirPath)) {
      // fail-closed: skip this artifact type (path traversal attempt)
      continue;
    }

    if (!existsSync(subdirPath)) continue;

    let subdirStat: ReturnType<typeof statSync> | null = null;
    try {
      subdirStat = statSync(subdirPath);
    } catch {
      continue;
    }

    if (!subdirStat.isDirectory()) continue;

    // Read all files in the subdir
    let entries: string[];
    try {
      entries = readdirSync(subdirPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = join(subdirPath, entry);

      // Path safety: validate the file path
      if (!isPathContained(archivePath, filePath)) {
        continue; // fail-closed
      }

      let fileStat: ReturnType<typeof statSync> | null = null;
      try {
        fileStat = statSync(filePath);
      } catch {
        continue;
      }

      if (!fileStat.isFile()) continue;

      const artifact = readFileSafe(filePath, archivePath, file_pattern, entry);
      if (artifact !== null) artifacts.push(artifact);
    }
  }

  return toolOk({
    archive_id,
    archive_path: archivePath,
    artifacts,
  });
}

// ---- Private helpers ----

/**
 * List subdirectory names (artifact types) present in the archive directory.
 * Used when no artifact_types filter is specified.
 */
function getDefaultArtifactTypes(archivePath: string): string[] {
  try {
    const entries = readdirSync(archivePath);
    const types: string[] = [];
    for (const entry of entries) {
      const entryPath = join(archivePath, entry);
      try {
        const s = statSync(entryPath);
        if (s.isDirectory()) {
          types.push(entry);
        } else if (entry === "run-summary.json") {
          types.push("run-summary");
        }
      } catch {
        // Skip unreadable entries
      }
    }
    return types;
  } catch {
    return [];
  }
}

/**
 * Read a file and return a HistoricalArtifact, or null when:
 * - file_pattern is set and the filename does not match
 * - the file exceeds MAX_FILE_SIZE_BYTES
 * - an I/O error occurs
 */
function readFileSafe(
  filePath: string,
  archivePath: string,
  filePattern: string | undefined,
  entryName: string,
): HistoricalArtifact | null {
  // Apply file_pattern filter
  if (
    filePattern !== undefined &&
    !entryName.toLowerCase().includes(filePattern.toLowerCase())
  ) {
    return null;
  }

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return null;
  }

  if (size > MAX_FILE_SIZE_BYTES) {
    return null; // Cap file reads at 1 MB
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Compute relative path from archive root
  const relativePath = filePath.slice(archivePath.length).replace(/^\//, "");

  return {
    content,
    path: relativePath,
    size_bytes: size,
  };
}
