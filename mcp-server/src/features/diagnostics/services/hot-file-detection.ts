/**
 * Hot-File Detection Service — Identify files modified in multiple recent builds.
 *
 * Queries drift.db flow_runs for files that appear in 3+ distinct builds
 * within the last 14 days. These "hot files" deserve extra caution since
 * recent changes may not have settled.
 *
 * Follows the pitfall-enrichment.ts pattern exactly.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty input returns empty arrays; fail-open wrapper
 * - simplicity-first: three focused functions — detect, format, build
 * - errors-are-values: typed return values; no thrown errors for expected conditions
 */

import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";

// ---- Types ----

export type HotFileEntry = {
  file_path: string;
  build_count: number;
  last_builds: string[]; // workflow slugs or task names
};

// ---- HOT_FILE threshold ----

/** Minimum number of distinct builds for a file to be flagged as hot. */
const HOT_FILE_THRESHOLD = 3;

/** Maximum number of hot file entries to surface. */
const MAX_HOT_FILES = 3;

/** Number of days to look back for recent builds. */
const LOOKBACK_DAYS = 14;

// ---- Helpers ----

/**
 * Compute the ISO cutoff timestamp for the lookback window.
 * Exported for testing the date comparison logic.
 */
export function computeLookbackCutoff(): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  return cutoff.toISOString();
}

/**
 * Extract file paths from a single commit entry string.
 *
 * The commits field in FlowRunEntry is string[] after deserialization by the DAO,
 * but the raw DB column may store JSON of { sha, files }[] objects (when written
 * with file-level data). Each entry is tried as a JSON CommitRecord.
 * Plain SHA strings (not valid JSON objects with files) are skipped.
 */
function extractFilesFromEntry(entry: string): string[] {
  try {
    const parsed = JSON.parse(entry) as { sha?: string; files?: unknown };
    if (parsed.files && Array.isArray(parsed.files)) {
      return parsed.files.filter((f): f is string => typeof f === "string");
    }
  } catch {
    // Plain SHA string — no file info
  }
  return [];
}

/**
 * Extract all file paths from a run's commits array.
 * Returns a Set of unique file paths found across all commit entries.
 */
export function extractFilesFromRun(commits: string[] | undefined): Set<string> {
  const files = new Set<string>();
  if (!commits || commits.length === 0) return files;
  for (const entry of commits) {
    for (const f of extractFilesFromEntry(entry)) {
      files.add(f);
    }
  }
  return files;
}

/**
 * Build the file-to-run-count map from recent flow runs.
 * Returns a map of file path → { count, builds }.
 */
function buildFileRunMap(
  filePaths: string[],
  cutoffIso: string,
  projectDir: string,
): Map<string, { count: number; builds: string[] }> {
  const driftDb = getDriftDb(projectDir);
  const allRuns = driftDb.getAllFlowRuns();
  const recentRuns = allRuns.filter((run) => run.completed >= cutoffIso);

  const fileRunMap = new Map<string, { count: number; builds: string[] }>();

  for (const run of recentRuns) {
    const filesInRun = extractFilesFromRun(run.commits as string[] | undefined);
    if (filesInRun.size === 0) continue;

    const buildLabel = run.flow || run.task || run.run_id;
    updateFileRunMap(fileRunMap, filePaths, filesInRun, buildLabel);
  }

  return fileRunMap;
}

/** Update the file-to-run-count map for a single run's files. */
function updateFileRunMap(
  fileRunMap: Map<string, { count: number; builds: string[] }>,
  filePaths: string[],
  filesInRun: Set<string>,
  buildLabel: string,
): void {
  for (const fp of filePaths) {
    if (!filesInRun.has(fp)) continue;
    const existing = fileRunMap.get(fp);
    if (existing) {
      existing.count += 1;
      existing.builds.push(buildLabel);
    } else {
      fileRunMap.set(fp, { builds: [buildLabel], count: 1 });
    }
  }
}

// ---- Core detection function ----

/**
 * Detect hot files from a list of file paths.
 *
 * Queries flow_runs for builds completed within the last 14 days,
 * parses the commits JSON column for file paths, counts how many
 * distinct runs each input file appears in, and returns entries
 * where build_count >= 3, sorted by build_count DESC, capped at 3.
 *
 * Returns empty array for empty filePaths (define-errors-out-of-existence).
 */
export function detectHotFiles(filePaths: string[], projectDir: string): HotFileEntry[] {
  if (filePaths.length === 0) return [];

  const cutoffIso = computeLookbackCutoff();
  const fileRunMap = buildFileRunMap(filePaths, cutoffIso, projectDir);

  const hotFiles: HotFileEntry[] = [];
  for (const [fp, { count, builds }] of fileRunMap) {
    if (count >= HOT_FILE_THRESHOLD) {
      hotFiles.push({ build_count: count, file_path: fp, last_builds: builds });
    }
  }

  hotFiles.sort((a, b) => b.build_count - a.build_count);
  return hotFiles.slice(0, MAX_HOT_FILES);
}

// ---- Formatting function ----

/**
 * Format hot file entries into a structured markdown section.
 *
 * Returns empty string for empty array (define-errors-out-of-existence).
 *
 * Output format:
 * ```
 * ## Hot-File Caution
 *
 * These files have been modified in multiple recent builds. Take extra care -- recent changes may not have settled:
 *
 * - **{file_path}** -- modified in {N} builds in the last 14 days
 * ```
 */
export function formatHotFileSection(hotFiles: HotFileEntry[]): string {
  if (hotFiles.length === 0) return "";

  const lines: string[] = [
    "## Hot-File Caution",
    "",
    "These files have been modified in multiple recent builds. Take extra care -- recent changes may not have settled:",
    "",
  ];

  for (const entry of hotFiles) {
    lines.push(
      `- **${entry.file_path}** -- modified in ${entry.build_count} builds in the last 14 days`,
    );
  }

  return lines.join("\n");
}

// ---- Fail-open wrapper ----

/**
 * Build the hot-file caution section for the given file paths.
 *
 * Fail-open: returns `{ section: "", count: 0 }` on any error so enrichment
 * never blocks agent spawn.
 */
export function buildHotFileSection(
  filePaths: string[],
  projectDir: string,
): { section: string; count: number } {
  if (filePaths.length === 0) return { count: 0, section: "" };
  try {
    const hotFiles = detectHotFiles(filePaths, projectDir);
    return {
      count: hotFiles.length,
      section: formatHotFileSection(hotFiles),
    };
  } catch (err) {
    console.warn(
      "[hot-file-detection] buildHotFileSection failed:",
      err instanceof Error ? err.message : err,
    );
    return { count: 0, section: "" };
  }
}
