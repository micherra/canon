/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import {
  normalizeStatus,
  evaluateTransition,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  isStuck,
  aggregateParallelPerResults,
  aggregateReviewResults,
} from "../orchestration/transitions.ts";
import { appendFile } from "fs/promises";
import { join } from "path";
import {
  readBoard,
  writeBoard,
  completeState,
  setBlocked,
} from "../orchestration/board.ts";
import { canEnterState } from "../orchestration/convergence.ts";
import { withBoardLock } from "../orchestration/workspace.ts";
import type { Board, ResolvedFlow, CannotFixItem, GateResult, PostconditionResult, DiscoveredGate, PostconditionAssertion, ViolationSeverities, TestResults } from "../orchestration/flow-schema.ts";
import { STATUS_KEYWORDS, STATUS_ALIASES } from "../orchestration/flow-schema.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { createJsonlLogger } from "../orchestration/events.ts";
import { executeEffects } from "../orchestration/effects.ts";

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

export async function reportResult(
  input: ReportResultInput,
): Promise<ReportResultResult> {
  return withBoardLock(input.workspace, () => reportResultLocked(input));
}

async function reportResultLocked(
  input: ReportResultInput,
): Promise<ReportResultResult> {
  let board = await readBoard(input.workspace);

  // Normalize status keyword
  let condition = normalizeStatus(input.status_keyword);

  // Apply review threshold if flow has one
  const stateDef = input.flow.states[input.state_id];
  if (input.flow.review_threshold && stateDef?.transitions) {
    condition = applyReviewThresholdToCondition(
      input.flow.review_threshold,
      condition,
      stateDef.transitions,
    );
  }

  // Aggregate parallel-per results if present
  if (input.parallel_results && input.parallel_results.length > 0) {
    const isReviewAggregation = input.parallel_results.every(
      r => ["clean", "warning", "blocking"].includes(r.status.toLowerCase())
    );
    const aggregated = isReviewAggregation
      ? aggregateReviewResults(input.parallel_results)
      : aggregateParallelPerResults(input.parallel_results);
    condition = aggregated.condition; // Override condition with aggregated result

    // Store parallel_results on board state entry
    board = {
      ...board,
      states: {
        ...board.states,
        [input.state_id]: {
          ...board.states[input.state_id],
          parallel_results: input.parallel_results,
        },
      },
    };

    // Accumulate cannot_fix items in iteration record (as strings for now)
    if (aggregated.cannotFixItems.length > 0 && board.iterations[input.state_id]) {
      const iteration = board.iterations[input.state_id];
      const existingCannotFix = iteration.cannot_fix ?? [];
      // Convert string items to CannotFixItem format: item string is "principle_id:file_path" or just an identifier
      // For now, store as-is in a separate field — the filterCannotFix path uses structured CannotFixItem from individual reports
      board = {
        ...board,
        iterations: {
          ...board.iterations,
          [input.state_id]: {
            ...iteration,
            cannot_fix: existingCannotFix, // unchanged — structured items come from individual reports
          },
        },
      };
    }
  }

  // Evaluate transition
  let nextState = stateDef ? evaluateTransition(stateDef, condition) : null;

  // Handle done_with_concerns: append concern to board
  if (
    input.status_keyword.toLowerCase() === "done_with_concerns" &&
    input.concern_text
  ) {
    const agent = stateDef?.agent ?? input.state_id;
    board = {
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

  // Complete the state in board
  board = completeState(
    board,
    input.state_id,
    condition,
    input.artifacts,
  );

  // Enrich metrics with all new signals and auto-computed revision_count.
  // Only record metrics when the caller provided at least one metric field or signal.
  // This preserves backward compat: callers that provide no metrics get no metrics entry.
  const hasCallerMetrics =
    input.metrics != null ||
    input.gate_results?.length ||
    input.postcondition_results?.length ||
    input.violation_count != null ||
    input.violation_severities != null ||
    input.test_results != null ||
    input.files_changed != null;

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
    // Auto-compute revision_count from iterations when recording any metrics
    ...(hasCallerMetrics && board.iterations[input.state_id] ? { revision_count: board.iterations[input.state_id].count } : {}),
  };

  // Record enriched metrics only when caller provided at least one metric or signal field
  if (hasCallerMetrics && board.states[input.state_id]) {
    board = {
      ...board,
      states: {
        ...board.states,
        [input.state_id]: {
          ...board.states[input.state_id],
          metrics: enrichedMetrics,
        },
      },
    };
  }

  // Store gate results on board state entry (top-level for quick access)
  if (input.gate_results?.length && board.states[input.state_id]) {
    board = {
      ...board,
      states: {
        ...board.states,
        [input.state_id]: {
          ...board.states[input.state_id],
          gate_results: input.gate_results,
        },
      },
    };
  }

  // Store postcondition results on board state entry (top-level for quick access)
  if (input.postcondition_results?.length && board.states[input.state_id]) {
    board = {
      ...board,
      states: {
        ...board.states,
        [input.state_id]: {
          ...board.states[input.state_id],
          postcondition_results: input.postcondition_results,
        },
      },
    };
  }

  // Accumulate discovered gates (append, not replace — multiple agents may discover gates)
  if (input.discovered_gates?.length && board.states[input.state_id]) {
    const existing = board.states[input.state_id].discovered_gates ?? [];
    board = {
      ...board,
      states: {
        ...board.states,
        [input.state_id]: {
          ...board.states[input.state_id],
          discovered_gates: [...existing, ...input.discovered_gates],
        },
      },
    };
  }

  // Accumulate discovered postconditions (append, not replace)
  if (input.discovered_postconditions?.length && board.states[input.state_id]) {
    const existing = board.states[input.state_id].discovered_postconditions ?? [];
    board = {
      ...board,
      states: {
        ...board.states,
        [input.state_id]: {
          ...board.states[input.state_id],
          discovered_postconditions: [...existing, ...input.discovered_postconditions],
        },
      },
    };
  }

  // Stuck detection
  let stuck = false;
  let stuck_reason: string | undefined;

  if (stateDef?.stuck_when && board.iterations[input.state_id]) {
    const iteration = board.iterations[input.state_id];
    const historyEntry = buildHistoryEntry(stateDef.stuck_when, {
      status: condition,
      principleIds: input.principle_ids,
      filePaths: input.file_paths,
      pairs: input.file_test_pairs,
      commitSha: input.commit_sha,
      artifactCount: input.artifact_count,
    });

    // Append to history
    const updatedHistory = [...iteration.history, historyEntry];
    board = {
      ...board,
      iterations: {
        ...board.iterations,
        [input.state_id]: {
          ...iteration,
          history: updatedHistory,
        },
      },
    };

    if (isStuck(updatedHistory, stateDef.stuck_when)) {
      stuck = true;
      stuck_reason = `Agent is stuck in state '${input.state_id}' (${stateDef.stuck_when})`;
      nextState = null; // Override to hitl
    }
  }

  // Accumulate cannot_fix items when agent reports cannot_fix status
  if (condition === "cannot_fix" && board.iterations[input.state_id]) {
    const iteration = board.iterations[input.state_id];
    const newCannotFixItems: CannotFixItem[] = [];

    // Build CannotFixItem entries from principle_ids x file_paths
    if (input.principle_ids && input.file_paths) {
      for (const principleId of input.principle_ids) {
        for (const filePath of input.file_paths) {
          newCannotFixItems.push({ principle_id: principleId, file_path: filePath });
        }
      }
    }

    if (newCannotFixItems.length > 0) {
      const existingCannotFix = iteration.cannot_fix ?? [];
      // Deduplicate: only add items not already in the list
      const deduped = newCannotFixItems.filter(
        (item) => !existingCannotFix.some(
          (existing) => existing.principle_id === item.principle_id && existing.file_path === item.file_path
        )
      );
      if (deduped.length > 0) {
        board = {
          ...board,
          iterations: {
            ...board.iterations,
            [input.state_id]: {
              ...iteration,
              cannot_fix: [...existingCannotFix, ...deduped],
            },
          },
        };
      }
    }
  }

  // Determine if HITL is required
  let hitl_required = false;
  let hitl_reason: string | undefined;

  // Check if status keyword is recognized
  const loweredKeyword = input.status_keyword.toLowerCase();
  const isRecognized =
    (STATUS_KEYWORDS as readonly string[]).includes(loweredKeyword) ||
    loweredKeyword in STATUS_ALIASES;

  if (stuck) {
    hitl_required = true;
    hitl_reason = stuck_reason;
  } else if (nextState === "hitl") {
    hitl_required = true;
    hitl_reason = `Transition from '${input.state_id}' on '${condition}' leads to hitl`;
  } else if (nextState === null && stateDef?.type !== "terminal") {
    hitl_required = true;
    if (!isRecognized) {
      hitl_reason = `Unrecognized status keyword '${input.status_keyword}' from state '${input.state_id}' (normalized to '${condition}')`;
    } else {
      hitl_reason = `No matching transition from '${input.state_id}' for condition '${condition}'`;
    }
    board = setBlocked(board, input.state_id, hitl_reason);
  }

  // Update current_state if we have a valid next state
  if (nextState && nextState !== "hitl") {
    board = {
      ...board,
      current_state: nextState,
    };
  }

  // Write board
  await writeBoard(input.workspace, board);

  // Append progress line (best-effort — cosmetic, never blocks the flow)
  if (input.progress_line) {
    const progressPath = join(input.workspace, "progress.md");
    await appendFile(progressPath, input.progress_line + "\n", "utf-8").catch(() => {});
  }

  // Execute drift effects (best-effort — never blocks the flow)
  if (stateDef?.effects?.length && input.artifacts?.length) {
    const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
    await executeEffects(stateDef, input.workspace, input.artifacts, projectDir).catch(() => {});
  }

  // Emit events (best-effort — listeners must swallow errors).
  // once() auto-removes listeners on first fire; the finally block removes any
  // listeners that were registered but not fired due to an error mid-sequence.
  const log = createJsonlLogger(input.workspace);
  const onStateCompleted = (event: import("../orchestration/events.js").FlowEventMap["state_completed"]) => {
    log("state_completed", event).catch(() => {});
  };
  const onTransitionEvaluated = (event: import("../orchestration/events.js").FlowEventMap["transition_evaluated"]) => {
    log("transition_evaluated", event).catch(() => {});
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
      ...(input.discovered_postconditions?.length ? { discovered_postconditions_count: input.discovered_postconditions.length } : {}),
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

  // Build log entry
  const log_entry: LogEntry = {
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
    ...(input.discovered_postconditions?.length ? { discovered_postconditions_count: input.discovered_postconditions.length } : {}),
  };

  return {
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
