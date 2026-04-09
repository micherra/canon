/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import { syncBoardToStore } from "@domains/board/board-sync.ts";
import {
  BaselineEvidenceSchema,
  type ResolvedFlow,
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
import type {
  ReportResultInput,
  ReportResultResult,
  TransactionResult,
} from "./report-result-types.ts";
import {
  SUCCESS_STATUSES,
  validateRequiredArtifacts,
  validateRequiredHandoffs,
} from "./report-result-validation.ts";

// Re-export types for backward compatibility — callers import from this file
export type { LogEntry, ReportResultResult } from "./report-result-types.ts";
export type { ReportResultInput };
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
