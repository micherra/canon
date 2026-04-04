/**
 * Shared type definitions for flow run analytics.
 * Imported by both analytics.ts and drift-db.ts to avoid circular dependencies.
 */

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
};

export type FlowAnalytics = {
  total_runs: number;
  avg_duration_ms: number;
  avg_gate_pass_rate?: number;
  avg_postcondition_pass_rate?: number;
};
