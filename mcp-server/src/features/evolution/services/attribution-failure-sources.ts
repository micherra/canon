/**
 * attribution-failure-sources.ts — Collect failure inputs for the attribution join.
 *
 * Collects the two joinable failure kinds:
 *   - review_violations: parse REVIEW.md via the existing run-summary-extractors parser
 *   - cliff_events:      getDriftDb(projectDir).getCliffEvents().getByWorkspace(slug)
 *
 * test_failure is DEFERRED — no durable test_failure event keyed by step_id exists
 * in the current trace schema (ADR-0023 Revisit-If).
 *
 * Fail-open per source: any error returns [] for that source.
 * Never throws.
 *
 * Canon principles:
 *   - observable-best-effort: absent REVIEW.md or cliff events → [] (not error);
 *     genuine read faults emit console.warn so they're distinguishable from clean absence
 *   - errors-are-values: errors in one source do not block the other
 *   - bounded-context-boundaries: imports from platform (archive, drift) not from features
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ReviewResult, ReviewViolation } from "@platform/storage/archive/archive-types.ts";
import { parseReviewFile } from "@platform/storage/archive/run-summary-extractors.ts";
import type { CliffEventRow } from "@platform/storage/drift/cliff-events-dao.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type FailureSources = {
  violations: ReviewViolation[];
  cliffEvents: CliffEventRow[];
};

/**
 * Collect failure sources for a live workspace.
 *
 * @param workspace  Absolute path to the workspace directory.
 * @param projectDir Absolute path to the project root (for drift.db cliff events lookup).
 */
export function collectFailureSources(workspace: string, projectDir: string): FailureSources {
  const violations = collectReviewViolations(workspace);
  const cliffEvents = collectCliffEvents(workspace, projectDir);
  return { cliffEvents, violations };
}

/**
 * Collect failure sources for an archived build.
 *
 * Reads review_results from the archived run-summary.json (located at
 * archive_path/run-summary.json as registered in the drift.db archive manifest).
 * Cliff events are fetched from drift.db using the run_metadata.slug.
 *
 * Fail-open per source: any error returns [] for that source.
 *
 * @param archiveId  Archive ID registered in drift.db.
 * @param projectDir Absolute path to the project root (contains .canon/drift.db).
 */
export function collectArchivedFailureSources(
  archiveId: string,
  projectDir: string,
): FailureSources {
  const violations = collectArchivedViolations(archiveId, projectDir);
  const cliffEvents = collectArchivedCliffEvents(archiveId, projectDir);
  return { cliffEvents, violations };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Collect review violations from all *.md files in reviews/ directory. */
function collectReviewViolations(workspace: string): ReviewViolation[] {
  const reviewsDir = join(workspace, "reviews");
  if (!existsSync(reviewsDir)) return []; // legitimate absence — not an error

  let entries: string[];
  try {
    entries = readdirSync(reviewsDir);
  } catch (err: unknown) {
    console.warn(
      `[attribution] collectReviewViolations: failed to list reviews dir ${reviewsDir}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const violations: ReviewViolation[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    violations.push(...parseOneReviewFile(join(reviewsDir, entry)));
  }
  return violations;
}

/** Parse violations from a single review file. Fail-open: returns [] on any read/parse error. */
function parseOneReviewFile(filePath: string): ReviewViolation[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const result = parseReviewFile(content);
    return result !== null ? result.violations : [];
  } catch (err: unknown) {
    console.warn(
      `[attribution] collectReviewViolations: failed to read/parse ${filePath}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Collect cliff events for this workspace from the drift.db.
 * The workspace_slug is derived from the workspace directory basename.
 */
function collectCliffEvents(workspace: string, projectDir: string): CliffEventRow[] {
  try {
    const slug = basename(workspace);
    const db = getDriftDb(projectDir);
    return db.getCliffEvents().getByWorkspace(slug);
  } catch (err: unknown) {
    console.warn(
      `[attribution] collectCliffEvents: failed to read cliff events for workspace=${basename(workspace)} project_dir=${projectDir}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Archived failure source helpers
// ---------------------------------------------------------------------------

/** Parse run-summary.json from an archive path and return review violations. */
function collectArchivedViolations(archiveId: string, projectDir: string): ReviewViolation[] {
  try {
    const db = getDriftDb(projectDir);
    const archive = db.getArchiveById(archiveId);
    if (archive === null) return [];

    const summaryPath = join(archive.archive_path, "run-summary.json");
    const raw = readFileSync(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null || !("review_results" in parsed)) {
      return [];
    }

    const rr = (parsed as { review_results?: unknown }).review_results;
    if (!Array.isArray(rr)) return [];

    return (rr as ReviewResult[]).flatMap((r) => r.violations ?? []);
  } catch (err: unknown) {
    console.warn(
      `[attribution] collectArchivedViolations: failed for archive_id=${archiveId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Fetch cliff events for an archived build using run_metadata.slug from run-summary.json. */
function collectArchivedCliffEvents(archiveId: string, projectDir: string): CliffEventRow[] {
  try {
    const db = getDriftDb(projectDir);
    const archive = db.getArchiveById(archiveId);
    if (archive === null) return [];

    const summaryPath = join(archive.archive_path, "run-summary.json");
    const raw = readFileSync(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null || !("run_metadata" in parsed)) {
      return [];
    }

    const meta = (parsed as { run_metadata?: unknown }).run_metadata;
    if (typeof meta !== "object" || meta === null || !("slug" in meta)) return [];

    const slug = (meta as { slug: unknown }).slug;
    if (typeof slug !== "string" || slug.length === 0) return [];

    return db.getCliffEvents().getByWorkspace(slug);
  } catch (err: unknown) {
    console.warn(
      `[attribution] collectArchivedCliffEvents: failed for archive_id=${archiveId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
