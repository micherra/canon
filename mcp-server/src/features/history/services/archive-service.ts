/**
 * Archive Service — copies workspace artifacts to .canon/history/{slug}/
 * and records a manifest entry in drift.db.
 *
 * Canon principles:
 *   - fail-closed-by-default: never throws — returns result value on all paths
 *   - validate-at-trust-boundaries: validate workspace path exists before archiving
 *   - bounded-context-boundaries: imports from @platform/storage/drift/ (shared kernel)
 *
 * Note on fail-open semantics: Archiving is intentionally best-effort (called from
 * janitor before-delete path). The archive failing must never block the prune.
 * Run summary generation is independently wrapped so a summary failure does not
 * abort the archive copy.
 */

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sanitizeBranch } from "../../../domains/workspaces/workspace.ts";
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "../../../platform/storage/drift/drift-db-cache.ts";
import { CANON_DIR, CANON_FILES } from "../../../shared/constants.ts";
import { generateId } from "../../../shared/lib/id.ts";
import { buildRunSummary } from "./run-summary-builder.ts";

// ---- Constants ----

/**
 * Directories to copy from workspace to archive (if they exist).
 * Includes legacy dirs (research, decisions, handoffs) for backward-compatible
 * archival of existing workspaces that predate the 2026-05-25 cleanup.
 */
const ARCHIVE_DIRS = [
  "plans",
  "reviews",
  "transcripts",
  "artifacts",
  "research",
  "decisions",
  "handoffs",
] as const;

/** Top-level files to copy from workspace to archive (if they exist). */
const ARCHIVE_FILES = ["log.jsonl", "context.md", "journal.json"] as const;

/** Files/dirs to always skip when archiving. */
const SKIP_PATTERNS = [
  "orchestration.db",
  "orchestration.db-shm",
  "orchestration.db-wal",
  ".lock",
  "board.json",
] as const;

// ---- Public types ----

/** Input for archiveWorkspace. */
export type ArchiveWorkspaceInput = {
  /** Absolute path to the workspace directory. */
  workspacePath: string;
  /** Canon project root (contains .canon/). */
  projectDir: string;
  /** Git branch the workspace was built on. */
  branch: string;
  /** Workspace slug. */
  slug: string;
};

/** Result from archiveWorkspace. */
export type ArchiveWorkspaceResult = {
  /** True when the workspace was successfully archived. */
  archived: boolean;
  /** Absolute path to the archive directory, or null on failure. */
  archive_path: string | null;
  /** The manifest entry recorded in drift.db, or null on failure. */
  manifest_entry: ArchiveManifestEntry | null;
  /** True when run-summary.json was successfully generated. */
  run_summary_generated: boolean;
  /** Error message when archived is false. */
  error?: string;
};

// ---- Public API ----

/**
 * Archive a workspace to .canon/history/{slug}/.
 * Copies artifact directories and files, generates run-summary.json,
 * and records the manifest entry in drift.db.
 *
 * Never throws — returns { archived: false, error } on any failure.
 */
export async function archiveWorkspace(
  input: ArchiveWorkspaceInput,
): Promise<ArchiveWorkspaceResult> {
  const { workspacePath, projectDir, branch, slug } = input;

  const validationError = validateWorkspacePath(workspacePath);
  if (validationError !== null) return failedArchiveResult(validationError);

  const sanitizedBranch = sanitizeBranch(branch);
  const archiveTargetPath = join(projectDir, CANON_DIR, CANON_FILES.HISTORY_DIR, slug);

  const mkdirError = createArchiveDir(archiveTargetPath);
  if (mkdirError !== null) return failedArchiveResult(mkdirError);

  const artifactTypes = copyArtifacts(workspacePath, archiveTargetPath);
  const workspaceMeta = extractWorkspaceMetadata(workspacePath);
  const archiveId = generateId("arch");
  const archivedAt = new Date().toISOString();

  const runSummaryGenerated = generateAndWriteRunSummary({
    archivedAt,
    archiveId,
    archiveTargetPath,
    branch,
    slug,
    workspaceMeta,
    workspacePath,
  });

  const manifestEntry = recordManifestEntry({
    archivedAt,
    archiveId,
    archiveTargetPath,
    artifactTypes,
    branch,
    projectDir,
    runSummaryGenerated,
    sanitizedBranch,
    slug,
    workspaceMeta,
  });

  return {
    archive_path: archiveTargetPath,
    archived: true,
    manifest_entry: manifestEntry,
    run_summary_generated: runSummaryGenerated,
  };
}

// ---- Private helpers ----

function failedArchiveResult(error: string): ArchiveWorkspaceResult {
  return {
    archive_path: null,
    archived: false,
    error,
    manifest_entry: null,
    run_summary_generated: false,
  };
}

/** Create the archive target directory. Returns null on success, error string on failure. */
function createArchiveDir(archiveTargetPath: string): string | null {
  try {
    mkdirSync(archiveTargetPath, { recursive: true });
    return null;
  } catch (err: unknown) {
    return `Failed to create archive directory: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Validate that workspacePath exists and is a directory.
 * Returns null when valid, or an error string when invalid.
 */
function validateWorkspacePath(workspacePath: string): string | null {
  if (!existsSync(workspacePath)) {
    return `Workspace path does not exist: ${workspacePath}`;
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(workspacePath);
  } catch (err: unknown) {
    return `Cannot stat workspace path: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!stat.isDirectory()) {
    return `Workspace path is not a directory: ${workspacePath}`;
  }

  return null;
}

/**
 * Copy artifact directories and top-level files from workspacePath to archiveTargetPath.
 * Returns the list of artifact type names that were successfully copied.
 */
function copyDirs(workspacePath: string, archiveTargetPath: string): string[] {
  const copied: string[] = [];
  for (const dir of ARCHIVE_DIRS) {
    const srcDir = join(workspacePath, dir);
    if (!existsSync(srcDir)) continue;
    try {
      cpSync(srcDir, join(archiveTargetPath, dir), { recursive: true });
      copied.push(dir);
    } catch (err: unknown) {
      console.warn(
        `[canon] archive: failed to copy dir ${dir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return copied;
}

function copyFiles(workspacePath: string, archiveTargetPath: string): string[] {
  const copied: string[] = [];
  for (const file of ARCHIVE_FILES) {
    if ((SKIP_PATTERNS as readonly string[]).includes(file)) continue;
    const srcFile = join(workspacePath, file);
    if (!existsSync(srcFile)) continue;
    try {
      cpSync(srcFile, join(archiveTargetPath, file));
      copied.push(file);
    } catch (err: unknown) {
      console.warn(
        `[canon] archive: failed to copy file ${file}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return copied;
}

function copyArtifacts(workspacePath: string, archiveTargetPath: string): string[] {
  return [
    ...copyDirs(workspacePath, archiveTargetPath),
    ...copyFiles(workspacePath, archiveTargetPath),
  ];
}

/**
 * Generate run-summary.json and write it to the archive directory.
 * Returns true on success. Failure is non-fatal — archive proceeds without it.
 */
function generateAndWriteRunSummary(input: {
  workspacePath: string;
  archiveTargetPath: string;
  archiveId: string;
  archivedAt: string;
  branch: string;
  slug: string;
  workspaceMeta: { flow: string; tier: string; task: string; run_id: string | null };
}): boolean {
  const { workspacePath, archiveTargetPath, archiveId, archivedAt, branch, slug, workspaceMeta } =
    input;
  try {
    const runSummary = buildRunSummary({
      archiveId,
      metadata: {
        archivedAt,
        branch,
        flow: workspaceMeta.flow,
        task: workspaceMeta.task,
        tier: workspaceMeta.tier,
      },
      slug,
      workspacePath,
    });
    const summaryPath = join(archiveTargetPath, "run-summary.json");
    writeFileSync(summaryPath, JSON.stringify(runSummary, null, 2), "utf-8");
    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] archive: run summary generation failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Build and record the manifest entry in drift.db.
 * drift.db write failure is non-fatal — returns the entry regardless.
 */
function recordManifestEntry(input: {
  archiveId: string;
  archiveTargetPath: string;
  archivedAt: string;
  artifactTypes: string[];
  branch: string;
  projectDir: string;
  runSummaryGenerated: boolean;
  sanitizedBranch: string;
  slug: string;
  workspaceMeta: { flow: string; tier: string; task: string; run_id: string | null };
}): ArchiveManifestEntry {
  const {
    archiveId,
    archiveTargetPath,
    archivedAt,
    artifactTypes,
    branch,
    projectDir,
    runSummaryGenerated,
    sanitizedBranch,
    slug,
    workspaceMeta,
  } = input;

  const manifestEntry: ArchiveManifestEntry = {
    archive_id: archiveId,
    archive_path: archiveTargetPath,
    archived_at: archivedAt,
    artifact_types: artifactTypes,
    branch,
    flow: workspaceMeta.flow,
    has_run_summary: runSummaryGenerated,
    sanitized_branch: sanitizedBranch,
    slug,
    source_run_id: workspaceMeta.run_id,
    task: workspaceMeta.task,
    tier: workspaceMeta.tier,
  };

  try {
    getDriftDb(projectDir).appendArchiveManifest(manifestEntry);
  } catch (err: unknown) {
    console.warn(
      "[canon] archive: manifest write to drift.db failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return manifestEntry;
}

/**
 * Extract flow, tier, task, and run_id from the workspace's orchestration.db.
 * Opens the DB read-only, queries the execution table, closes in finally.
 * Returns safe defaults on any error.
 */
function extractWorkspaceMetadata(workspacePath: string): {
  flow: string;
  tier: string;
  task: string;
  run_id: string | null;
} {
  const defaults = { flow: "unknown", run_id: null, task: "unknown", tier: "unknown" };
  const dbPath = join(workspacePath, CANON_FILES.ORCHESTRATION_DB);

  if (!existsSync(dbPath)) {
    return defaults;
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT flow_name, tier, task, slug FROM execution WHERE id = 1 LIMIT 1")
      .get() as
      | {
          flow_name: string;
          tier: string;
          task: string;
          slug: string;
        }
      | undefined;

    if (!row) return defaults;

    return {
      flow: row.flow_name ?? "unknown",
      run_id: null, // run_id is not tracked in execution table directly
      task: row.task ?? "unknown",
      tier: row.tier ?? "unknown",
    };
  } catch (err: unknown) {
    console.warn(
      "[canon] archive: failed to read workspace metadata:",
      err instanceof Error ? err.message : err,
    );
    return defaults;
  } finally {
    try {
      db?.close();
    } catch {
      // db.close() has no meaningful recovery — suppress
    }
  }
}
