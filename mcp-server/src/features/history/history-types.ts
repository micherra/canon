/**
 * History feature type definitions — bounded context for cross-run analysis.
 *
 * ArchiveManifestEntry and ArchiveManifestFilter live in the shared kernel
 * (drift-analytics-types.ts) so DriftDb can use them without importing from
 * this bounded context. History-specific types (RunSummary, cross-run analysis)
 * live here and must not be imported by the shared kernel.
 *
 * bounded-context-boundaries: imports from shared kernel (re-exports for
 * consumers that only need to import from this module), history-only types stay here.
 */

// Re-export shared types so consumers can import from one place
export type {
  ArchiveManifestEntry,
  ArchiveManifestFilter,
} from "../../platform/storage/drift/drift-analytics-types.ts";

// --- Result shapes for tools ---

/** Result shape for get_build_history tool. */
export type BuildHistoryResult = {
  archives: import("../../platform/storage/drift/drift-analytics-types.ts").ArchiveManifestEntry[];
  total_count: number;
};

/** Artifact content returned by get_historical_artifacts. */
export type HistoricalArtifact = {
  path: string;
  content: string;
  size_bytes: number;
};

/** Result shape for get_historical_artifacts tool. */
export type HistoricalArtifactsResult = {
  archive_id: string;
  archive_path: string;
  artifacts: HistoricalArtifact[];
};

// --- Run Summary types ---

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

/** Decision summary extracted from decision files. */
export type DecisionSummary = {
  decision_id: string;
  title: string;
  chosen_option: string;
  rationale_snippet: string;
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
  decision_summaries: DecisionSummary[];
  artifact_inventory: ArtifactInventory;
};

// --- Cross-run analysis types ---

/** A violation that recurs across multiple runs. */
export type RecurringViolation = {
  principle_id: string;
  severity: string;
  occurrence_count: number;
  affected_files: string[];
  first_seen: string;
  last_seen: string;
};

/** Pattern of how long it takes to fix a recurring violation. */
export type FixCyclePattern = {
  principle_id: string;
  avg_fix_duration_ms: number;
  fix_count: number;
  recurrence_rate: number;
};

/** Trend data for agent/flow performance over time. */
export type AgentPerformanceTrend = {
  flow: string;
  avg_duration_ms: number;
  avg_spawns: number;
  run_count: number;
  trend: "improving" | "stable" | "degrading";
};

/** Analysis of planner patterns across runs. */
export type PlannerPatternAnalysis = {
  total_runs_with_planner: number;
  common_assumptions: { assumption: string; occurrence_count: number }[];
  effort_accuracy: {
    estimate: string;
    actual_avg_duration_ms: number;
    sample_count: number;
  }[];
  value_distribution: { value: string; count: number }[];
};

/** Full cross-run analysis result. */
export type CrossRunAnalysisResult = {
  recurring_violations: RecurringViolation[];
  fix_cycle_patterns: FixCyclePattern[];
  agent_performance_trends: AgentPerformanceTrend[];
  planner_patterns: PlannerPatternAnalysis;
  total_archived_runs: number;
  analysis_window: { from: string; to: string };
};
