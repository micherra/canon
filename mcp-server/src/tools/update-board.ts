import { appendFlowRun, type FlowRunEntry } from "../platform/storage/drift/analytics.ts";
import { enterState, setBlocked } from "../orchestration/board.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board } from "../orchestration/flow-schema.ts";
import { generateId } from "../shared/lib/id.ts";
import { type ToolResult, toolError, toolOk } from "../shared/lib/tool-result.ts";

type UpdateBoardInput = {
  workspace: string;
  action:
    | "enter_state"
    | "skip_state"
    | "block"
    | "unblock"
    | "complete_flow"
    | "set_wave_progress"
    | "set_metadata";
  state_id?: string;
  next_state_id?: string;
  blocked_reason?: string;
  wave_data?: { wave: number; wave_total: number; tasks: string[] };
  result?: string;
  artifacts?: string[];
  metadata?: Record<string, string | number | boolean>;
  project_dir?: string;
};

type UpdateBoardResult = {
  board: Board;
};

type FlowRunAgg = {
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
};

function accumulateStateMetrics(
  agg: FlowRunAgg,
  stateId: string,
  m: NonNullable<Board["states"][string]["metrics"]>,
): void {
  agg.stateDurations[stateId] = m.duration_ms ?? 0;
  agg.totalSpawns += m.spawns ?? 0;
  if (m.gate_results) {
    agg.totalGates += m.gate_results.length;
    agg.passedGates += m.gate_results.filter((g) => g.passed).length;
  }
  if (m.postcondition_results) {
    agg.totalPostconditions += m.postcondition_results.length;
    agg.passedPostconditions += m.postcondition_results.filter((p) => p.passed).length;
  }
  if (m.violation_count != null) agg.totalViolations += m.violation_count;
  if (m.files_changed != null) agg.totalFilesChanged += m.files_changed;
  if (m.test_results) {
    agg.aggregateTestResults.passed += m.test_results.passed;
    agg.aggregateTestResults.failed += m.test_results.failed;
    agg.aggregateTestResults.skipped += m.test_results.skipped;
  }
}

function aggregateFlowRunMetrics(board: Board): FlowRunAgg {
  const agg: FlowRunAgg = {
    aggregateTestResults: { failed: 0, passed: 0, skipped: 0 },
    passedGates: 0,
    passedPostconditions: 0,
    stateDurations: {},
    stateIterations: {},
    totalFilesChanged: 0,
    totalGates: 0,
    totalPostconditions: 0,
    totalSpawns: 0,
    totalViolations: 0,
  };

  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    if (stateEntry.metrics) accumulateStateMetrics(agg, stateId, stateEntry.metrics);
    if (board.iterations[stateId]) agg.stateIterations[stateId] = board.iterations[stateId].count;
  }

  return agg;
}

function emitBoardEvents(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  input: UpdateBoardInput,
  now: string,
): void {
  const onBoardUpdated = (
    event: import("../orchestration/events.js").FlowEventMap["board_updated"],
  ) => {
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
      const onStateEntered = (
        event: import("../orchestration/events.js").FlowEventMap["state_entered"],
      ) => {
        try {
          store.appendEvent("state_entered", event as Record<string, unknown>);
        } catch {
          /* best-effort */
        }
      };
      flowEventBus.once("state_entered", onStateEntered);
      try {
        flowEventBus.emit("state_entered", {
          iterationCount: board.iterations[input.state_id]?.count ?? 0,
          stateId: input.state_id,
          stateType: "unknown",
          timestamp: now,
        });
      } finally {
        flowEventBus.removeListener("state_entered", onStateEntered);
      }
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }
}

async function handleCompleteFlow(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  now: string,
  projectDir: string,
): Promise<Board> {
  const currentEntry = board.states[board.current_state];
  const updatedBoard: Board = {
    ...board,
    blocked: null,
    last_updated: now,
    states: {
      ...board.states,
      [board.current_state]: {
        ...currentEntry,
        completed_at: now,
        status: "done",
      },
    },
  };

  const currentStateId = updatedBoard.current_state;

  store.transaction(() => {
    const doneState = updatedBoard.states[currentStateId];
    if (doneState) {
      store.upsertState(currentStateId, {
        ...doneState,
        completed_at: now,
        entries: doneState.entries ?? 0,
        status: "done",
      });
    }
    store.updateExecution({
      blocked: null,
      completed_at: now,
      last_updated: now,
      status: "completed",
    });
  });

  const session = store.getSession();
  const sessionTier = session?.tier ?? "unknown";

  try {
    const agg = aggregateFlowRunMetrics(updatedBoard);
    const flowRun: FlowRunEntry = {
      completed: now,
      flow: updatedBoard.flow,
      run_id: generateId("run"),
      skipped_states: updatedBoard.skipped,
      started: updatedBoard.started,
      state_durations: agg.stateDurations,
      state_iterations: agg.stateIterations,
      task: updatedBoard.task,
      tier: sessionTier,
      total_duration_ms: new Date(now).getTime() - new Date(updatedBoard.started).getTime(),
      total_spawns: agg.totalSpawns,
      ...(agg.totalGates > 0 ? { gate_pass_rate: agg.passedGates / agg.totalGates } : {}),
      ...(agg.totalPostconditions > 0
        ? { postcondition_pass_rate: agg.passedPostconditions / agg.totalPostconditions }
        : {}),
      ...(agg.totalViolations > 0 ? { total_violations: agg.totalViolations } : {}),
      ...(agg.totalFilesChanged > 0 ? { total_files_changed: agg.totalFilesChanged } : {}),
      ...(agg.aggregateTestResults.passed > 0 ||
      agg.aggregateTestResults.failed > 0 ||
      agg.aggregateTestResults.skipped > 0
        ? { total_test_results: agg.aggregateTestResults }
        : {}),
    };
    await appendFlowRun(projectDir, flowRun);
  } catch {
    // Best-effort — analytics should never block flow completion
  }

  return updatedBoard;
}

type ActionResult = { board: Board } | ToolResult<never>;

function isError(result: ActionResult): result is ToolResult<never> {
  return "ok" in result && result.ok === false;
}

function handleEnterState(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  input: UpdateBoardInput,
  now: string,
): ActionResult {
  if (!input.state_id) return toolError("INVALID_INPUT", "enter_state requires state_id");
  const updatedBoard = enterState(board, input.state_id);
  store.transaction(() => {
    store.updateExecution({ current_state: input.state_id!, last_updated: now });
    const stateEntry = updatedBoard.states[input.state_id!];
    if (stateEntry)
      store.upsertState(input.state_id!, {
        ...stateEntry,
        entries: stateEntry.entries,
        status: stateEntry.status,
      });
    if (updatedBoard.iterations[input.state_id!]) {
      const iter = updatedBoard.iterations[input.state_id!];
      store.upsertIteration(input.state_id!, {
        cannot_fix: iter.cannot_fix,
        count: iter.count,
        history: iter.history,
        max: iter.max,
      });
    }
  });
  return { board: updatedBoard };
}

function handleSkipState(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  input: UpdateBoardInput,
  now: string,
): ActionResult {
  if (!input.state_id) return toolError("INVALID_INPUT", "skip_state requires state_id");
  if (input.next_state_id && !board.states[input.next_state_id]) {
    return toolError(
      "INVALID_INPUT",
      `skip_state next_state_id "${input.next_state_id}" does not exist in board states`,
    );
  }
  const stateEntry = board.states[input.state_id];
  if (stateEntry) {
    const newSkipped = [...board.skipped, input.state_id];
    const updatedBoard: Board = {
      ...board,
      skipped: newSkipped,
      states: { ...board.states, [input.state_id]: { ...stateEntry, status: "skipped" } },
      ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
      last_updated: now,
    };
    store.transaction(() => {
      store.upsertState(input.state_id!, {
        ...updatedBoard.states[input.state_id!],
        entries: stateEntry.entries,
        status: "skipped",
      });
      store.updateExecution({
        last_updated: now,
        skipped: newSkipped,
        ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
      });
    });
    return { board: updatedBoard };
  }
  return { board };
}

function handleSetWaveProgress(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  input: UpdateBoardInput,
  now: string,
): ActionResult {
  if (!input.state_id) return toolError("INVALID_INPUT", "set_wave_progress requires state_id");
  if (!input.wave_data) return toolError("INVALID_INPUT", "set_wave_progress requires wave_data");
  const stateEntry = board.states[input.state_id];
  const waveKey = `wave_${input.wave_data.wave}`;
  const newWaveResults = {
    ...(stateEntry?.wave_results ?? {}),
    [waveKey]: { status: input.result ?? "pending", tasks: input.wave_data.tasks },
  };
  const updatedBoard: Board = {
    ...board,
    last_updated: now,
    states: {
      ...board.states,
      [input.state_id]: {
        ...stateEntry,
        wave: input.wave_data.wave,
        wave_results: newWaveResults,
        wave_total: input.wave_data.wave_total,
      },
    },
  };
  store.transaction(() => {
    store.upsertState(input.state_id!, {
      ...(stateEntry ?? { entries: 0, status: "pending" as const }),
      entries: stateEntry?.entries ?? 0,
      status: stateEntry?.status ?? ("pending" as const),
      wave: input.wave_data!.wave,
      wave_results: newWaveResults,
      wave_total: input.wave_data!.wave_total,
    });
    store.updateExecution({ last_updated: now });
  });
  return { board: updatedBoard };
}

/** Handle block/unblock/set_metadata inline actions. */
function handleInlineAction(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  input: UpdateBoardInput,
  now: string,
): ActionResult | ToolResult<UpdateBoardResult> {
  switch (input.action) {
    case "block": {
      if (!input.state_id) return toolError("INVALID_INPUT", "block requires state_id");
      const blocked = setBlocked(
        board,
        input.state_id,
        input.blocked_reason ?? "No reason provided",
      );
      store.transaction(() => {
        store.updateExecution({ blocked: blocked.blocked, last_updated: now });
        const blockedState = blocked.states[input.state_id!];
        if (blockedState)
          store.upsertState(input.state_id!, {
            ...blockedState,
            entries: blockedState.entries,
            status: "blocked",
          });
      });
      return { board: blocked };
    }
    case "unblock": {
      if (!input.state_id) return toolError("INVALID_INPUT", "unblock requires state_id");
      const stateEntry = board.states[input.state_id];
      const unblocked = {
        ...board,
        blocked: null,
        last_updated: now,
        states: {
          ...board.states,
          [input.state_id]: { ...stateEntry, error: undefined, status: "in_progress" as const },
        },
      };
      store.transaction(() => {
        store.updateExecution({ blocked: null, last_updated: now });
        const st = unblocked.states[input.state_id!];
        if (st)
          store.upsertState(input.state_id!, { ...st, entries: st.entries, status: "in_progress" });
      });
      return { board: unblocked };
    }
    case "set_metadata": {
      if (!input.metadata) return toolError("INVALID_INPUT", "set_metadata requires metadata");
      const updated = {
        ...board,
        last_updated: now,
        metadata: { ...(board.metadata ?? {}), ...input.metadata },
      };
      store.transaction(() => {
        store.updateExecution({ last_updated: now, metadata: updated.metadata });
      });
      return { board: updated };
    }
    default:
      return toolError("INVALID_INPUT", `Unknown action: ${(input as UpdateBoardInput).action}`);
  }
}

export async function updateBoard(input: UpdateBoardInput): Promise<ToolResult<UpdateBoardResult>> {
  const store = getExecutionStore(input.workspace);
  const boardOrNull = store.getBoard();
  if (!boardOrNull)
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
  let board: Board = boardOrNull;
  const now = new Date().toISOString();

  let result: ActionResult;

  switch (input.action) {
    case "enter_state":
      result = handleEnterState(store, board, input, now);
      break;
    case "skip_state":
      result = handleSkipState(store, board, input, now);
      break;
    case "complete_flow": {
      board = await handleCompleteFlow(
        store,
        board,
        now,
        input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd(),
      );
      result = { board };
      break;
    }
    case "set_wave_progress":
      result = handleSetWaveProgress(store, board, input, now);
      break;
    default:
      result = handleInlineAction(store, board, input, now);
      break;
  }

  if (isError(result)) return result;
  board = result.board;

  emitBoardEvents(store, board, input, now);
  return toolOk({ board });
}
