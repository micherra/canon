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
 *   - observable-best-effort: absent REVIEW.md or cliff events → [] (not error)
 *   - errors-are-values: errors in one source do not block the other
 *   - bounded-context-boundaries: imports from platform (archive, drift) not from features
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ReviewViolation } from "@platform/storage/archive/archive-types.ts";
import { parseReviewFile } from "@platform/storage/archive/run-summary-extractors.ts";
import type { CliffEventRow } from "@platform/storage/drift/cliff-events-dao.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FailureSources = {
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Collect review violations from all *.md files in reviews/ directory. */
function collectReviewViolations(workspace: string): ReviewViolation[] {
  const reviewsDir = join(workspace, "reviews");
  if (!existsSync(reviewsDir)) return [];

  const violations: ReviewViolation[] = [];
  let entries: string[];
  try {
    entries = readdirSync(reviewsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const content = readFileSync(join(reviewsDir, entry), "utf-8");
      const result = parseReviewFile(content);
      if (result !== null) {
        violations.push(...result.violations);
      }
    } catch {
      // Fail-open: skip unreadable review files
    }
  }

  return violations;
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
  } catch {
    return [];
  }
}
