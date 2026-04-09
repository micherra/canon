/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import { syncBoardToStore } from "@domains/board/board-sync.ts";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import {
  type BaselineEvidence,
  BaselineEvidenceSchema,
  type DiscoveredGate,
  type GateResult,
  type PostconditionAssertion,
  type PostconditionResult,
  type ResolvedFlow,
  type TestResults,
  type ViolationSeverities,
} from "@domains/flows/flow-definition-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import { inspectDebateProgress } from "../engine/debate.ts";
import { evaluateTransition } from "../engine/transitions.ts";
import {
  applyBoardMutations,
  applyDebateHitl,
  applyStuckAndCannotFix,
  finalizeTransition,
  resolveCondition,
} from "./report-result-board.ts";
import { postTransactionSideEffects } from "./report-result-side-effects.ts";
import {
  SUCCESS_STATUSES,
  validateRequiredArtifacts,
  validateRequiredHandoffs,
} from "./report-result-validation.ts";

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

export { validateRequiredArtifacts, validateRequiredHandoffs };

export async function reportResult(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  return reportResultLocked(input);
}

function checkTestResultConsistency(input: ReportResultInput): ToolResult<void> | null {
  if (!input.test_results || input.test_results.failed <= 0) return null;

  const rawStatusLower = input.status_keyword.toLowerCase();
  if (!SUCCESS_STATUSES.has(rawStatusLower)) return null;

  // Status implies success but test_results.failed > 0 — require baseline evidence
  if (!input.baseline_evidence) {
    return toolError(
      "INVALID_INPUT",
      `Status '${input.status_keyword}' reported with ${input.test_results.failed} test failure(s) but no baseline_evidence provided. ` +
        `Either fix all failures, provide baseline_evidence proving they pre-date your changes, ` +
        `or report IMPLEMENTATION_ISSUE/BLOCKED.`,
      true, // recoverable — agent can retry with correct status or provide evidence
    );
  }

  // Validate the baseline evidence schema
  const parseResult = BaselineEvidenceSchema.safeParse(input.baseline_evidence);
  if (!parseResult.success) {
    return toolError(
      "INVALID_INPUT",
      `baseline_evidence failed validation: ${parseResult.error.message}`,
      true,
    );
  }

  if (parseResult.data.new_failures.length > 0) {
    const { baseline_commit, new_failures } = parseResult.data;
    return toolError(
      "INVALID_INPUT",
      `Status '${input.status_keyword}' reported but baseline_evidence shows ${new_failures.length} NEW test failure(s) ` +
        `not present at ${baseline_commit}: ${new_failures.join(", ")}. ` +
        `Fix new failures or report IMPLEMENTATION_ISSUE.`,
      true,
    );
  }

  return null; // All failures are pre-existing — proceed to success with escalation
}

async function validatePreTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
): Promise<ToolResult<void> | null> {
  if (!store.getBoard()) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found in workspace: ${input.workspace}`);
  }

  // Consistency check: status/test-result alignment (argu-02)
  const consistencyError = checkTestResultConsistency(input);
  if (consistencyError) return consistencyError;

  if (stateDef?.required_artifacts?.length) {
    const validationError = await validateRequiredArtifacts(
      input.workspace,
      input.artifacts ?? [],
      stateDef.required_artifacts,
    );
    if (validationError) return validationError;
  }
  return null;
}

function executeReportTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined,
): TransactionResult {
  return store.transaction((): TransactionResult => {
    let board = store.getBoard();
    if (!board) throw new Error(`No execution found in workspace: ${input.workspace}`);

    const { board: b1, condition } = resolveCondition(board, input, stateDef);
    let nextState: string | null = stateDef ? evaluateTransition(stateDef, condition) : null;

    board = applyBoardMutations(b1, input, condition, stateDef);

    const stuckAndFix = applyStuckAndCannotFix({
      board,
      condition,
      input,
      nextState,
      stateDef,
      stateId: input.state_id,
      store,
    });
    board = stuckAndFix.board;
    nextState = stuckAndFix.nextState;
    const { stuckResult } = stuckAndFix;

    const debate = applyDebateHitl({
      board,
      debate: input.flow.debate,
      debateResult,
      nextState,
      stateId: input.state_id,
    });
    board = debate.board;
    nextState = debate.nextState;

    const finalResult = finalizeTransition(board, {
      condition,
      hitl_reason: debate.hitl_reason,
      hitl_required: debate.hitl_required,
      nextState,
      stateId: input.state_id,
      stateType: stateDef?.type,
      statusKeyword: input.status_keyword,
      stuckResult,
    });
    board = finalResult.board;
    syncBoardToStore(store, board);

    return {
      board,
      condition,
      hitl_reason: finalResult.hitl_reason,
      hitl_required: finalResult.hitl_required,
      nextState,
      stuck: stuckResult.stuck,
      stuck_reason: stuckResult.stuck_reason,
    };
  });
}

async function reportResultLocked(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  const store = getExecutionStore(input.workspace);
  const stateDef = input.flow.states[input.state_id];

  const preError = await validatePreTransaction(store, input, stateDef);
  if (preError) return preError;

  // Determine HITL escalation signal for pre-existing failures (argu-02)
  // We know baseline_evidence is valid here (consistency check passed above)
  const escalateToHitl = computeEscalateToHitl(input);

  let debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  if (input.state_id === input.flow.entry && input.flow.debate) {
    debateResult = await inspectDebateProgress(input.workspace, input.flow.debate);
  }

  const txResult = executeReportTransaction(store, input, stateDef, debateResult);

  return postTransactionSideEffects({ escalateToHitl, input, stateDef, store, txResult });
}

/** Computes the escalate_to_hitl payload when baseline evidence confirms pre-existing failures. */
function computeEscalateToHitl(
  input: ReportResultInput,
): ReportResultResult["escalate_to_hitl"] | undefined {
  if (!input.test_results || input.test_results.failed <= 0) return undefined;
  if (!input.baseline_evidence) return undefined;

  const rawStatusLower = input.status_keyword.toLowerCase();
  if (!SUCCESS_STATUSES.has(rawStatusLower)) return undefined;

  // All failures are pre-existing (new_failures is empty — checked in validatePreTransaction)
  return {
    baseline_evidence: input.baseline_evidence,
    reason:
      `Status '${input.status_keyword}' reported with ${input.test_results.failed} pre-existing test failure(s) ` +
      `confirmed against baseline commit '${input.baseline_evidence.baseline_commit}'. ` +
      `Human review required before advancing.`,
  };
}
