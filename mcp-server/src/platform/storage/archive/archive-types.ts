/**
 * Archive-module types — shared types for workspace archival and run-summary extraction.
 *
 * These types live here (not in features/history) because archive-service,
 * run-summary-builder, and run-summary-extractors are all platform-level services
 * that must not import from a feature context.
 *
 * history-types.ts re-exports these for consumers that import from the history
 * bounded context — no call sites need to change.
 *
 * Canon principles:
 *   - bounded-context-boundaries: platform types may not import from @features
 */

import type { ContextProvenanceSummary } from "../../../domains/workspaces/context-provenance.ts";

// Re-export so callers that need the summary type can import from here.
export type { ContextProvenanceSummary };

// ---- Run summary sub-types (used by run-summary-extractors and run-summary-builder) ----

/** A single step in the runbook extracted from runbook.md. */
export type RunbookStep = {
  step_id: string;
  agent: string;
  hitl?: string;
};

/** Planner context extracted from planning-brief.md and runbook.md. */
export type PlannerContext = {
  outcome: string;
  effort_estimate: string;
  value_estimate: string;
  assumptions: string[];
  recommended_approach: string;
  runbook_steps: RunbookStep[];
};

/** Step outcome extracted from journal.json. */
export type StepOutcome = {
  step_id: string;
  agent_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  artifacts_expected: string[];
  /** Recorded execution_states.metrics for this step (tool_calls/orientation_calls/turns,
   *  orchestrator fields, and #473 stage_metrics), joined at archive time by step_id.
   *  Optional — absent for steps with no recorded metrics or pre-existing archives. */
  metrics?: Record<string, number | string | Record<string, Record<string, number>>>;
};

/** A single violation from a review file. */
export type ReviewViolation = {
  principle_id: string;
  severity: string;
  file_path: string | null;
  message: string;
};

/** Review result extracted from REVIEW.md files. */
export type ReviewResult = {
  verdict: string;
  files_reviewed: number;
  principles_checked: number;
  violations: ReviewViolation[];
  honored: string[];
};

/** Artifact inventory — what was archived. */
export type ArtifactInventory = {
  directories: { name: string; file_count: number }[];
  files: string[];
  total_files: number;
};

/**
 * Structured run summary — the primary artifact for cross-run analysis.
 * Versioned with version: 1 to support future schema evolution.
 * aggregates-reference-by-id: references archives by archive_path, not by embedding content.
 *
 * Backward compat note: decision_summaries was populated from the decisions/ workspace
 * directory (removed 2026-05-25). The field is retained as an always-empty array so
 * version: 1 consumers that branch on its presence remain compatible.
 */
export type RunSummary = {
  version: 1;
  archive_id: string;
  run_metadata: {
    branch: string;
    slug: string;
    flow: string;
    tier: string;
    task: string;
    started_at: string | null;
    completed_at: string | null;
    archived_at: string;
    total_duration_ms: number | null;
  };
  planner_context: PlannerContext | null;
  step_outcomes: StepOutcome[];
  review_results: ReviewResult[];
  /** Always empty — retained for version: 1 backward compatibility. */
  decision_summaries: [];
  artifact_inventory: ArtifactInventory;
  /** Per-step context provenance (hashes + spans only; agent_id joined from back-fill events).
   *  Optional + defaults to [] — additive for version: 1 backward compatibility. */
  context_provenance?: ContextProvenanceSummary[];
};
