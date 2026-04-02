/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import { completeState, setBlocked } from "../orchestration/board.ts";
import { inspectDebateProgress } from "../orchestration/debate.ts";
import { executeEffects } from "../orchestration/effects.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type {
  Board,
  CannotFixItem,
  DiscoveredGate,
  GateResult,
  PostconditionAssertion,
  PostconditionResult,
  ResolvedFlow,
  StateDefinition,
  TestResults,
  ViolationSeverities,
} from "../orchestration/flow-schema.ts";
import { STATUS_ALIASES, STATUS_KEYWORDS } from "../orchestration/flow-schema.ts";
import {
  aggregateParallelPerResults,
  aggregateReviewResults,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  evaluateTransition,
  isRoleOptional,
  isStuck,
  normalizeStatus,
} from "../orchestration/transitions.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import { toolError } from "../utils/tool-result.ts";

interface ReportResultInput {
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
  // Optional progress line to append to progress.md (saves a separate Write call)
  progress_line?: string;
  // Project directory for drift effect persistence
  project_dir?: string;
}

interface LogEntry {
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
}

interface ReportResultResult {
  transition_condition: string;
  next_state: string | null;
  board: Board;
  stuck: boolean;
  stuck_reason?: string;
  hitl_required: boolean;
  hitl_reason?: string;
  log_entry: LogEntry;
}

interface TransactionResult {
  board: Board;
  condition: string;
  nextState: string | null;
  stuck: boolean;
  stuck_reason: string | undefined;
  hitl_required: boolean;
  hitl_reason: string | undefined;
}

// ---------------------------------------------------------------------------
// Helper: immutable board state entry patch
// ---------------------------------------------------------------------------
function patchBoardStateEntry(board: Board, stateId: string, patch: Record<string, unknown>): Board {
  return {
    ...board,
    states: {
      ...board.states,
      [stateId]: {
        ...board.states[stateId],
        ...patch,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: immutable board iteration patch
// ---------------------------------------------------------------------------
function patchBoardIteration(board: Board, stateId: string, patch: Record<string, unknown>): Board {
  return {
    ...board,
    iterations: {
      ...board.iterations,
      [stateId]: {
        ...board.iterations[stateId],
        ...patch,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: aggregate parallel results and update board + condition
// ---------------------------------------------------------------------------
function aggregateParallelAndPatch(
  board: Board,
  input: ReportResultInput,
  condition: string,
  stateDef: StateDefinition | undefined,
): { board: Board; condition: string } {
  const results = input.parallel_results;
  if (!results || results.length === 0) {
    return { board, condition };
  }

  const isReviewAggregation = results.every((r) => ["clean", "warning", "blocking"].includes(r.status.toLowerCase()));

  const optionalRoles = buildOptionalRoles(stateDef);

  const aggregated = isReviewAggregation
    ? aggregateReviewResults(results)
    : aggregateParallelPerResults(results, optionalRoles.size > 0 ? optionalRoles : undefined);
  const newCondition = aggregated.condition;

  let updatedBoard = patchBoardStateEntry(board, input.state_id, {
    parallel_results: results,
  });

  // Accumulate cannot_fix items in iteration record
  if (aggregated.cannotFixItems.length > 0 && updatedBoard.iterations[input.state_id]) {
    const iteration = updatedBoard.iterations[input.state_id];
    const existingCannotFix = iteration.cannot_fix ?? [];
    updatedBoard = patchBoardIteration(updatedBoard, input.state_id, {
      cannot_fix: existingCannotFix,
    });
  }

  return { board: updatedBoard, condition: newCondition };
}

// ---------------------------------------------------------------------------
// Helper: build optional roles set from state definition
// ---------------------------------------------------------------------------
function buildOptionalRoles(stateDef: StateDefinition | undefined): Set<string> {
  const optionalRoles = new Set<string>();
  if (!stateDef || !("roles" in stateDef) || !stateDef.roles) {
    return optionalRoles;
  }
  for (const roleEntry of stateDef.roles) {
    if (isRoleOptional(roleEntry)) {
      const name = typeof roleEntry === "string" ? roleEntry : roleEntry.name;
      optionalRoles.add(name);
    }
  }
  return optionalRoles;
}

// ---------------------------------------------------------------------------
// Helper: append concern to board
// ---------------------------------------------------------------------------
function appendConcern(board: Board, input: ReportResultInput, stateDef: StateDefinition | undefined): Board {
  if (input.status_keyword.toLowerCase() !== "done_with_concerns" || !input.concern_text) {
    return board;
  }
  const agent = stateDef?.agent ?? input.state_id;
  return {
    ...board,
    concerns: [
      ...board.concerns,
      {
        state_id: input.state_id,
        agent,
        message: input.concern_text,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper: enrich and store metrics on board state
// ---------------------------------------------------------------------------
function enrichAndStoreMetrics(board: Board, input: ReportResultInput): Board {
  const hasCallerMetrics =
    input.metrics != null ||
    (input.gate_results != null && input.gate_results.length > 0) ||
    (input.postcondition_results != null && input.postcondition_results.length > 0) ||
    input.violation_count != null ||
    input.violation_severities != null ||
    input.test_results != null ||
    input.files_changed != null;

  if (!hasCallerMetrics || !board.states[input.state_id]) {
    return board;
  }

  const currentMetrics = board.states[input.state_id]?.metrics ?? {};
  const enrichedMetrics = {
    ...currentMetrics,
    ...(input.metrics ?? {}),
    ...(input.gate_results?.length ? { gate_results: input.gate_results } : {}),
    ...(input.postcondition_results?.length ? { postcondition_results: input.postcondition_results } : {}),
    ...(input.violation_count != null ? { violation_count: input.violation_count } : {}),
    ...(input.violation_severities ? { violation_severities: input.violation_severities } : {}),
    ...(input.test_results ? { test_results: input.test_results } : {}),
    ...(input.files_changed != null ? { files_changed: input.files_changed } : {}),
    ...(board.iterations[input.state_id] ? { revision_count: board.iterations[input.state_id].count } : {}),
  };

  return patchBoardStateEntry(board, input.state_id, { metrics: enrichedMetrics });
}

// ---------------------------------------------------------------------------
// Helper: store gate/postcondition/discovered/compete results on board state
// ---------------------------------------------------------------------------
function storeBoardStateResults(board: Board, input: ReportResultInput): Board {
  let b = board;
  const sid = input.state_id;

  if (input.gate_results?.length && b.states[sid]) {
    b = patchBoardStateEntry(b, sid, { gate_results: input.gate_results });
  }

  if (input.postcondition_results?.length && b.states[sid]) {
    b = patchBoardStateEntry(b, sid, { postcondition_results: input.postcondition_results });
  }

  if (input.discovered_gates?.length && b.states[sid]) {
    const existing = b.states[sid].discovered_gates ?? [];
    b = patchBoardStateEntry(b, sid, {
      discovered_gates: [...existing, ...input.discovered_gates],
    });
  }

  if (input.discovered_postconditions?.length && b.states[sid]) {
    const existing = b.states[sid].discovered_postconditions ?? [];
    b = patchBoardStateEntry(b, sid, {
      discovered_postconditions: [...existing, ...input.discovered_postconditions],
    });
  }

  b = storeCompeteResults(b, input);

  return b;
}

// ---------------------------------------------------------------------------
// Helper: persist compete results / synthesized flag
// ---------------------------------------------------------------------------
function storeCompeteResults(board: Board, input: ReportResultInput): Board {
  const sid = input.state_id;

  if (input.compete_results?.length && board.states[sid]) {
    return patchBoardStateEntry(board, sid, {
      compete_results: input.compete_results,
      ...(input.synthesized != null ? { synthesized: input.synthesized } : {}),
    });
  }
  if (input.synthesized != null && board.states[sid]) {
    return patchBoardStateEntry(board, sid, { synthesized: input.synthesized });
  }
  return board;
}

// ---------------------------------------------------------------------------
// Helper: stuck detection — returns updated board, stuck flag, and reason
// ---------------------------------------------------------------------------
function detectStuck(
  board: Board,
  input: ReportResultInput,
  condition: string,
  stateDef: StateDefinition | undefined,
  store: ReturnType<typeof getExecutionStore>,
): { board: Board; stuck: boolean; stuck_reason: string | undefined } {
  if (!stateDef?.stuck_when || !board.iterations[input.state_id]) {
    return { board, stuck: false, stuck_reason: undefined };
  }

  const iteration = board.iterations[input.state_id];
  const historyEntry = buildHistoryEntry(stateDef.stuck_when, {
    status: condition,
    principleIds: input.principle_ids,
    filePaths: input.file_paths,
    pairs: input.file_test_pairs,
    commitSha: input.commit_sha,
    artifactCount: input.artifact_count,
  });

  // Record iteration result to SQL table for SQL-based stuck detection
  const iterationData: Record<string, unknown> = {
    status: condition,
    ...(input.principle_ids ? { principle_ids: input.principle_ids } : {}),
    ...(input.file_paths ? { file_paths: input.file_paths } : {}),
    ...(input.file_test_pairs ? { pairs: input.file_test_pairs } : {}),
    ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
    ...(input.artifact_count != null ? { artifact_count: input.artifact_count } : {}),
  };
  store.recordIterationResult(input.state_id, iteration.count, condition, iterationData);

  const updatedHistory = [...iteration.history, historyEntry];
  const updatedBoard = patchBoardIteration(board, input.state_id, {
    history: updatedHistory,
  });

  const stuck = isStuck(updatedHistory, stateDef.stuck_when);
  const stuck_reason = stuck ? `Agent is stuck in state '${input.state_id}' (${stateDef.stuck_when})` : undefined;

  return { board: updatedBoard, stuck, stuck_reason };
}

// ---------------------------------------------------------------------------
// Helper: accumulate cannot_fix items
// ---------------------------------------------------------------------------
function accumulateCannotFix(board: Board, input: ReportResultInput, condition: string): Board {
  if (condition !== "cannot_fix" || !board.iterations[input.state_id]) {
    return board;
  }

  const iteration = board.iterations[input.state_id];
  const newCannotFixItems: CannotFixItem[] = [];

  if (input.principle_ids && input.file_paths) {
    for (const principleId of input.principle_ids) {
      for (const filePath of input.file_paths) {
        newCannotFixItems.push({ principle_id: principleId, file_path: filePath });
      }
    }
  }

  if (newCannotFixItems.length === 0) {
    return board;
  }

  const existingCannotFix = iteration.cannot_fix ?? [];
  const deduped = newCannotFixItems.filter(
    (item) =>
      !existingCannotFix.some(
        (existing) => existing.principle_id === item.principle_id && existing.file_path === item.file_path,
      ),
  );

  if (deduped.length === 0) {
    return board;
  }

  return patchBoardIteration(board, input.state_id, {
    cannot_fix: [...existingCannotFix, ...deduped],
  });
}

// ---------------------------------------------------------------------------
// Helper: apply debate result (pre-fetched before transaction)
// ---------------------------------------------------------------------------
function applyDebateResult(
  board: Board,
  input: ReportResultInput,
  nextState: string | null,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined,
): { board: Board; nextState: string | null; hitl_required: boolean; hitl_reason: string | undefined } {
  if (debateResult === undefined) {
    return { board, nextState, hitl_required: false, hitl_reason: undefined };
  }

  const updatedBoard: Board = {
    ...board,
    metadata: {
      ...(board.metadata ?? {}),
      debate_last_round: debateResult.last_completed_round,
      debate_completed: debateResult.completed,
      ...(debateResult.summary ? { debate_summary: debateResult.summary } : {}),
    },
  };

  if (!debateResult.completed) {
    return { board: updatedBoard, nextState: input.state_id, hitl_required: false, hitl_reason: undefined };
  }

  if (input.flow.debate?.hitl_checkpoint) {
    const reason = `Debate completed after round ${debateResult.last_completed_round}${
      debateResult.convergence?.reason ? `: ${debateResult.convergence.reason}` : ""
    }`;
    return { board: updatedBoard, nextState: null, hitl_required: true, hitl_reason: reason };
  }

  return { board: updatedBoard, nextState, hitl_required: false, hitl_reason: undefined };
}

// ---------------------------------------------------------------------------
// Helper: detect HITL requirement from stuck/transition/unrecognized status
// ---------------------------------------------------------------------------
function detectHitl(
  board: Board,
  input: ReportResultInput,
  condition: string,
  nextState: string | null,
  stuck: boolean,
  stuck_reason: string | undefined,
  debateHitl: boolean,
  debateHitlReason: string | undefined,
  stateDef: StateDefinition | undefined,
): { board: Board; hitl_required: boolean; hitl_reason: string | undefined } {
  let hitl_required = debateHitl;
  let hitl_reason = debateHitlReason;
  let b = board;

  if (stuck) {
    hitl_required = true;
    hitl_reason = stuck_reason;
  } else if (nextState === "hitl") {
    hitl_required = true;
    hitl_reason = `Transition from '${input.state_id}' on '${condition}' leads to hitl`;
  } else if (!hitl_required && nextState === null && stateDef?.type !== "terminal") {
    hitl_required = true;
    const loweredKeyword = input.status_keyword.toLowerCase();
    const isRecognized =
      (STATUS_KEYWORDS as readonly string[]).includes(loweredKeyword) || loweredKeyword in STATUS_ALIASES;
    hitl_reason = isRecognized
      ? `No matching transition from '${input.state_id}' for condition '${condition}'`
      : `Unrecognized status keyword '${input.status_keyword}' from state '${input.state_id}' (normalized to '${condition}')`;
    b = setBlocked(b, input.state_id, hitl_reason);
  }

  if (hitl_required && hitl_reason && b.blocked == null && stateDef?.type !== "terminal") {
    b = setBlocked(b, input.state_id, hitl_reason);
  }

  return { board: b, hitl_required, hitl_reason };
}

// ---------------------------------------------------------------------------
// Helper: emit stuck_detected event (best-effort)
// ---------------------------------------------------------------------------
function emitStuckEvent(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  input: ReportResultInput,
  stuck: boolean,
  stuck_reason: string | undefined,
  stateDef: StateDefinition | undefined,
): void {
  if (!stuck || !stuck_reason) {
    return;
  }

  const correlationId = store.getCorrelationId();
  const iteration = board.iterations[input.state_id];
  const history = iteration?.history ?? [];
  const iterationCount = history.length;
  const previous = history.length >= 2 ? (history[history.length - 2] as Record<string, unknown>) : {};
  const current = history.length >= 1 ? (history[history.length - 1] as Record<string, unknown>) : {};
  const stuckPayload = {
    stateId: input.state_id,
    strategy: stateDef?.stuck_when ?? "unknown",
    reason: stuck_reason,
    iteration_count: iterationCount,
    comparison: { previous, current },
    timestamp: new Date().toISOString(),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  };
  try {
    store.appendEvent("stuck_detected", stuckPayload, correlationId ?? undefined);
  } catch {
    /* best-effort */
  }
  try {
    flowEventBus.emit("stuck_detected", stuckPayload);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Helper: emit flow events (state_completed, transition_evaluated, hitl_triggered)
// ---------------------------------------------------------------------------
function emitFlowEvents(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  condition: string,
  nextState: string | null,
  hitl_required: boolean,
  hitl_reason: string | undefined,
): void {
  const correlationId = store.getCorrelationId();
  const onStateCompleted = (event: import("../orchestration/events.js").FlowEventMap["state_completed"]) => {
    try {
      store.appendEvent("state_completed", event as Record<string, unknown>, correlationId ?? undefined);
    } catch {
      /* best-effort */
    }
  };
  const onTransitionEvaluated = (event: import("../orchestration/events.js").FlowEventMap["transition_evaluated"]) => {
    try {
      store.appendEvent("transition_evaluated", event as Record<string, unknown>, correlationId ?? undefined);
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("state_completed", onStateCompleted);
  flowEventBus.once("transition_evaluated", onTransitionEvaluated);
  try {
    emitStateCompleted(input, condition, correlationId);
    emitTransitionEvaluated(input, condition, nextState, correlationId);
    if (hitl_required) {
      flowEventBus.emit("hitl_triggered", {
        stateId: input.state_id,
        reason: hitl_reason ?? "unknown",
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    flowEventBus.removeListener("state_completed", onStateCompleted);
    flowEventBus.removeListener("transition_evaluated", onTransitionEvaluated);
  }
}

// ---------------------------------------------------------------------------
// Helper: emit state_completed event
// ---------------------------------------------------------------------------
function emitStateCompleted(input: ReportResultInput, condition: string, correlationId: string | null): void {
  flowEventBus.emit("state_completed", {
    stateId: input.state_id,
    result: condition,
    duration_ms: input.metrics?.duration_ms ?? 0,
    artifacts: input.artifacts ?? [],
    timestamp: new Date().toISOString(),
    ...(input.gate_results?.length ? { gate_results: input.gate_results } : {}),
    ...(input.postcondition_results?.length ? { postcondition_results: input.postcondition_results } : {}),
    ...(input.violation_count != null ? { violation_count: input.violation_count } : {}),
    ...(input.violation_severities ? { violation_severities: input.violation_severities } : {}),
    ...(input.test_results ? { test_results: input.test_results } : {}),
    ...(input.files_changed != null ? { files_changed: input.files_changed } : {}),
    ...(input.discovered_gates?.length ? { discovered_gates_count: input.discovered_gates.length } : {}),
    ...(input.discovered_postconditions?.length
      ? { discovered_postconditions_count: input.discovered_postconditions.length }
      : {}),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Helper: emit transition_evaluated event
// ---------------------------------------------------------------------------
function emitTransitionEvaluated(
  input: ReportResultInput,
  condition: string,
  nextState: string | null,
  correlationId: string | null,
): void {
  flowEventBus.emit("transition_evaluated", {
    stateId: input.state_id,
    statusKeyword: input.status_keyword,
    normalizedCondition: condition,
    nextState: nextState ?? "null",
    timestamp: new Date().toISOString(),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Helper: build log entry
// ---------------------------------------------------------------------------
function buildLogEntry(
  input: ReportResultInput,
  condition: string,
  nextState: string | null,
  stuck: boolean,
  stuck_reason: string | undefined,
  hitl_required: boolean,
  hitl_reason: string | undefined,
): LogEntry {
  return {
    state_id: input.state_id,
    status_keyword: input.status_keyword,
    normalized_condition: condition,
    next_state: nextState,
    stuck,
    hitl_required,
    timestamp: new Date().toISOString(),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(stuck_reason ? { stuck_reason } : {}),
    ...(hitl_reason ? { hitl_reason } : {}),
    ...(input.gate_results?.length ? { gate_results: input.gate_results } : {}),
    ...(input.postcondition_results?.length ? { postcondition_results: input.postcondition_results } : {}),
    ...(input.violation_count != null ? { violation_count: input.violation_count } : {}),
    ...(input.violation_severities ? { violation_severities: input.violation_severities } : {}),
    ...(input.test_results ? { test_results: input.test_results } : {}),
    ...(input.files_changed != null ? { files_changed: input.files_changed } : {}),
    ...(input.discovered_gates?.length ? { discovered_gates_count: input.discovered_gates.length } : {}),
    ...(input.discovered_postconditions?.length
      ? { discovered_postconditions_count: input.discovered_postconditions.length }
      : {}),
  };
}

/**
 * Sync a Board object back to the ExecutionStore after mutation.
 * Updates execution-level fields, states, and iterations.
 */
function syncBoardToStore(store: ReturnType<typeof getExecutionStore>, board: Board): void {
  store.updateExecution({
    current_state: board.current_state,
    blocked: board.blocked,
    concerns: board.concerns,
    skipped: board.skipped,
    metadata: board.metadata,
    last_updated: board.last_updated,
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, { ...stateEntry, status: stateEntry.status, entries: stateEntry.entries });
  }
  for (const [stateId, iterEntry] of Object.entries(board.iterations)) {
    store.upsertIteration(stateId, {
      count: iterEntry.count,
      max: iterEntry.max,
      history: iterEntry.history,
      cannot_fix: iterEntry.cannot_fix,
    });
  }
}

export async function reportResult(input: ReportResultInput): Promise<ToolResult<ReportResultResult>> {
  return reportResultLocked(input);
}

async function reportResultLocked(input: ReportResultInput): Promise<ToolResult<ReportResultResult>> {
  const store = getExecutionStore(input.workspace);

  if (!store.getBoard()) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found in workspace: ${input.workspace}`);
  }

  // Pre-fetch debate progress asynchronously before entering the synchronous transaction.
  const debateResult = await prefetchDebateProgress(input);

  const txResult = store.transaction((): TransactionResult => {
    return runTransaction(store, input, debateResult);
  });

  const { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason } = txResult;

  appendProgressLine(store, input);
  await executeDriftEffects(input);
  emitStuckEvent(store, board, input, stuck, stuck_reason, input.flow.states[input.state_id]);
  emitFlowEvents(store, input, condition, nextState, hitl_required, hitl_reason);

  const log_entry = buildLogEntry(input, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason);

  return {
    ok: true as const,
    transition_condition: condition,
    next_state: nextState,
    board,
    stuck,
    stuck_reason,
    hitl_required,
    hitl_reason,
    log_entry,
  };
}

// ---------------------------------------------------------------------------
// Helper: pre-fetch debate progress before entering synchronous transaction
// ---------------------------------------------------------------------------
async function prefetchDebateProgress(
  input: ReportResultInput,
): Promise<Awaited<ReturnType<typeof inspectDebateProgress>> | undefined> {
  if (input.state_id === input.flow.entry && input.flow.debate) {
    return inspectDebateProgress(input.workspace, input.flow.debate);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: the synchronous transaction body
// ---------------------------------------------------------------------------
function runTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined,
): TransactionResult {
  let board = store.getBoard();
  if (!board) {
    throw new Error(`No execution found in workspace: ${input.workspace}`);
  }

  const stateDef = input.flow.states[input.state_id];

  // Normalize status keyword
  let condition = normalizeStatus(input.status_keyword);

  // Apply review threshold if flow has one
  if (input.flow.review_threshold && stateDef?.transitions) {
    condition = applyReviewThresholdToCondition(input.flow.review_threshold, condition, stateDef.transitions);
  }

  // Aggregate parallel results
  const parallelResult = aggregateParallelAndPatch(board, input, condition, stateDef);
  board = parallelResult.board;
  condition = parallelResult.condition;

  // Handle done_with_concerns
  board = appendConcern(board, input, stateDef);

  // Complete the state in board
  board = completeState(board, input.state_id, condition, input.artifacts);

  // Enrich and store metrics
  board = enrichAndStoreMetrics(board, input);

  // Store gate/postcondition/discovered/compete results
  board = storeBoardStateResults(board, input);

  // Stuck detection
  const stuckResult = detectStuck(board, input, condition, stateDef, store);
  board = stuckResult.board;

  let nextState = stateDef ? evaluateTransition(stateDef, condition) : null;
  if (stuckResult.stuck) {
    nextState = null;
  }

  // Accumulate cannot_fix items
  board = accumulateCannotFix(board, input, condition);

  // Apply debate result
  const debate = applyDebateResult(board, input, nextState, debateResult);
  board = debate.board;
  nextState = debate.nextState;

  // Detect HITL requirement
  const hitl = detectHitl(
    board,
    input,
    condition,
    nextState,
    stuckResult.stuck,
    stuckResult.stuck_reason,
    debate.hitl_required,
    debate.hitl_reason,
    stateDef,
  );
  board = hitl.board;

  // Update current_state if we have a valid next state
  if (nextState && nextState !== "hitl") {
    board = { ...board, current_state: nextState };
  }

  syncBoardToStore(store, board);

  return {
    board,
    condition,
    nextState,
    stuck: stuckResult.stuck,
    stuck_reason: stuckResult.stuck_reason,
    hitl_required: hitl.hitl_required,
    hitl_reason: hitl.hitl_reason,
  };
}

// ---------------------------------------------------------------------------
// Helper: append progress line (best-effort)
// ---------------------------------------------------------------------------
function appendProgressLine(store: ReturnType<typeof getExecutionStore>, input: ReportResultInput): void {
  if (!input.progress_line) {
    return;
  }
  try {
    store.appendProgress(input.progress_line);
  } catch {
    // best-effort — never blocks the flow
  }
}

// ---------------------------------------------------------------------------
// Helper: execute drift effects (best-effort)
// ---------------------------------------------------------------------------
async function executeDriftEffects(input: ReportResultInput): Promise<void> {
  const stateDef = input.flow.states[input.state_id];
  if (!stateDef?.effects?.length || !input.artifacts?.length) {
    return;
  }
  const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
  await executeEffects(stateDef, input.workspace, input.artifacts, projectDir).catch(() => {
    // best-effort — never blocks the flow
  });
}
