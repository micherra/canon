import { appendFlowRun, type FlowRunEntry } from "../drift/analytics.ts";
import { enterState, setBlocked } from "../orchestration/board.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, BoardStateStatus, WorktreeEntry } from "../orchestration/flow-schema.ts";
import { generateId } from "../utils/id.ts";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

interface UpdateBoardInput {
  workspace: string;
  action: "enter_state" | "skip_state" | "block" | "unblock" | "complete_flow" | "set_wave_progress" | "set_metadata";
  state_id?: string;
  next_state_id?: string;
  blocked_reason?: string;
  wave_data?: {
    wave: number;
    wave_total: number;
    tasks: string[];
    worktree_entries?: WorktreeEntry[];
  };
  result?: string;
  artifacts?: string[];
  metadata?: Record<string, string | number | boolean>;
  project_dir?: string;
}

interface UpdateBoardResult {
  board: Board;
}

function validateInput(input: UpdateBoardInput): ToolResult<UpdateBoardResult> | null {
  const needsStateId: UpdateBoardInput["action"][] = [
    "enter_state",
    "skip_state",
    "block",
    "unblock",
    "set_wave_progress",
  ];
  if (needsStateId.includes(input.action) && !input.state_id) {
    return toolError("INVALID_INPUT", `${input.action} requires state_id`);
  }
  if (input.action === "set_wave_progress" && !input.wave_data) {
    return toolError("INVALID_INPUT", "set_wave_progress requires wave_data");
  }
  if (input.action === "set_metadata" && !input.metadata) {
    return toolError("INVALID_INPUT", "set_metadata requires metadata");
  }
  return null;
}

function handleEnterState(store: ReturnType<typeof getExecutionStore>, input: UpdateBoardInput): Board | null {
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    board = enterState(boardOrNull, input.state_id!);

    store.updateExecution({
      current_state: input.state_id!,
      last_updated: board.last_updated,
    });
    const stateEntry = board.states[input.state_id!];
    if (stateEntry) {
      store.upsertState(input.state_id!, {
        ...stateEntry,
        status: stateEntry.status,
        entries: stateEntry.entries,
      });
    }
    if (board.iterations[input.state_id!]) {
      const iter = board.iterations[input.state_id!];
      store.upsertIteration(input.state_id!, {
        count: iter.count,
        max: iter.max,
        history: iter.history,
        cannot_fix: iter.cannot_fix,
      });
    }
  });
  return board;
}

function handleSkipState(
  store: ReturnType<typeof getExecutionStore>,
  input: UpdateBoardInput,
): ToolResult<UpdateBoardResult> | Board | null {
  if (input.next_state_id) {
    const checkBoard = store.getBoard();
    if (!checkBoard) {
      return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
    }
    if (!checkBoard.states[input.next_state_id]) {
      return toolError(
        "INVALID_INPUT",
        `skip_state next_state_id "${input.next_state_id}" does not exist in board states`,
      );
    }
  }
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    const stateEntry = boardOrNull.states[input.state_id!];
    if (stateEntry) {
      const newSkipped = [...boardOrNull.skipped, input.state_id!];
      const now = new Date().toISOString();
      board = {
        ...boardOrNull,
        states: {
          ...boardOrNull.states,
          [input.state_id!]: {
            ...stateEntry,
            status: "skipped",
          },
        },
        skipped: newSkipped,
        ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
        last_updated: now,
      };

      store.upsertState(input.state_id!, {
        ...board.states[input.state_id!],
        status: "skipped",
        entries: stateEntry.entries,
      });
      store.updateExecution({
        skipped: newSkipped,
        last_updated: board.last_updated,
        ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
      });
    } else {
      board = boardOrNull;
    }
  });
  return board;
}

function handleBlock(store: ReturnType<typeof getExecutionStore>, input: UpdateBoardInput): Board | null {
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    const reason = input.blocked_reason ?? "No reason provided";
    board = setBlocked(boardOrNull, input.state_id!, reason);

    store.updateExecution({
      blocked: board.blocked,
      last_updated: board.last_updated,
    });
    const blockedState = board.states[input.state_id!];
    if (blockedState) {
      store.upsertState(input.state_id!, {
        ...blockedState,
        status: "blocked",
        entries: blockedState.entries,
      });
    }
  });
  return board;
}

function handleUnblock(store: ReturnType<typeof getExecutionStore>, input: UpdateBoardInput): Board | null {
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    const stateEntry = boardOrNull.states[input.state_id!];
    const now = new Date().toISOString();
    board = {
      ...boardOrNull,
      blocked: null,
      states: {
        ...boardOrNull.states,
        [input.state_id!]: {
          ...stateEntry,
          status: "in_progress",
          error: undefined,
        },
      },
      last_updated: now,
    };

    store.updateExecution({
      blocked: null,
      last_updated: board.last_updated,
    });
    const unblocked = board.states[input.state_id!];
    if (unblocked) {
      store.upsertState(input.state_id!, {
        ...unblocked,
        status: "in_progress",
        entries: unblocked.entries,
      });
    }
  });
  return board;
}

function aggregateFlowRunMetrics(completedBoard: Board): {
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
} {
  const stateDurations: Record<string, number> = {};
  const stateIterations: Record<string, number> = {};
  let totalSpawns = 0;
  let totalGates = 0,
    passedGates = 0;
  let totalPostconditions = 0,
    passedPostconditions = 0;
  let totalViolations = 0,
    totalFilesChanged = 0;
  const aggregateTestResults = { passed: 0, failed: 0, skipped: 0 };

  for (const [stateId, stateEntry] of Object.entries(completedBoard.states)) {
    if (stateEntry.metrics) {
      const m = stateEntry.metrics;
      stateDurations[stateId] = m.duration_ms ?? 0;
      totalSpawns += m.spawns ?? 0;
      if (m.gate_results) {
        totalGates += m.gate_results.length;
        passedGates += m.gate_results.filter((g: { passed: boolean }) => g.passed).length;
      }
      if (m.postcondition_results) {
        totalPostconditions += m.postcondition_results.length;
        passedPostconditions += m.postcondition_results.filter((p: { passed: boolean }) => p.passed).length;
      }
      if (m.violation_count != null) totalViolations += m.violation_count;
      if (m.files_changed != null) totalFilesChanged += m.files_changed;
      if (m.test_results) {
        aggregateTestResults.passed += m.test_results.passed;
        aggregateTestResults.failed += m.test_results.failed;
        aggregateTestResults.skipped += m.test_results.skipped;
      }
    }
    if (completedBoard.iterations[stateId]) {
      stateIterations[stateId] = completedBoard.iterations[stateId].count;
    }
  }

  return {
    stateDurations,
    stateIterations,
    totalSpawns,
    totalGates,
    passedGates,
    totalPostconditions,
    passedPostconditions,
    totalViolations,
    totalFilesChanged,
    aggregateTestResults,
  };
}

async function handleCompleteFlow(
  store: ReturnType<typeof getExecutionStore>,
  input: UpdateBoardInput,
): Promise<Board | null> {
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    const now = new Date().toISOString();
    const currentEntry = boardOrNull.states[boardOrNull.current_state];
    board = {
      ...boardOrNull,
      states: {
        ...boardOrNull.states,
        [boardOrNull.current_state]: {
          ...currentEntry,
          status: "done",
          completed_at: now,
        },
      },
      blocked: null,
      last_updated: now,
    };

    const currentStateId = boardOrNull.current_state;

    const doneState = board.states[currentStateId];
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
      last_updated: board.last_updated,
    });
  });

  if (!board) return null;

  const completedBoard = board as Board;
  const session = store.getSession();
  const sessionTier = session?.tier ?? "unknown";
  const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();

  try {
    const metrics = aggregateFlowRunMetrics(completedBoard);
    const completedAt = completedBoard.last_updated;
    const flowRun: FlowRunEntry = {
      run_id: generateId("run"),
      flow: completedBoard.flow,
      tier: sessionTier,
      task: completedBoard.task,
      started: completedBoard.started,
      completed: completedAt,
      total_duration_ms: new Date(completedAt).getTime() - new Date(completedBoard.started).getTime(),
      state_durations: metrics.stateDurations,
      state_iterations: metrics.stateIterations,
      skipped_states: completedBoard.skipped,
      total_spawns: metrics.totalSpawns,
      ...(metrics.totalGates > 0 ? { gate_pass_rate: metrics.passedGates / metrics.totalGates } : {}),
      ...(metrics.totalPostconditions > 0
        ? { postcondition_pass_rate: metrics.passedPostconditions / metrics.totalPostconditions }
        : {}),
      ...(metrics.totalViolations > 0 ? { total_violations: metrics.totalViolations } : {}),
      ...(metrics.totalFilesChanged > 0 ? { total_files_changed: metrics.totalFilesChanged } : {}),
      ...(metrics.aggregateTestResults.passed > 0 ||
      metrics.aggregateTestResults.failed > 0 ||
      metrics.aggregateTestResults.skipped > 0
        ? { total_test_results: metrics.aggregateTestResults }
        : {}),
    };
    await appendFlowRun(projectDir, flowRun);
  } catch {
    // Best-effort — analytics should never block flow completion
  }

  return board;
}

function handleSetWaveProgress(store: ReturnType<typeof getExecutionStore>, input: UpdateBoardInput): Board | null {
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    const stateEntry = boardOrNull.states[input.state_id!];
    const waveKey = `wave_${input.wave_data!.wave}`;
    const newWaveResults = {
      ...(stateEntry?.wave_results ?? {}),
      [waveKey]: {
        tasks: input.wave_data!.tasks,
        status: input.result ?? "pending",
        ...(input.wave_data!.worktree_entries ? { worktree_entries: input.wave_data!.worktree_entries } : {}),
      },
    };
    const now = new Date().toISOString();
    board = {
      ...boardOrNull,
      states: {
        ...boardOrNull.states,
        [input.state_id!]: {
          ...stateEntry,
          wave: input.wave_data!.wave,
          wave_total: input.wave_data!.wave_total,
          wave_results: newWaveResults,
        },
      },
      last_updated: now,
    };

    store.upsertState(input.state_id!, {
      ...(stateEntry ?? { status: "pending" as const, entries: 0 }),
      status: (stateEntry?.status ?? "pending") as BoardStateStatus,
      entries: stateEntry?.entries ?? 0,
      wave: input.wave_data!.wave,
      wave_total: input.wave_data!.wave_total,
      wave_results: newWaveResults,
    });
    store.updateExecution({ last_updated: board.last_updated });
  });
  return board;
}

function handleSetMetadata(store: ReturnType<typeof getExecutionStore>, input: UpdateBoardInput): Board | null {
  let board: Board | null = null;
  store.transaction(() => {
    const boardOrNull = store.getBoard();
    if (!boardOrNull) return;
    const now = new Date().toISOString();
    board = {
      ...boardOrNull,
      metadata: { ...(boardOrNull.metadata ?? {}), ...input.metadata! },
      last_updated: now,
    };

    store.updateExecution({
      metadata: board.metadata,
      last_updated: board.last_updated,
    });
  });
  return board;
}

function emitBoardEvents(
  store: ReturnType<typeof getExecutionStore>,
  input: UpdateBoardInput,
  finalBoard: Board,
): void {
  const now = finalBoard.last_updated;
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
          stateId: input.state_id,
          stateType: "unknown",
          timestamp: now,
          iterationCount: finalBoard.iterations[input.state_id]?.count ?? 0,
        });
      } finally {
        flowEventBus.removeListener("state_entered", onStateEntered);
      }
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }
}

export async function updateBoard(input: UpdateBoardInput): Promise<ToolResult<UpdateBoardResult>> {
  const store = getExecutionStore(input.workspace);

  const validationError = validateInput(input);
  if (validationError) return validationError;

  let board: Board | null = null;

  switch (input.action) {
    case "enter_state": {
      board = handleEnterState(store, input);
      break;
    }
    case "skip_state": {
      const result = handleSkipState(store, input);
      if (result !== null && typeof result === "object" && "ok" in result && result.ok === false) {
        return result as ToolResult<UpdateBoardResult>;
      }
      board = result as Board | null;
      break;
    }
    case "block": {
      board = handleBlock(store, input);
      break;
    }
    case "unblock": {
      board = handleUnblock(store, input);
      break;
    }
    case "complete_flow": {
      board = await handleCompleteFlow(store, input);
      break;
    }
    case "set_wave_progress": {
      board = handleSetWaveProgress(store, input);
      break;
    }
    case "set_metadata": {
      board = handleSetMetadata(store, input);
      break;
    }
    default:
      return toolError("INVALID_INPUT", `Unknown action: ${(input as UpdateBoardInput).action}`);
  }

  if (!board) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
  }

  const finalBoard = board as Board;
  emitBoardEvents(store, input, finalBoard);

  return toolOk({ board: finalBoard });
}
