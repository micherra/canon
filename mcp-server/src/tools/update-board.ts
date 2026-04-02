import { appendFlowRun, type FlowRunEntry } from "../drift/analytics.ts";
import { enterState, setBlocked } from "../orchestration/board.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import type { ExecutionStore } from "../orchestration/execution-store.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, BoardStateEntry, BoardStateStatus, StateMetrics } from "../orchestration/flow-schema.ts";
import { generateId } from "../utils/id.ts";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

interface UpdateBoardInput {
  workspace: string;
  action: "enter_state" | "skip_state" | "block" | "unblock" | "complete_flow" | "set_wave_progress" | "set_metadata";
  state_id?: string;
  next_state_id?: string;
  blocked_reason?: string;
  wave_data?: { wave: number; wave_total: number; tasks: string[] };
  result?: string;
  artifacts?: string[];
  metadata?: Record<string, string | number | boolean>;
  project_dir?: string;
}

interface UpdateBoardResult {
  board: Board;
}

interface QualitySignals {
  stateDurations: Record<string, number>;
  stateIterations: Record<string, number>;
  totalSpawns: number;
  totalGates: number;
  passedGates: number;
  totalPostconditions: number;
  passedPostconditions: number;
  totalViolations: number;
  totalFilesChanged: number;
  aggregateTestResults: { passed: number; failed: number; skipped: number };
}

function handleEnterState(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): ToolResult<{ board: Board }> {
  if (!input.state_id) {
    return toolError("INVALID_INPUT", "enter_state requires state_id");
  }
  const updatedBoard = enterState(board, input.state_id);
  const stateId = input.state_id;

  store.transaction(() => {
    store.updateExecution({
      current_state: stateId,
      last_updated: now,
    });
    const stateEntry = updatedBoard.states[stateId];
    if (stateEntry) {
      store.upsertState(stateId, {
        ...stateEntry,
        status: stateEntry.status,
        entries: stateEntry.entries,
      });
    }
    if (updatedBoard.iterations[stateId]) {
      const iter = updatedBoard.iterations[stateId];
      store.upsertIteration(stateId, {
        count: iter.count,
        max: iter.max,
        history: iter.history,
        cannot_fix: iter.cannot_fix,
      });
    }
  });

  return toolOk({ board: updatedBoard });
}

function handleSkipState(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): ToolResult<{ board: Board }> {
  if (!input.state_id) {
    return toolError("INVALID_INPUT", "skip_state requires state_id");
  }
  if (input.next_state_id && !board.states[input.next_state_id]) {
    return toolError(
      "INVALID_INPUT",
      `skip_state next_state_id "${input.next_state_id}" does not exist in board states`,
    );
  }
  const stateEntry = board.states[input.state_id];
  if (!stateEntry) {
    return toolOk({ board });
  }

  const stateId = input.state_id;
  const newSkipped = [...board.skipped, stateId];
  const updatedBoard: Board = {
    ...board,
    states: {
      ...board.states,
      [stateId]: {
        ...stateEntry,
        status: "skipped",
      },
    },
    skipped: newSkipped,
    ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
    last_updated: now,
  };

  store.transaction(() => {
    store.upsertState(stateId, {
      ...updatedBoard.states[stateId],
      status: "skipped",
      entries: stateEntry.entries,
    });
    store.updateExecution({
      skipped: newSkipped,
      last_updated: now,
      ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
    });
  });

  return toolOk({ board: updatedBoard });
}

function handleBlock(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): ToolResult<{ board: Board }> {
  if (!input.state_id) {
    return toolError("INVALID_INPUT", "block requires state_id");
  }
  const reason = input.blocked_reason ?? "No reason provided";
  const updatedBoard = setBlocked(board, input.state_id, reason);
  const stateId = input.state_id;

  store.transaction(() => {
    store.updateExecution({
      blocked: updatedBoard.blocked,
      last_updated: now,
    });
    const blockedState = updatedBoard.states[stateId];
    if (blockedState) {
      store.upsertState(stateId, {
        ...blockedState,
        status: "blocked",
        entries: blockedState.entries,
      });
    }
  });

  return toolOk({ board: updatedBoard });
}

function handleUnblock(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): ToolResult<{ board: Board }> {
  if (!input.state_id) {
    return toolError("INVALID_INPUT", "unblock requires state_id");
  }
  const stateId = input.state_id;
  const stateEntry = board.states[stateId];
  const updatedBoard: Board = {
    ...board,
    blocked: null,
    states: {
      ...board.states,
      [stateId]: {
        ...stateEntry,
        status: "in_progress",
        error: undefined,
      },
    },
    last_updated: now,
  };

  store.transaction(() => {
    store.updateExecution({
      blocked: null,
      last_updated: now,
    });
    const unblocked = updatedBoard.states[stateId];
    if (unblocked) {
      store.upsertState(stateId, {
        ...unblocked,
        status: "in_progress",
        entries: unblocked.entries,
      });
    }
  });

  return toolOk({ board: updatedBoard });
}

function accumulateMetrics(signals: QualitySignals, stateId: string, m: StateMetrics): void {
  signals.stateDurations[stateId] = m.duration_ms ?? 0;
  signals.totalSpawns += m.spawns ?? 0;
  if (m.gate_results) {
    signals.totalGates += m.gate_results.length;
    signals.passedGates += m.gate_results.filter((g) => g.passed).length;
  }
  if (m.postcondition_results) {
    signals.totalPostconditions += m.postcondition_results.length;
    signals.passedPostconditions += m.postcondition_results.filter((p) => p.passed).length;
  }
  if (m.violation_count != null) {
    signals.totalViolations += m.violation_count;
  }
  if (m.files_changed != null) {
    signals.totalFilesChanged += m.files_changed;
  }
  if (m.test_results) {
    signals.aggregateTestResults.passed += m.test_results.passed;
    signals.aggregateTestResults.failed += m.test_results.failed;
    signals.aggregateTestResults.skipped += m.test_results.skipped;
  }
}

function aggregateQualitySignals(board: Board): QualitySignals {
  const signals: QualitySignals = {
    stateDurations: {},
    stateIterations: {},
    totalSpawns: 0,
    totalGates: 0,
    passedGates: 0,
    totalPostconditions: 0,
    passedPostconditions: 0,
    totalViolations: 0,
    totalFilesChanged: 0,
    aggregateTestResults: { passed: 0, failed: 0, skipped: 0 },
  };

  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    if (stateEntry.metrics) {
      accumulateMetrics(signals, stateId, stateEntry.metrics);
    }
    if (board.iterations[stateId]) {
      signals.stateIterations[stateId] = board.iterations[stateId].count;
    }
  }

  return signals;
}

function buildFlowRunEntry(board: Board, now: string, tier: string, signals: QualitySignals): FlowRunEntry {
  const { aggregateTestResults } = signals;
  const hasTestResults =
    aggregateTestResults.passed > 0 || aggregateTestResults.failed > 0 || aggregateTestResults.skipped > 0;

  return {
    run_id: generateId("run"),
    flow: board.flow,
    tier,
    task: board.task,
    started: board.started,
    completed: now,
    total_duration_ms: new Date(now).getTime() - new Date(board.started).getTime(),
    state_durations: signals.stateDurations,
    state_iterations: signals.stateIterations,
    skipped_states: board.skipped,
    total_spawns: signals.totalSpawns,
    ...(signals.totalGates > 0 ? { gate_pass_rate: signals.passedGates / signals.totalGates } : {}),
    ...(signals.totalPostconditions > 0
      ? {
          postcondition_pass_rate: signals.passedPostconditions / signals.totalPostconditions,
        }
      : {}),
    ...(signals.totalViolations > 0 ? { total_violations: signals.totalViolations } : {}),
    ...(signals.totalFilesChanged > 0 ? { total_files_changed: signals.totalFilesChanged } : {}),
    ...(hasTestResults ? { total_test_results: aggregateTestResults } : {}),
  };
}

async function handleCompleteFlow(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): Promise<ToolResult<{ board: Board }>> {
  const currentEntry = board.states[board.current_state];
  const updatedBoard: Board = {
    ...board,
    states: {
      ...board.states,
      [board.current_state]: {
        ...currentEntry,
        status: "done",
        completed_at: now,
      },
    },
    blocked: null,
    last_updated: now,
  };

  const currentStateId = board.current_state;

  store.transaction(() => {
    const doneState = updatedBoard.states[currentStateId];
    if (doneState) {
      store.upsertState(currentStateId, {
        ...doneState,
        status: "done",
        entries: doneState.entries ?? 0,
        completed_at: now,
      });
    }
    store.updateExecution({
      blocked: null,
      status: "completed",
      completed_at: now,
      last_updated: now,
    });
  });

  const session = store.getSession();
  const sessionTier = session?.tier ?? "unknown";

  const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
  try {
    const signals = aggregateQualitySignals(updatedBoard);
    const flowRun = buildFlowRunEntry(updatedBoard, now, sessionTier, signals);
    await appendFlowRun(projectDir, flowRun);
  } catch {
    // Best-effort — analytics should never block flow completion
  }

  return toolOk({ board: updatedBoard });
}

function handleSetWaveProgress(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): ToolResult<{ board: Board }> {
  if (!input.state_id) {
    return toolError("INVALID_INPUT", "set_wave_progress requires state_id");
  }
  if (!input.wave_data) {
    return toolError("INVALID_INPUT", "set_wave_progress requires wave_data");
  }
  const stateId = input.state_id;
  const stateEntry = board.states[stateId];
  const waveKey = `wave_${input.wave_data.wave}`;
  const newWaveResults = {
    ...(stateEntry?.wave_results ?? {}),
    [waveKey]: {
      tasks: input.wave_data.tasks,
      status: input.result ?? "pending",
    },
  };

  const updatedBoard: Board = {
    ...board,
    states: {
      ...board.states,
      [stateId]: {
        ...stateEntry,
        wave: input.wave_data.wave,
        wave_total: input.wave_data.wave_total,
        wave_results: newWaveResults,
      },
    },
    last_updated: now,
  };

  const fallbackStatus: BoardStateStatus = "pending";
  store.transaction(() => {
    store.upsertState(stateId, {
      ...(stateEntry ??
        ({
          status: fallbackStatus,
          entries: 0,
        } satisfies Pick<BoardStateEntry, "status" | "entries">)),
      status: (stateEntry?.status as BoardStateStatus) ?? fallbackStatus,
      entries: stateEntry?.entries ?? 0,
      wave: input.wave_data!.wave,
      wave_total: input.wave_data!.wave_total,
      wave_results: newWaveResults,
    });
    store.updateExecution({ last_updated: now });
  });

  return toolOk({ board: updatedBoard });
}

function handleSetMetadata(
  input: UpdateBoardInput,
  board: Board,
  store: ExecutionStore,
  now: string,
): ToolResult<{ board: Board }> {
  if (!input.metadata) {
    return toolError("INVALID_INPUT", "set_metadata requires metadata");
  }
  const updatedBoard: Board = {
    ...board,
    metadata: { ...(board.metadata ?? {}), ...input.metadata },
    last_updated: now,
  };

  store.transaction(() => {
    store.updateExecution({
      metadata: updatedBoard.metadata,
      last_updated: now,
    });
  });

  return toolOk({ board: updatedBoard });
}

function emitStateEnteredEvent(stateId: string, board: Board, store: ExecutionStore, now: string): void {
  const onStateEntered = (event: import("../orchestration/events.js").FlowEventMap["state_entered"]) => {
    try {
      store.appendEvent("state_entered", event as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("state_entered", onStateEntered);
  try {
    flowEventBus.emit("state_entered", {
      stateId,
      stateType: "unknown",
      timestamp: now,
      iterationCount: board.iterations[stateId]?.count ?? 0,
    });
  } finally {
    flowEventBus.removeListener("state_entered", onStateEntered);
  }
}

function emitBoardEvents(input: UpdateBoardInput, board: Board, store: ExecutionStore, now: string): void {
  const onBoardUpdated = (event: import("../orchestration/events.js").FlowEventMap["board_updated"]) => {
    try {
      store.appendEvent("board_updated", event as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("board_updated", onBoardUpdated);
  try {
    flowEventBus.emit("board_updated", {
      action: input.action,
      stateId: input.state_id,
      timestamp: now,
    });
    if (input.action === "enter_state" && input.state_id) {
      emitStateEnteredEvent(input.state_id, board, store, now);
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }
}

export async function updateBoard(input: UpdateBoardInput): Promise<ToolResult<UpdateBoardResult>> {
  const store = getExecutionStore(input.workspace);

  const boardOrNull = store.getBoard();
  if (!boardOrNull) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
  }
  const board: Board = boardOrNull;
  const now = new Date().toISOString();

  let result: ToolResult<{ board: Board }>;

  switch (input.action) {
    case "enter_state":
      result = handleEnterState(input, board, store, now);
      break;
    case "skip_state":
      result = handleSkipState(input, board, store, now);
      break;
    case "block":
      result = handleBlock(input, board, store, now);
      break;
    case "unblock":
      result = handleUnblock(input, board, store, now);
      break;
    case "complete_flow":
      result = await handleCompleteFlow(input, board, store, now);
      break;
    case "set_wave_progress":
      result = handleSetWaveProgress(input, board, store, now);
      break;
    case "set_metadata":
      result = handleSetMetadata(input, board, store, now);
      break;
    default:
      return toolError("INVALID_INPUT", `Unknown action: ${(input as UpdateBoardInput).action}`);
  }

  if (!result.ok) {
    return result;
  }

  emitBoardEvents(input, result.board, store, now);

  return toolOk({ board: result.board });
}
