/**
 * Combined tool: report_result + enter_and_prepare_state in a single round-trip.
 * Reduces per-state MCP calls from 2 to 1 (after the initial state entry).
 *
 * Behavior:
 * 1. Call reportResult() with the current state's data.
 * 2. If hitl_required or next_state is null (terminal) → return report result only.
 * 3. If next state is a terminal state → return report result only.
 * 4. Otherwise, call enterAndPrepareState() for the next state.
 * 5. Return combined result.
 */

import type { FileCluster } from "../orchestration/diff-cluster.ts";
import type {
  Board,
  CannotFixItem,
  DiscoveredGate,
  GateResult,
  HistoryEntry,
  PostconditionAssertion,
  PostconditionResult,
  ResolvedFlow,
  TestResults,
  ViolationSeverities,
} from "../orchestration/flow-schema.ts";
import type { ToolResult } from "../shared/lib/tool-result.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import type { SpawnPromptEntry, TaskItem } from "./get-spawn-prompt.ts";
import { reportResult } from "./report-result.ts";

export type ReportAndEnterNextStateInput = {
  // All fields from ReportResultInput
  workspace: string;
  state_id: string;
  status_keyword: string;
  flow: ResolvedFlow;
  artifacts?: string[];
  concern_text?: string;
  error?: string;
  metrics?: { duration_ms: number; spawns: number; model: string };
  parallel_results?: Array<{ item: string; status: string; artifacts?: string[] }>;
  principle_ids?: string[];
  file_paths?: string[];
  file_test_pairs?: Array<{ file: string; test: string }>;
  commit_sha?: string;
  artifact_count?: number;
  gate_results?: GateResult[];
  postcondition_results?: PostconditionResult[];
  violation_count?: number;
  violation_severities?: ViolationSeverities;
  test_results?: TestResults;
  files_changed?: number;
  discovered_gates?: DiscoveredGate[];
  discovered_postconditions?: PostconditionAssertion[];
  compete_results?: Array<{ lens?: string; status: string; artifacts?: string[] }>;
  synthesized?: boolean;
  progress_line?: string;
  project_dir?: string;
  // ADR-015: path to the agent transcript JSONL file
  transcript_path?: string;

  // Enter-next-state fields
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  wave?: number;
  peer_count?: number;
};

export type ReportAndEnterNextStateResult = {
  // Report phase results (always present)
  report: {
    transition_condition: string;
    next_state: string | null;
    stuck: boolean;
    stuck_reason?: string;
    hitl_required: boolean;
    hitl_reason?: string;
  };

  // Enter phase results (only present when next state was entered)
  enter?: {
    can_enter: boolean;
    iteration_count: number;
    max_iterations: number;
    cannot_fix_items: CannotFixItem[];
    history: HistoryEntry[];
    convergence_reason?: string;
    prompts: SpawnPromptEntry[];
    state_type: string;
    skip_reason?: string;
    warnings?: string[];
    clusters?: FileCluster[];
    timeout_ms?: number;
    fanned_out?: boolean;
    consultation_prompts?: ConsultationPromptEntry[];
    board?: Board;
  };

  // Final board state
  board: Board;
};

async function enterNextState(
  input: ReportAndEnterNextStateInput,
  nextStateId: string,
  result: ReportAndEnterNextStateResult,
): Promise<ToolResult<ReportAndEnterNextStateResult>> {
  const enterOutput = await enterAndPrepareState({
    flow: input.flow,
    items: input.items,
    peer_count: input.peer_count,
    project_dir: input.project_dir,
    role: input.role,
    state_id: nextStateId,
    variables: input.variables,
    wave: input.wave,
    workspace: input.workspace,
  });

  if (!enterOutput.ok) return enterOutput;

  result.enter = {
    board: enterOutput.board,
    can_enter: enterOutput.can_enter,
    cannot_fix_items: enterOutput.cannot_fix_items,
    clusters: enterOutput.clusters,
    consultation_prompts: enterOutput.consultation_prompts,
    convergence_reason: enterOutput.convergence_reason,
    fanned_out: enterOutput.fanned_out,
    history: enterOutput.history,
    iteration_count: enterOutput.iteration_count,
    max_iterations: enterOutput.max_iterations,
    prompts: enterOutput.prompts,
    skip_reason: enterOutput.skip_reason,
    state_type: enterOutput.state_type,
    timeout_ms: enterOutput.timeout_ms,
    warnings: enterOutput.warnings,
  };

  if (enterOutput.board) {
    result.board = enterOutput.board;
  }

  return { ok: true as const, ...result };
}

export async function reportAndEnterNextState(
  input: ReportAndEnterNextStateInput,
): Promise<ToolResult<ReportAndEnterNextStateResult>> {
  const { variables, items, role, wave, peer_count, ...reportInput } = input;
  const reportOutput = await reportResult(reportInput);

  if (!reportOutput.ok) return reportOutput;

  const result: ReportAndEnterNextStateResult = {
    board: reportOutput.board,
    report: {
      hitl_reason: reportOutput.hitl_reason,
      hitl_required: reportOutput.hitl_required,
      next_state: reportOutput.next_state,
      stuck: reportOutput.stuck,
      stuck_reason: reportOutput.stuck_reason,
      transition_condition: reportOutput.transition_condition,
    },
  };

  if (reportOutput.hitl_required || !reportOutput.next_state) {
    return { ok: true as const, ...result };
  }

  const nextStateDef = input.flow.states[reportOutput.next_state];
  if (!nextStateDef || nextStateDef.type === "terminal") {
    return { ok: true as const, ...result };
  }

  return enterNextState(input, reportOutput.next_state, result);
}
