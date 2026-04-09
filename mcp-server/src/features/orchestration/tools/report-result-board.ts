/**
 * Board mutation functions for report-result.
 * Pure functions over the Board aggregate — no store I/O.
 */

import {
  accumulateCannotFix,
  appendConcern,
  completeState,
  setBlocked,
} from "@domains/board/board.ts";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type {
  DiscoveredGate,
  GateResult,
  PostconditionAssertion,
  PostconditionResult,
  ResolvedFlow,
  StuckWhen,
  TestResults,
  ViolationSeverities,
} from "@domains/flows/flow-definition-schemas.ts";
import { STATUS_ALIASES, STATUS_KEYWORDS } from "@domains/flows/flow-definition-schemas.ts";
import type { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { inspectDebateProgress } from "../engine/debate.ts";
import {
  aggregateParallelPerResults,
  aggregateReviewResults,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  isRoleOptional,
  isStuck,
  normalizeStatus,
} from "../engine/transitions.ts";
import type { ReportResultInput } from "./report-result-types.ts";

// Pure board mutation helpers — extracted to reduce transaction complexity

export function updateBoardStateField(
  board: Board,
  stateId: string,
  fields: Record<string, unknown>,
): Board {
  if (!board.states[stateId]) return board;
  return {
    ...board,
    states: {
      ...board.states,
      [stateId]: { ...board.states[stateId], ...fields },
    },
  };
}

function enrichBoardMetrics(
  board: Board,
  input: {
    state_id: string;
    metrics?: Record<string, unknown>;
    gate_results?: GateResult[];
    postcondition_results?: PostconditionResult[];
    violation_count?: number;
    violation_severities?: ViolationSeverities;
    test_results?: TestResults;
    files_changed?: number;
  },
): Board {
  const hasCallerMetrics =
    input.metrics != null ||
    input.gate_results?.length ||
    input.postcondition_results?.length ||
    input.violation_count != null ||
    input.violation_severities != null ||
    input.test_results != null ||
    input.files_changed != null;

  if (!hasCallerMetrics || !board.states[input.state_id]) return board;

  const currentMetrics = board.states[input.state_id]?.metrics ?? {};
  const enrichedMetrics = {
    ...currentMetrics,
    ...(input.metrics ?? {}),
    ...(input.gate_results?.length ? { gate_results: input.gate_results } : {}),
    ...(input.postcondition_results?.length
      ? { postcondition_results: input.postcondition_results }
      : {}),
    ...(input.violation_count != null ? { violation_count: input.violation_count } : {}),
    ...(input.violation_severities ? { violation_severities: input.violation_severities } : {}),
    ...(input.test_results ? { test_results: input.test_results } : {}),
    ...(input.files_changed != null ? { files_changed: input.files_changed } : {}),
    ...(board.iterations[input.state_id]
      ? { revision_count: board.iterations[input.state_id].count }
      : {}),
  };

  return updateBoardStateField(board, input.state_id, { metrics: enrichedMetrics });
}

function applyResultFields(
  board: Board,
  stateId: string,
  gateResults?: GateResult[],
  postconditionResults?: PostconditionResult[],
): Board {
  let result = board;
  if (gateResults?.length)
    result = updateBoardStateField(result, stateId, { gate_results: gateResults });
  if (postconditionResults?.length)
    result = updateBoardStateField(result, stateId, {
      postcondition_results: postconditionResults,
    });
  return result;
}

function applyDiscoveredItems(
  board: Board,
  stateId: string,
  gates?: DiscoveredGate[],
  postconditions?: PostconditionAssertion[],
): Board {
  let result = board;
  if (gates?.length && result.states[stateId]) {
    result = updateBoardStateField(result, stateId, {
      discovered_gates: [...(result.states[stateId].discovered_gates ?? []), ...gates],
    });
  }
  if (postconditions?.length && result.states[stateId]) {
    result = updateBoardStateField(result, stateId, {
      discovered_postconditions: [
        ...(result.states[stateId].discovered_postconditions ?? []),
        ...postconditions,
      ],
    });
  }
  return result;
}

function applyCompeteResults(
  board: Board,
  stateId: string,
  competeResults?: Array<{ lens?: string; status: string; artifacts?: string[] }>,
  synthesized?: boolean,
): Board {
  if (competeResults?.length && board.states[stateId]) {
    return updateBoardStateField(board, stateId, {
      compete_results: competeResults,
      ...(synthesized != null ? { synthesized } : {}),
    });
  }
  if (synthesized != null && board.states[stateId]) {
    return updateBoardStateField(board, stateId, { synthesized });
  }
  return board;
}

export function applyDiscoveries(
  board: Board,
  stateId: string,
  input: {
    gate_results?: GateResult[];
    postcondition_results?: PostconditionResult[];
    discovered_gates?: DiscoveredGate[];
    discovered_postconditions?: PostconditionAssertion[];
    compete_results?: Array<{ lens?: string; status: string; artifacts?: string[] }>;
    synthesized?: boolean;
  },
): Board {
  let result = applyResultFields(board, stateId, input.gate_results, input.postcondition_results);
  result = applyDiscoveredItems(
    result,
    stateId,
    input.discovered_gates,
    input.discovered_postconditions,
  );
  return applyCompeteResults(result, stateId, input.compete_results, input.synthesized);
}

function collectOptionalRoles(
  roles?: Array<string | { name: string; optional?: boolean }>,
): Set<string> {
  const result = new Set<string>();
  if (!roles) return result;
  for (const roleEntry of roles) {
    if (isRoleOptional(roleEntry)) {
      result.add(typeof roleEntry === "string" ? roleEntry : roleEntry.name);
    }
  }
  return result;
}

export function aggregateParallelResultsOnBoard(
  board: Board,
  stateId: string,
  parallelResults: Array<{ item: string; status: string; artifacts?: string[] }>,
  stateDef: { roles?: Array<string | { name: string; optional?: boolean }> } | undefined,
): { board: Board; condition: string } {
  const isReviewAgg = parallelResults.every((r) =>
    ["clean", "warning", "blocking"].includes(r.status.toLowerCase()),
  );
  const optionalRoles = collectOptionalRoles(stateDef?.roles);
  const aggregated = isReviewAgg
    ? aggregateReviewResults(parallelResults)
    : aggregateParallelPerResults(
        parallelResults,
        optionalRoles.size > 0 ? optionalRoles : undefined,
      );

  let result = updateBoardStateField(board, stateId, { parallel_results: parallelResults });

  if (aggregated.cannotFixItems.length > 0 && result.iterations[stateId]) {
    const iteration = result.iterations[stateId];
    result = {
      ...result,
      iterations: {
        ...result.iterations,
        [stateId]: { ...iteration, cannot_fix: iteration.cannot_fix ?? [] },
      },
    };
  }

  return { board: result, condition: aggregated.condition };
}

export type DetectStuckOptions = {
  condition: string;
  stateDef: { stuck_when?: StuckWhen } | undefined;
  input: {
    principle_ids?: string[];
    file_paths?: string[];
    file_test_pairs?: Array<{ file: string; test: string }>;
    commit_sha?: string;
    artifact_count?: number;
  };
  store: ReturnType<typeof getExecutionStore>;
};

export function detectStuck(
  board: Board,
  stateId: string,
  options: DetectStuckOptions,
): { board: Board; stuck: boolean; stuck_reason?: string } {
  const { condition, stateDef, input, store } = options;
  if (!stateDef?.stuck_when || !board.iterations[stateId]) {
    return { board, stuck: false };
  }
  const iteration = board.iterations[stateId];
  const historyEntry = buildHistoryEntry(stateDef.stuck_when, {
    artifactCount: input.artifact_count,
    commitSha: input.commit_sha,
    filePaths: input.file_paths,
    pairs: input.file_test_pairs,
    principleIds: input.principle_ids,
    status: condition,
  });
  const iterationData: Record<string, unknown> = {
    status: condition,
    ...(input.principle_ids ? { principle_ids: input.principle_ids } : {}),
    ...(input.file_paths ? { file_paths: input.file_paths } : {}),
    ...(input.file_test_pairs ? { pairs: input.file_test_pairs } : {}),
    ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
    ...(input.artifact_count != null ? { artifact_count: input.artifact_count } : {}),
  };
  store.recordIterationResult(stateId, iteration.count, condition, iterationData);
  const updatedHistory = [...iteration.history, historyEntry];
  const updatedBoard = {
    ...board,
    iterations: { ...board.iterations, [stateId]: { ...iteration, history: updatedHistory } },
  };

  if (isStuck(updatedHistory, stateDef.stuck_when)) {
    return {
      board: updatedBoard,
      stuck: true,
      stuck_reason: `Agent is stuck in state '${stateId}' (${stateDef.stuck_when})`,
    };
  }
  return { board: updatedBoard, stuck: false };
}

export function applyDebateResult(
  board: Board,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>>,
  stateId: string,
  debate: NonNullable<ResolvedFlow["debate"]>,
): { board: Board; nextState: string | null; hitl_required: boolean; hitl_reason?: string } {
  const updatedBoard = {
    ...board,
    metadata: {
      ...(board.metadata ?? {}),
      debate_completed: debateResult.completed,
      debate_last_round: debateResult.last_completed_round,
      ...(debateResult.summary ? { debate_summary: debateResult.summary } : {}),
    },
  };
  if (!debateResult.completed)
    return { board: updatedBoard, hitl_required: false, nextState: stateId };
  if (debate.hitl_checkpoint) {
    return {
      board: updatedBoard,
      hitl_reason: `Debate completed after round ${debateResult.last_completed_round}${debateResult.convergence?.reason ? `: ${debateResult.convergence.reason}` : ""}`,
      hitl_required: true,
      nextState: null,
    };
  }
  return { board: updatedBoard, hitl_required: false, nextState: null };
}

export function resolveCondition(
  board: Board,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
): { board: Board; condition: string } {
  let condition = normalizeStatus(input.status_keyword);

  if (input.flow.review_threshold && stateDef?.transitions) {
    condition = applyReviewThresholdToCondition(
      input.flow.review_threshold,
      condition,
      stateDef.transitions,
    );
  }

  if (input.parallel_results && input.parallel_results.length > 0) {
    const agg = aggregateParallelResultsOnBoard(
      board,
      input.state_id,
      input.parallel_results,
      stateDef,
    );
    return { board: agg.board, condition: agg.condition };
  }

  return { board, condition };
}

export type FinalizeTransitionOptions = {
  stateId: string;
  condition: string;
  statusKeyword: string;
  stateType: string | undefined;
  nextState: string | null;
  stuckResult: { stuck: boolean; stuck_reason?: string };
  hitl_required: boolean;
  hitl_reason: string | undefined;
};

export function finalizeTransition(
  board: Board,
  options: FinalizeTransitionOptions,
): { board: Board; hitl_required: boolean; hitl_reason?: string } {
  const { stateId, condition, statusKeyword, stateType, nextState, stuckResult } = options;
  let { hitl_required, hitl_reason } = options;
  const resolved = resolveHitl({
    condition,
    nextState,
    priorHitl: { reason: hitl_reason, required: hitl_required },
    stateId,
    stateType,
    statusKeyword,
    stuck: stuckResult.stuck,
    stuckReason: stuckResult.stuck_reason,
  });
  hitl_required = resolved.hitl_required;
  hitl_reason = resolved.hitl_reason;
  let result = board;
  if (resolved.board_blocked) result = setBlocked(result, stateId, hitl_reason!);
  if (hitl_required && hitl_reason && result.blocked == null && stateType !== "terminal") {
    result = setBlocked(result, stateId, hitl_reason);
  }
  if (nextState && nextState !== "hitl") result = { ...result, current_state: nextState };
  return { board: result, hitl_reason, hitl_required };
}

export type ResolveHitlOptions = {
  stuck: boolean;
  stuckReason: string | undefined;
  nextState: string | null;
  stateId: string;
  condition: string;
  statusKeyword: string;
  stateType: string | undefined;
  priorHitl: { required: boolean; reason?: string };
};

function resolveHitl(options: ResolveHitlOptions): {
  hitl_required: boolean;
  hitl_reason?: string;
  board_blocked: boolean;
} {
  const { stuck, stuckReason, nextState, stateId, condition, statusKeyword, stateType, priorHitl } =
    options;
  if (priorHitl.required)
    return { board_blocked: false, hitl_reason: priorHitl.reason, hitl_required: true };
  if (stuck) return { board_blocked: false, hitl_reason: stuckReason, hitl_required: true };
  if (nextState === "hitl") {
    return {
      board_blocked: false,
      hitl_reason: `Transition from '${stateId}' on '${condition}' leads to hitl`,
      hitl_required: true,
    };
  }
  if (nextState === null && stateType !== "terminal") {
    const lowered = statusKeyword.toLowerCase();
    const isRecognized =
      (STATUS_KEYWORDS as readonly string[]).includes(lowered) || lowered in STATUS_ALIASES;
    const reason = isRecognized
      ? `No matching transition from '${stateId}' for condition '${condition}'`
      : `Unrecognized status keyword '${statusKeyword}' from state '${stateId}' (normalized to '${condition}')`;
    return { board_blocked: true, hitl_reason: reason, hitl_required: true };
  }
  return { board_blocked: false, hitl_required: false };
}

/**
 * Applies concern note, state completion, metrics enrichment, and discovery fields to the board.
 * Pure pipeline over the board — no store I/O.
 */
export function applyBoardMutations(
  board: Board,
  input: ReportResultInput,
  condition: string,
  stateDef: ResolvedFlow["states"][string] | undefined,
): Board {
  let result = board;
  if (input.status_keyword.toLowerCase() === "done_with_concerns" && input.concern_text) {
    result = appendConcern(
      result,
      input.state_id,
      stateDef?.agent ?? input.state_id,
      input.concern_text,
    );
  }
  result = applyStateCompletion(result, input.state_id, condition, input.artifacts);
  result = enrichBoardMetrics(result, input);
  return applyDiscoveries(result, input.state_id, input);
}

/**
 * Applies state completion to board, using completeState when the state is in_progress,
 * or falling back to a direct board mutation for states not yet in_progress.
 * Backward compat: reportResult may be called without a prior enterState call.
 * We do NOT call enterState here to avoid incrementing the iteration count as a side-effect.
 */
function applyStateCompletion(
  board: Board,
  stateId: string,
  condition: string,
  artifacts: string[] | undefined,
): Board {
  const completeResult = completeState(board, stateId, condition, artifacts);
  if (!completeResult.ok) {
    const now = new Date().toISOString();
    const prev = board.states[stateId];
    const updated = {
      ...(prev ?? { entries: 0 }),
      completed_at: now,
      result: condition,
      status: "done" as const,
      ...(artifacts ? { artifacts } : {}),
    };
    return { ...board, last_updated: now, states: { ...board.states, [stateId]: updated } };
  }
  return completeResult.board;
}

type ApplyStuckOptions = {
  board: Board;
  stateId: string;
  condition: string;
  nextState: string | null;
  input: ReportResultInput;
  stateDef: ResolvedFlow["states"][string] | undefined;
  store: ReturnType<typeof getExecutionStore>;
};

/**
 * Runs stuck detection and, when condition is cannot_fix, accumulates cannot_fix items.
 * Returns updated board, next state (nulled if stuck), and the stuck result metadata.
 */
export function applyStuckAndCannotFix(options: ApplyStuckOptions): {
  board: Board;
  nextState: string | null;
  stuckResult: ReturnType<typeof detectStuck>;
} {
  const { board, stateId, condition, nextState, input, stateDef, store } = options;
  const stuckResult = detectStuck(board, stateId, { condition, input, stateDef, store });
  let result = stuckResult.board;
  const resolvedNext = stuckResult.stuck ? null : nextState;

  if (condition === "cannot_fix" && input.principle_ids && input.file_paths) {
    result = accumulateCannotFix(result, stateId, input.principle_ids, input.file_paths);
  }
  return { board: result, nextState: resolvedNext, stuckResult };
}

type DebateHitl = {
  board: Board;
  nextState: string | null;
  hitl_required: boolean;
  hitl_reason?: string;
};

type ApplyDebateHitlOptions = {
  board: Board;
  debate: ResolvedFlow["debate"];
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  nextState: string | null;
  stateId: string;
};

export function applyDebateHitl(options: ApplyDebateHitlOptions): DebateHitl {
  const { board, debate, debateResult, nextState, stateId } = options;
  if (debateResult === undefined) return { board, hitl_required: false, nextState };
  const dr = applyDebateResult(board, debateResult, stateId, debate!);
  return {
    board: dr.board,
    hitl_reason: dr.hitl_reason,
    hitl_required: dr.hitl_required,
    nextState: dr.nextState,
  };
}
