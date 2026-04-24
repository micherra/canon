/**
 * Shared type definitions for flow run analytics and archive manifests.
 * Imported by both analytics.ts and drift-db.ts to avoid circular dependencies.
 * ArchiveManifestEntry lives here (shared kernel) so DriftDb can use it without
 * importing from the history feature bounded context.
 */

/** Metadata for a single archived workspace. */
export type ArchiveManifestEntry = {
  archive_id: string;
  branch: string;
  sanitized_branch: string;
  slug: string;
  flow: string;
  tier: string;
  task: string;
  archived_at: string;
  archive_path: string;
  artifact_types: string[];
  has_run_summary: boolean;
  source_run_id: string | null;
};

/** Filter options for querying archive manifests. */
export type ArchiveManifestFilter = {
  branch?: string;
  flow?: string;
  limit?: number;
};

export type FlowRunEntry = {
  run_id: string;
  flow: string;
  tier: string;
  task: string;
  started: string;
  completed: string;
  total_duration_ms: number;
  state_durations: Record<string, number>;
  state_iterations: Record<string, number>;
  skipped_states: string[];
  total_spawns: number;
  // Aggregated quality signals (optional — absent for old entries and runs with no data)
  gate_pass_rate?: number;
  postcondition_pass_rate?: number;
  total_violations?: number;
  total_test_results?: { passed: number; failed: number; skipped: number };
  total_files_changed?: number;
  // ADR-019 additions: git metadata
  commits?: string[];
  diff_stat?: string;
};

export type FlowAnalytics = {
  total_runs: number;
  avg_duration_ms: number;
  avg_gate_pass_rate?: number;
  avg_postcondition_pass_rate?: number;
};

export type DecisionEntry = {
  decision_id: string;
  run_id?: string;
  flow?: string;
  task?: string;
  title: string;
  content: string;
  file_path?: string;
  timestamp: string;
};
