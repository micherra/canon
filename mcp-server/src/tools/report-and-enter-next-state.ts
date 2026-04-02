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
import type { ToolResult } from "../utils/tool-result.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";
import { enterAndPrepareState } from "./enter-and-prepare-state.ts";
import type { SpawnPromptEntry, TaskItem } from "./get-spawn-prompt.ts";
import { reportResult } from "./report-result.ts";

export interface ReportAndEnterNextStateInput {
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

  // Enter-next-state fields
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  wave?: number;
  peer_count?: number;
}

export interface ReportAndEnterNextStateResult {
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
}

export async function reportAndEnterNextState(
  input: ReportAndEnterNextStateInput,
): Promise<ToolResult<ReportAndEnterNextStateResult>> {
  // Step 1: Report result for current state
  // Destructure enter-specific fields; the rest maps 1:1 to reportResult input.
  const { variables, items, role, wave, peer_count, ...reportInput } = input;
  const reportOutput = await reportResult(reportInput);

  if (!reportOutput.ok) return reportOutput;

  const result: ReportAndEnterNextStateResult = {
    report: {
      transition_condition: reportOutput.transition_condition,
      next_state: reportOutput.next_state,
      stuck: reportOutput.stuck,
      stuck_reason: reportOutput.stuck_reason,
      hitl_required: reportOutput.hitl_required,
      hitl_reason: reportOutput.hitl_reason,
    },
    board: reportOutput.board,
  };

  // Step 2: If HITL required or no next state (terminal flow), return report only
  if (reportOutput.hitl_required || !reportOutput.next_state) {
    return { ok: true as const, ...result };
  }

  // Step 3: Check if next state is terminal or a virtual sink (e.g. "no_items", "hitl")
  const nextStateDef = input.flow.states[reportOutput.next_state];
  if (!nextStateDef || nextStateDef.type === "terminal") {
    return { ok: true as const, ...result };
  }

  // Step 4: Enter and prepare the next state
  const enterOutput = await enterAndPrepareState({
    workspace: input.workspace,
    state_id: reportOutput.next_state,
    flow: input.flow,
    variables: input.variables,
    items: input.items,
    role: input.role,
    wave: input.wave,
    peer_count: input.peer_count,
    project_dir: input.project_dir,
  });

  if (!enterOutput.ok) return enterOutput;

  result.enter = {
    can_enter: enterOutput.can_enter,
    iteration_count: enterOutput.iteration_count,
    max_iterations: enterOutput.max_iterations,
    cannot_fix_items: enterOutput.cannot_fix_items,
    history: enterOutput.history,
    convergence_reason: enterOutput.convergence_reason,
    prompts: enterOutput.prompts,
    state_type: enterOutput.state_type,
    skip_reason: enterOutput.skip_reason,
    warnings: enterOutput.warnings,
    clusters: enterOutput.clusters,
    timeout_ms: enterOutput.timeout_ms,
    fanned_out: enterOutput.fanned_out,
    consultation_prompts: enterOutput.consultation_prompts,
    board: enterOutput.board,
  };

  if (enterOutput.board) {
    result.board = enterOutput.board;
  }

  return { ok: true as const, ...result };
}
