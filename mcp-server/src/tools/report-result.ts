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
  metrics?: { duration_ms: number; spawns: number; model: string };
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
  metrics?: { duration_ms: number; spawns: number; model: string };
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

/** Aggregate parallel results and update condition and board state. */
function aggregateParallelResults(
  input: ReportResultInput,
  board: Board,
  condition: string,
  stateDef: ReturnType<typeof Object> | undefined,
): { board: Board; condition: string } {
  if (!input.parallel_results || input.parallel_results.length === 0) {
    return { board, condition };
  }

  const isReviewAggregation = input.parallel_results.every((r) =>
    ["clean", "warning", "blocking"].includes(r.status.toLowerCase()),
  );

  const optionalRoles = new Set<string>();
  if ((stateDef as { roles?: Array<string | { name: string; optional?: boolean }> })?.roles) {
    for (const roleEntry of (stateDef as { roles: Array<string | { name: string; optional?: boolean }> }).roles) {
      if (isRoleOptional(roleEntry)) {
        const name = typeof roleEntry === "string" ? roleEntry : roleEntry.name;
        optionalRoles.add(name);
      }
    }
  }

  const aggregated = isReviewAggregation
    ? aggregateReviewResults(input.parallel_results)
    : aggregateParallelPerResults(input.parallel_results, optionalRoles.size > 0 ? optionalRoles : undefined);

  let updatedBoard: Board = {
    ...board,
    states: {
      ...board.states,
      [input.state_id]: {
        ...board.states[input.state_id],
        parallel_results: input.parallel_results,
      },
    },
  };

  if (aggregated.cannotFixItems.length > 0 && updatedBoard.iterations[input.state_id]) {
    const iteration = updatedBoard.iterations[input.state_id];
    updatedBoard = {
      ...updatedBoard,
      iterations: {
        ...updatedBoard.iterations,
        [input.state_id]: {
          ...iteration,
          cannot_fix: iteration.cannot_fix ?? [],
        },
      },
    };
  }

  return { board: updatedBoard, condition: aggregated.condition };
}

/** Check if the caller provided any metric or signal fields. */
function hasCallerMetrics(input: ReportResultInput): boolean {
  return (
    input.metrics != null ||
    !!input.gate_results?.length ||
    !!input.postcondition_results?.length ||
    input.violation_count != null ||
    input.violation_severities != null ||
    input.test_results != null ||
    input.files_changed != null
  );
}

/** Build enriched metrics object from input signals. */
function buildEnrichedMetrics(
  input: ReportResultInput,
  currentMetrics: Record<string, unknown>,
  iterationCount: number | undefined,
): Record<string, unknown> {
  return {
    ...currentMetrics,
    ...(input.metrics ?? {}),
    ...(input.gate_results?.length ? { gate_results: input.gate_results } : {}),
    ...(input.postcondition_results?.length ? { postcondition_results: input.postcondition_results } : {}),
    ...(input.violation_count != null ? { violation_count: input.violation_count } : {}),
    ...(input.violation_severities ? { violation_severities: input.violation_severities } : {}),
    ...(input.test_results ? { test_results: input.test_results } : {}),
    ...(input.files_changed != null ? { files_changed: input.files_changed } : {}),
    ...(iterationCount != null ? { revision_count: iterationCount } : {}),
  };
}

/** Enrich board state with metrics, gate results, postcondition results, and discovery data. */
function enrichBoardState(input: ReportResultInput, board: Board): Board {
  const stateId = input.state_id;
  const stateEntry = board.states[stateId];
  if (!stateEntry) return board;

  const enrichedState = { ...stateEntry };

  if (hasCallerMetrics(input)) {
    const iterCount = board.iterations[stateId]?.count;
    enrichedState.metrics = buildEnrichedMetrics(input, stateEntry.metrics ?? {}, iterCount);
  }

  if (input.gate_results?.length) enrichedState.gate_results = input.gate_results;
  if (input.postcondition_results?.length) enrichedState.postcondition_results = input.postcondition_results;
  if (input.discovered_gates?.length)
    enrichedState.discovered_gates = [...(stateEntry.discovered_gates ?? []), ...input.discovered_gates];
  if (input.discovered_postconditions?.length)
    enrichedState.discovered_postconditions = [
      ...(stateEntry.discovered_postconditions ?? []),
      ...input.discovered_postconditions,
    ];

  if (input.compete_results?.length) {
    enrichedState.compete_results = input.compete_results;
    if (input.synthesized != null) enrichedState.synthesized = input.synthesized;
  } else if (input.synthesized != null) {
    enrichedState.synthesized = input.synthesized;
  }

  return { ...board, states: { ...board.states, [stateId]: enrichedState } };
}

/** Detect if the agent is stuck and update iteration history. */
function detectStuck(
  input: ReportResultInput,
  board: Board,
  condition: string,
  stateDef: import("../orchestration/flow-schema.ts").StateDefinition | undefined,
): { board: Board; stuck: boolean; stuck_reason?: string } {
  if (!stateDef?.stuck_when || !board.iterations[input.state_id]) {
    return { board, stuck: false };
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

  const updatedHistory = [...iteration.history, historyEntry];
  const updatedBoard: Board = {
    ...board,
    iterations: {
      ...board.iterations,
      [input.state_id]: { ...iteration, history: updatedHistory },
    },
  };

  if (isStuck(updatedHistory, stateDef.stuck_when)) {
    return {
      board: updatedBoard,
      stuck: true,
      stuck_reason: `Agent is stuck in state '${input.state_id}' (${stateDef.stuck_when})`,
    };
  }

  return { board: updatedBoard, stuck: false };
}

/** Accumulate cannot_fix items when agent reports cannot_fix status. */
function accumulateCannotFix(input: ReportResultInput, board: Board, condition: string): Board {
  if (condition !== "cannot_fix" || !board.iterations[input.state_id]) return board;
  if (!input.principle_ids || !input.file_paths) return board;

  const iteration = board.iterations[input.state_id];
  const newItems: CannotFixItem[] = [];
  for (const principleId of input.principle_ids) {
    for (const filePath of input.file_paths) {
      newItems.push({ principle_id: principleId, file_path: filePath });
    }
  }

  if (newItems.length === 0) return board;

  const existing = iteration.cannot_fix ?? [];
  const deduped = newItems.filter(
    (item) => !existing.some((e) => e.principle_id === item.principle_id && e.file_path === item.file_path),
  );
  if (deduped.length === 0) return board;

  return {
    ...board,
    iterations: {
      ...board.iterations,
      [input.state_id]: { ...iteration, cannot_fix: [...existing, ...deduped] },
    },
  };
}

/** Determine HITL requirement based on stuck, debate, and transition status. */
function resolveHitl(
  input: ReportResultInput,
  board: Board,
  condition: string,
  nextState: string | null,
  stuck: boolean,
  stuck_reason: string | undefined,
  stateDef: import("../orchestration/flow-schema.ts").StateDefinition | undefined,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined,
): { board: Board; nextState: string | null; hitl_required: boolean; hitl_reason?: string } {
  let updatedBoard = board;
  let updatedNextState = nextState;
  let hitl_required = false;
  let hitl_reason: string | undefined;

  // Apply debate result
  if (debateResult !== undefined) {
    updatedBoard = {
      ...updatedBoard,
      metadata: {
        ...(updatedBoard.metadata ?? {}),
        debate_last_round: debateResult.last_completed_round,
        debate_completed: debateResult.completed,
        ...(debateResult.summary ? { debate_summary: debateResult.summary } : {}),
      },
    };

    if (!debateResult.completed) {
      updatedNextState = input.state_id;
    } else if (input.flow.debate!.hitl_checkpoint) {
      updatedNextState = null;
      hitl_required = true;
      hitl_reason = `Debate completed after round ${debateResult.last_completed_round}${
        debateResult.convergence?.reason ? `: ${debateResult.convergence.reason}` : ""
      }`;
    }
  }

  const loweredKeyword = input.status_keyword.toLowerCase();
  const isRecognized =
    (STATUS_KEYWORDS as readonly string[]).includes(loweredKeyword) || loweredKeyword in STATUS_ALIASES;

  if (stuck) {
    hitl_required = true;
    hitl_reason = stuck_reason;
  } else if (updatedNextState === "hitl") {
    hitl_required = true;
    hitl_reason = `Transition from '${input.state_id}' on '${condition}' leads to hitl`;
  } else if (!hitl_required && updatedNextState === null && stateDef?.type !== "terminal") {
    hitl_required = true;
    hitl_reason = isRecognized
      ? `No matching transition from '${input.state_id}' for condition '${condition}'`
      : `Unrecognized status keyword '${input.status_keyword}' from state '${input.state_id}' (normalized to '${condition}')`;
    updatedBoard = setBlocked(updatedBoard, input.state_id, hitl_reason);
  }

  if (hitl_required && hitl_reason && updatedBoard.blocked == null && stateDef?.type !== "terminal") {
    updatedBoard = setBlocked(updatedBoard, input.state_id, hitl_reason);
  }

  return { board: updatedBoard, nextState: updatedNextState, hitl_required, hitl_reason };
}

/** Emit report-result events (best-effort). */
function emitReportEvents(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  condition: string,
  nextState: string | null,
  hitl_required: boolean,
  hitl_reason: string | undefined,
): void {
  const onStateCompleted = (event: import("../orchestration/events.js").FlowEventMap["state_completed"]) => {
    try {
      store.appendEvent("state_completed", event as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
  };
  const onTransitionEvaluated = (event: import("../orchestration/events.js").FlowEventMap["transition_evaluated"]) => {
    try {
      store.appendEvent("transition_evaluated", event as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("state_completed", onStateCompleted);
  flowEventBus.once("transition_evaluated", onTransitionEvaluated);
  try {
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
    });
    flowEventBus.emit("transition_evaluated", {
      stateId: input.state_id,
      statusKeyword: input.status_keyword,
      normalizedCondition: condition,
      nextState: nextState ?? "null",
      timestamp: new Date().toISOString(),
    });
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

/** Build the log entry for the report result. */
function buildLogEntry(
  input: ReportResultInput,
  condition: string,
  nextState: string | null,
  stuck: boolean,
  hitl_required: boolean,
  stuck_reason: string | undefined,
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

async function reportResultLocked(input: ReportResultInput): Promise<ToolResult<ReportResultResult>> {
  const store = getExecutionStore(input.workspace);

  if (!store.getBoard()) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found in workspace: ${input.workspace}`);
  }

  let debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  const stateDef = input.flow.states[input.state_id];
  if (input.state_id === input.flow.entry && input.flow.debate) {
    debateResult = await inspectDebateProgress(input.workspace, input.flow.debate);
  }

  const { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason } = store.transaction(
    (): {
      board: Board;
      condition: string;
      nextState: string | null;
      stuck: boolean;
      stuck_reason: string | undefined;
      hitl_required: boolean;
      hitl_reason: string | undefined;
    } => {
      let board = store.getBoard();
      if (!board) {
        throw new Error(`No execution found in workspace: ${input.workspace}`);
      }

      // Normalize status and aggregate parallel results
      let condition = normalizeStatus(input.status_keyword);
      if (input.flow.review_threshold && stateDef?.transitions) {
        condition = applyReviewThresholdToCondition(input.flow.review_threshold, condition, stateDef.transitions);
      }

      const parallel = aggregateParallelResults(input, board, condition, stateDef);
      board = parallel.board;
      condition = parallel.condition;

      // Handle done_with_concerns
      if (input.status_keyword.toLowerCase() === "done_with_concerns" && input.concern_text) {
        const agent = stateDef?.agent ?? input.state_id;
        board = {
          ...board,
          concerns: [
            ...board.concerns,
            { state_id: input.state_id, agent, message: input.concern_text, timestamp: new Date().toISOString() },
          ],
        };
      }

      board = completeState(board, input.state_id, condition, input.artifacts);
      board = enrichBoardState(input, board);

      let nextState = stateDef ? evaluateTransition(stateDef, condition) : null;

      // Stuck detection
      const stuckResult = detectStuck(input, board, condition, stateDef);
      board = stuckResult.board;
      if (stuckResult.stuck) nextState = null;

      // Cannot-fix accumulation
      board = accumulateCannotFix(input, board, condition);

      // HITL resolution
      const hitlResult = resolveHitl(
        input,
        board,
        condition,
        nextState,
        stuckResult.stuck,
        stuckResult.stuck_reason,
        stateDef,
        debateResult,
      );
      board = hitlResult.board;
      nextState = hitlResult.nextState;

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
        hitl_required: hitlResult.hitl_required,
        hitl_reason: hitlResult.hitl_reason,
      };
    },
  );

  // Post-transaction side effects (best-effort)
  if (input.progress_line) {
    try {
      store.appendProgress(input.progress_line);
    } catch {
      /* best-effort */
    }
  }

  if (stateDef?.effects?.length && input.artifacts?.length) {
    const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
    await executeEffects(stateDef, input.workspace, input.artifacts, projectDir).catch(() => {
      /* noop */
    });
  }

  emitReportEvents(store, input, condition, nextState, hitl_required, hitl_reason);

  const log_entry = buildLogEntry(input, condition, nextState, stuck, hitl_required, stuck_reason, hitl_reason);

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
