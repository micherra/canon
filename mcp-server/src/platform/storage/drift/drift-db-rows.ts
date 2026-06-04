/**
 * drift-db-rows.ts
 *
 * Internal SQLite row types and row-to-domain-object deserializer functions for DriftDb.
 * Extracted from drift-db.ts to keep that file under the line-count limit.
 * All types are internal (not exported from the public drift-db API).
 */

import type { ReviewEntry, ReviewViolation } from "@shared/schema.ts";
import type { ArchiveManifestEntry, DecisionEntry } from "./drift-analytics-types.ts";

// ---- Internal row types ----

export type ReviewRow = {
  id: number;
  review_id: string;
  timestamp: string;
  files: string;
  honored: string;
  score: string;
  verdict: string;
  pr_number: number | null;
  branch: string | null;
  last_reviewed_sha: string | null;
  file_priorities: string | null;
  recommendations: string | null;
};

export type ViolationRow = {
  id: number;
  review_id: string;
  principle_id: string;
  severity: string;
  file_path: string | null;
  impact_score: number | null;
  message: string | null;
};

export type FlowRunRow = {
  id: number;
  run_id: string;
  flow: string;
  tier: string;
  task: string;
  started: string;
  completed: string;
  total_duration_ms: number;
  state_durations: string;
  state_iterations: string;
  skipped_states: string;
  total_spawns: number;
  gate_pass_rate: number | null;
  postcondition_pass_rate: number | null;
  total_violations: number | null;
  total_test_results: string | null;
  total_files_changed: number | null;
  commits: string | null;
  diff_stat: string | null;
};

export type DecisionRow = {
  id: number;
  decision_id: string;
  run_id: string | null;
  flow: string | null;
  task: string | null;
  title: string;
  content: string;
  file_path: string | null;
  timestamp: string;
};

export type ArchiveRow = {
  id: number;
  archive_id: string;
  branch: string;
  sanitized_branch: string;
  slug: string;
  flow: string;
  tier: string;
  task: string;
  archived_at: string;
  archive_path: string;
  artifact_types: string; // JSON array
  has_run_summary: number; // INTEGER: 0 or 1
  source_run_id: string | null;
};

// ---- Row deserializers ----

/** Deserialize a ReviewRow + ViolationRow[] into a ReviewEntry. */
export function rowToReviewEntry(row: ReviewRow, violations: ViolationRow[]): ReviewEntry {
  const entry: ReviewEntry = {
    files: JSON.parse(row.files) as string[],
    honored: JSON.parse(row.honored) as string[],
    review_id: row.review_id,
    score: JSON.parse(row.score) as ReviewEntry["score"],
    timestamp: row.timestamp,
    verdict: row.verdict as ReviewEntry["verdict"],
    violations: violations.map((v) => {
      const violation: ReviewViolation = {
        principle_id: v.principle_id,
        severity: v.severity,
      };
      if (v.file_path !== null) violation.file_path = v.file_path;
      if (v.impact_score !== null) violation.impact_score = v.impact_score;
      if (v.message !== null) violation.message = v.message;
      return violation;
    }),
  };
  if (row.pr_number !== null) entry.pr_number = row.pr_number;
  if (row.branch !== null) entry.branch = row.branch;
  if (row.last_reviewed_sha !== null) entry.last_reviewed_sha = row.last_reviewed_sha;
  if (row.file_priorities !== null)
    entry.file_priorities = JSON.parse(row.file_priorities) as ReviewEntry["file_priorities"];
  if (row.recommendations !== null)
    entry.recommendations = JSON.parse(row.recommendations) as ReviewEntry["recommendations"];
  return entry;
}

/** Deserialize a DecisionRow into a DecisionEntry. */
export function rowToDecisionEntry(row: DecisionRow): DecisionEntry {
  const entry: DecisionEntry = {
    content: row.content,
    decision_id: row.decision_id,
    timestamp: row.timestamp,
    title: row.title,
  };
  if (row.run_id !== null) entry.run_id = row.run_id;
  if (row.flow !== null) entry.flow = row.flow;
  if (row.task !== null) entry.task = row.task;
  if (row.file_path !== null) entry.file_path = row.file_path;
  return entry;
}

/**
 * Deserialize an ArchiveRow into an ArchiveManifestEntry.
 * Handles JSON parsing of artifact_types and INTEGER→boolean for has_run_summary.
 * validate-at-trust-boundaries: artifact_types crosses a serialization boundary.
 */
export function rowToArchiveManifestEntry(row: ArchiveRow): ArchiveManifestEntry {
  let artifact_types: string[];
  try {
    artifact_types = JSON.parse(row.artifact_types) as string[];
  } catch {
    // Malformed JSON in artifact_types column — return empty array as fallback
    artifact_types = [];
  }
  return {
    archive_id: row.archive_id,
    archive_path: row.archive_path,
    archived_at: row.archived_at,
    artifact_types,
    branch: row.branch,
    flow: row.flow,
    has_run_summary: row.has_run_summary !== 0,
    sanitized_branch: row.sanitized_branch,
    slug: row.slug,
    source_run_id: row.source_run_id,
    task: row.task,
    tier: row.tier,
  };
}

/** Build the parameter object for the reviews INSERT statement. Pure function — no class state. */
export function buildReviewParams(entry: ReviewEntry): Record<string, unknown> {
  return {
    branch: entry.branch ?? null,
    file_priorities: entry.file_priorities != null ? JSON.stringify(entry.file_priorities) : null,
    files: JSON.stringify(entry.files),
    honored: JSON.stringify(entry.honored),
    last_reviewed_sha: entry.last_reviewed_sha ?? null,
    pr_number: entry.pr_number ?? null,
    recommendations: entry.recommendations != null ? JSON.stringify(entry.recommendations) : null,
    review_id: entry.review_id,
    score: JSON.stringify(entry.score),
    timestamp: entry.timestamp,
    verdict: entry.verdict,
  };
}
