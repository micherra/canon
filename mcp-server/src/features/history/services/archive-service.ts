/**
 * Archive Service — copies workspace artifacts to .canon/history/{branch}/{slug}/
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
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { CANON_DIR, CANON_FILES } from "../../../shared/constants.ts";
import { generateId } from "../../../shared/lib/id.ts";
import { sanitizeBranch } from "../../../domains/workspaces/workspace.ts";
import { buildRunSummary } from "./run-summary-builder.ts";

// ---- Constants ----

/** Directories to copy from workspace to archive (if they exist). */
const ARCHIVE_DIRS = [
  "research",
  "plans",
  "decisions",
  "reviews",
  "handoffs",
  "transcripts",
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
  "session.json",
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
 * Archive a workspace to .canon/history/{sanitizedBranch}/{slug}/.
 * Copies artifact directories and files, generates run-summary.json,
 * and records the manifest entry in drift.db.
 *
 * Never throws — returns { archived: false, error } on any failure.
 */
export async function archiveWorkspace(
  input: ArchiveWorkspaceInput,
): Promise<ArchiveWorkspaceResult> {
  const { workspacePath, projectDir, branch, slug } = input;

  // validate-at-trust-boundaries: verify workspace path exists
  if (!existsSync(workspacePath)) {
    return {
      archived: false,
      archive_path: null,
      manifest_entry: null,
      run_summary_generated: false,
      error: `Workspace path does not exist: ${workspacePath}`,
    };
  }

  let stat;
  try {
    stat = statSync(workspacePath);
  } catch (err: unknown) {
    return {
      archived: false,
      archive_path: null,
      manifest_entry: null,
      run_summary_generated: false,
      error: `Cannot stat workspace path: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      archived: false,
      archive_path: null,
      manifest_entry: null,
      run_summary_generated: false,
      error: `Workspace path is not a directory: ${workspacePath}`,
    };
  }

  // Compute archive destination
  const sanitizedBranch = sanitizeBranch(branch);
  const archiveTargetPath = join(
    projectDir,
    CANON_DIR,
    CANON_FILES.HISTORY_DIR,
    sanitizedBranch,
    slug,
  );

  try {
    mkdirSync(archiveTargetPath, { recursive: true });
  } catch (err: unknown) {
    return {
      archived: false,
      archive_path: null,
      manifest_entry: null,
      run_summary_generated: false,
      error: `Failed to create archive directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Copy artifact directories
  const artifactTypes: string[] = [];

  for (const dir of ARCHIVE_DIRS) {
    const srcDir = join(workspacePath, dir);
    if (!existsSync(srcDir)) continue;
    try {
      cpSync(srcDir, join(archiveTargetPath, dir), { recursive: true });
      artifactTypes.push(dir);
    } catch {
      // Best-effort: log and continue
    }
  }

  // Copy top-level files (excluding skip patterns)
  for (const file of ARCHIVE_FILES) {
    if ((SKIP_PATTERNS as readonly string[]).includes(file)) continue;
    const srcFile = join(workspacePath, file);
    if (!existsSync(srcFile)) continue;
    try {
      cpSync(srcFile, join(archiveTargetPath, file));
      artifactTypes.push(file);
    } catch {
      // Best-effort: log and continue
    }
  }

  // Extract workspace metadata from orchestration.db
  const workspaceMeta = extractWorkspaceMetadata(workspacePath);

  // Generate archive ID
  const archiveId = generateId("arch");
  const archivedAt = new Date().toISOString();

  // Generate run summary (independently wrapped — failure does not abort archive)
  let runSummaryGenerated = false;
  try {
    const runSummary = buildRunSummary({
      workspacePath,
      slug,
      archiveId,
      metadata: {
        branch,
        flow: workspaceMeta.flow,
        tier: workspaceMeta.tier,
        task: workspaceMeta.task,
        archivedAt,
      },
    });
    const summaryPath = join(archiveTargetPath, "run-summary.json");
    writeFileSync(summaryPath, JSON.stringify(runSummary, null, 2), "utf-8");
    runSummaryGenerated = true;
  } catch {
    // Run summary failure is non-fatal — archive proceeds without it
    runSummaryGenerated = false;
  }

  // Build manifest entry
  const manifestEntry: ArchiveManifestEntry = {
    archive_id: archiveId,
    branch,
    sanitized_branch: sanitizedBranch,
    slug,
    flow: workspaceMeta.flow,
    tier: workspaceMeta.tier,
    task: workspaceMeta.task,
    archived_at: archivedAt,
    archive_path: archiveTargetPath,
    artifact_types: artifactTypes,
    has_run_summary: runSummaryGenerated,
    source_run_id: workspaceMeta.run_id,
  };

  // Record manifest in drift.db (best-effort)
  try {
    getDriftDb(projectDir).appendArchiveManifest(manifestEntry);
  } catch {
    // Manifest write failure is non-fatal
  }

  return {
    archived: true,
    archive_path: archiveTargetPath,
    manifest_entry: manifestEntry,
    run_summary_generated: runSummaryGenerated,
  };
}

// ---- Private helpers ----

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
  const defaults = { flow: "unknown", tier: "unknown", task: "unknown", run_id: null };
  const dbPath = join(workspacePath, CANON_FILES.ORCHESTRATION_DB);

  if (!existsSync(dbPath)) {
    return defaults;
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT flow_name, tier, task, slug FROM execution WHERE id = 1 LIMIT 1",
      )
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
      tier: row.tier ?? "unknown",
      task: row.task ?? "unknown",
      run_id: null, // run_id is not tracked in execution table directly
    };
  } catch {
    return defaults;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors
    }
  }
}
