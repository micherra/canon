/**
 * Shared types for the report-result split files.
 * Imported by report-result-board.ts and report-result-side-effects.ts.
 * Re-exported from report-result.ts for backward compatibility.
 */

import type { Board } from "@domains/flows/board-state-schemas.ts";
import type {
  BaselineEvidence,
  DiscoveredGate,
  GateResult,
  PostconditionAssertion,
  PostconditionResult,
  ResolvedFlow,
  TestResults,
  ViolationSeverities,
} from "@domains/flows/flow-definition-schemas.ts";

export type ReportResultInput = {
  workspace: string;
  state_id: string;
  status_keyword: string;
  flow: ResolvedFlow;
  artifacts?: string[];
  concern_text?: string;
  error?: string;
  metrics?: {
    duration_ms: number;
    spawns: number;
    model: string;
    // ADR-003a agent performance metrics (all optional for backward compat)
    tool_calls?: number;
    orientation_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    turns?: number;
  };
  parallel_results?: Array<{
    item: string;
    status: string;
    artifacts?: string[];
  }>;
  // Stuck detection data — callers must provide these for non-same_status strategies
  principle_ids?: string[];
  file_paths?: string[];
  file_test_pairs?: Array<{ file: string; test: string }>;
  commit_sha?: string;
  artifact_count?: number;
  // Quality gate results reported by the agent
  gate_results?: GateResult[];
  postcondition_results?: PostconditionResult[];
  violation_count?: number;
  violation_severities?: ViolationSeverities;
  test_results?: TestResults;
  files_changed?: number;
  // Discovery fields — agents report what gate commands and postconditions they discovered
  discovered_gates?: DiscoveredGate[];
  discovered_postconditions?: PostconditionAssertion[];
  // Compete results — persisted to board state for synthesizer access
  compete_results?: Array<{ lens?: string; status: string; artifacts?: string[] }>;
  synthesized?: boolean;
  // Baseline evidence for pre-existing test failures (argu-02)
  baseline_evidence?: BaselineEvidence;
  // Optional progress line to append to progress.md (saves a separate Write call)
  progress_line?: string;
  // Project directory for drift effect persistence
  project_dir?: string;
  // ADR-015: path to the agent transcript JSONL file (best-effort persistence)
  transcript_path?: string;
};

export type TransactionResult = {
  board: Board;
  condition: string;
  nextState: string | null;
  stuck: boolean;
  stuck_reason: string | undefined;
  hitl_required: boolean;
  hitl_reason: string | undefined;
};

export type LogEntry = {
  state_id: string;
  status_keyword: string;
  normalized_condition: string;
  next_state: string | null;
  stuck: boolean;
  hitl_required: boolean;
  timestamp: string;
  artifacts?: string[];
  error?: string;
  metrics?: {
    duration_ms: number;
    spawns: number;
    model: string;
    tool_calls?: number;
    orientation_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    turns?: number;
  };
  stuck_reason?: string;
  hitl_reason?: string;
  // Quality signal fields
  gate_results?: GateResult[];
  postcondition_results?: PostconditionResult[];
  violation_count?: number;
  violation_severities?: ViolationSeverities;
  test_results?: TestResults;
  files_changed?: number;
  discovered_gates_count?: number;
  discovered_postconditions_count?: number;
};

export type ReportResultResult = {
  transition_condition: string;
  next_state: string | null;
  board: Board;
  stuck: boolean;
  stuck_reason?: string;
  hitl_required: boolean;
  hitl_reason?: string;
  log_entry: LogEntry;
  /** Set when pre-existing test failures have been documented with baseline evidence. */
  escalate_to_hitl?: {
    reason: string;
    baseline_evidence: BaselineEvidence;
  };
  /** Non-blocking warnings for missing or mistyped handoff files (ADR-018). */
  warnings?: string[];
};
