import { enterState, setBlocked } from "../orchestration/board.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board } from "../orchestration/flow-schema.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { appendFlowRun, type FlowRunEntry } from "../drift/analytics.ts";
import { generateId } from "../utils/id.ts";
import { toolError, toolOk, type ToolResult } from "../utils/tool-result.ts";

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

export async function updateBoard(input: UpdateBoardInput): Promise<ToolResult<UpdateBoardResult>> {
  const store = getExecutionStore(input.workspace);

  // Read the current board state (synchronous)
  const boardOrNull = store.getBoard();
  if (!boardOrNull) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
  }
  let board: Board = boardOrNull;

  const now = new Date().toISOString();

  switch (input.action) {
    case "enter_state": {
      if (!input.state_id) {
        return toolError("INVALID_INPUT", "enter_state requires state_id");
      }
      board = enterState(board, input.state_id);

      store.transaction(() => {
        store.updateExecution({
          current_state: input.state_id!,
          last_updated: now,
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
      break;
    }

    case "skip_state": {
      if (!input.state_id) {
        return toolError("INVALID_INPUT", "skip_state requires state_id");
      }
      if (input.next_state_id && !board.states[input.next_state_id]) {
        return toolError("INVALID_INPUT", `skip_state next_state_id "${input.next_state_id}" does not exist in board states`);
      }
      const stateEntry = board.states[input.state_id];
      if (stateEntry) {
        const newSkipped = [...board.skipped, input.state_id];
        board = {
          ...board,
          states: {
            ...board.states,
            [input.state_id]: {
              ...stateEntry,
              status: "skipped",
            },
          },
          skipped: newSkipped,
          ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
          last_updated: now,
        };

        store.transaction(() => {
          store.upsertState(input.state_id!, {
            ...board.states[input.state_id!],
            status: "skipped",
            entries: stateEntry.entries,
          });
          store.updateExecution({
            skipped: newSkipped,
            last_updated: now,
            ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
          });
        });
      }
      break;
    }

    case "block": {
      if (!input.state_id) {
        return toolError("INVALID_INPUT", "block requires state_id");
      }
      const reason = input.blocked_reason ?? "No reason provided";
      board = setBlocked(board, input.state_id, reason);

      store.transaction(() => {
        store.updateExecution({
          blocked: board.blocked,
          last_updated: now,
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
      break;
    }

    case "unblock": {
      if (!input.state_id) {
        return toolError("INVALID_INPUT", "unblock requires state_id");
      }
      const stateEntry = board.states[input.state_id];
      board = {
        ...board,
        blocked: null,
        states: {
          ...board.states,
          [input.state_id]: {
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
        const unblocked = board.states[input.state_id!];
        if (unblocked) {
          store.upsertState(input.state_id!, {
            ...unblocked,
            status: "in_progress",
            entries: unblocked.entries,
          });
        }
      });
      break;
    }

    case "complete_flow": {
      const currentEntry = board.states[board.current_state];
      board = {
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
        // Mark current state as done
        const doneState = board.states[currentStateId];
        if (doneState) {
          store.upsertState(currentStateId, {
            ...doneState,
            status: "done",
            entries: doneState.entries ?? 0,
            completed_at: now,
          });
        }

        // Update execution status to completed (replaces writeSession)
        store.updateExecution({
          blocked: null,
          status: "completed",
          completed_at: now,
          last_updated: now,
        });
      });

      // Get tier from session (now embedded in execution row)
      const session = store.getSession();
      const sessionTier = session?.tier ?? "unknown";

      // Persist flow-run analytics (best-effort)
      const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
      try {
        const stateDurations: Record<string, number> = {};
        const stateIterations: Record<string, number> = {};
        let totalSpawns = 0;

        // Aggregate quality signals from all board states
        let totalGates = 0, passedGates = 0;
        let totalPostconditions = 0, passedPostconditions = 0;
        let totalViolations = 0, totalFilesChanged = 0;
        const aggregateTestResults = { passed: 0, failed: 0, skipped: 0 };

        for (const [stateId, stateEntry] of Object.entries(board.states)) {
          if (stateEntry.metrics) {
            const m = stateEntry.metrics;
            stateDurations[stateId] = m.duration_ms ?? 0;
            totalSpawns += m.spawns ?? 0;
            if (m.gate_results) {
              totalGates += m.gate_results.length;
              passedGates += m.gate_results.filter((g) => g.passed).length;
            }
            if (m.postcondition_results) {
              totalPostconditions += m.postcondition_results.length;
              passedPostconditions += m.postcondition_results.filter((p) => p.passed).length;
            }
            if (m.violation_count != null) totalViolations += m.violation_count;
            if (m.files_changed != null) totalFilesChanged += m.files_changed;
            if (m.test_results) {
              aggregateTestResults.passed += m.test_results.passed;
              aggregateTestResults.failed += m.test_results.failed;
              aggregateTestResults.skipped += m.test_results.skipped;
            }
          }
          if (board.iterations[stateId]) {
            stateIterations[stateId] = board.iterations[stateId].count;
          }
        }

        const flowRun: FlowRunEntry = {
          run_id: generateId("run"),
          flow: board.flow,
          tier: sessionTier,
          task: board.task,
          started: board.started,
          completed: now,
          total_duration_ms: new Date(now).getTime() - new Date(board.started).getTime(),
          state_durations: stateDurations,
          state_iterations: stateIterations,
          skipped_states: board.skipped,
          total_spawns: totalSpawns,
          ...(totalGates > 0 ? { gate_pass_rate: passedGates / totalGates } : {}),
          ...(totalPostconditions > 0 ? { postcondition_pass_rate: passedPostconditions / totalPostconditions } : {}),
          ...(totalViolations > 0 ? { total_violations: totalViolations } : {}),
          ...(totalFilesChanged > 0 ? { total_files_changed: totalFilesChanged } : {}),
          ...((aggregateTestResults.passed > 0 || aggregateTestResults.failed > 0 || aggregateTestResults.skipped > 0)
            ? { total_test_results: aggregateTestResults }
            : {}),
        };
        await appendFlowRun(projectDir, flowRun);
      } catch {
        // Best-effort — analytics should never block flow completion
      }
      break;
    }

    case "set_wave_progress": {
      if (!input.state_id) {
        return toolError("INVALID_INPUT", "set_wave_progress requires state_id");
      }
      if (!input.wave_data) {
        return toolError("INVALID_INPUT", "set_wave_progress requires wave_data");
      }
      const stateEntry = board.states[input.state_id];
      const waveKey = `wave_${input.wave_data.wave}`;
      const newWaveResults = {
        ...(stateEntry?.wave_results ?? {}),
        [waveKey]: {
          tasks: input.wave_data.tasks,
          status: input.result ?? "pending",
        },
      };

      board = {
        ...board,
        states: {
          ...board.states,
          [input.state_id]: {
            ...stateEntry,
            wave: input.wave_data.wave,
            wave_total: input.wave_data.wave_total,
            wave_results: newWaveResults,
          },
        },
        last_updated: now,
      };

      store.transaction(() => {
        store.upsertState(input.state_id!, {
          ...(stateEntry ?? { status: "pending" as const, entries: 0 }),
          status: (stateEntry?.status as any) ?? "pending",
          entries: stateEntry?.entries ?? 0,
          wave: input.wave_data!.wave,
          wave_total: input.wave_data!.wave_total,
          wave_results: newWaveResults,
        });
        store.updateExecution({ last_updated: now });
      });
      break;
    }

    case "set_metadata": {
      if (!input.metadata) {
        return toolError("INVALID_INPUT", "set_metadata requires metadata");
      }
      board = {
        ...board,
        metadata: { ...(board.metadata ?? {}), ...input.metadata },
        last_updated: now,
      };

      store.transaction(() => {
        store.updateExecution({
          metadata: board.metadata,
          last_updated: now,
        });
      });
      break;
    }

    default:
      return toolError("INVALID_INPUT", `Unknown action: ${(input as UpdateBoardInput).action}`);
  }

  // Emit events (best-effort)
  const onBoardUpdated = (event: import("../orchestration/events.js").FlowEventMap["board_updated"]) => {
    try { store.appendEvent("board_updated", event as Record<string, unknown>); } catch { /* best-effort */ }
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
        try { store.appendEvent("state_entered", event as Record<string, unknown>); } catch { /* best-effort */ }
      };
      flowEventBus.once("state_entered", onStateEntered);
      try {
        flowEventBus.emit("state_entered", {
          stateId: input.state_id,
          stateType: "unknown",
          timestamp: now,
          iterationCount: board.iterations[input.state_id]?.count ?? 0,
        });
      } finally {
        flowEventBus.removeListener("state_entered", onStateEntered);
      }
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }

  return toolOk({ board });
}
