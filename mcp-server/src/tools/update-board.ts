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

  // Validate input that doesn't need board state first (fast-path validation)
  if (input.action === "enter_state" && !input.state_id) {
    return toolError("INVALID_INPUT", "enter_state requires state_id");
  }
  if (input.action === "skip_state" && !input.state_id) {
    return toolError("INVALID_INPUT", "skip_state requires state_id");
  }
  if (input.action === "block" && !input.state_id) {
    return toolError("INVALID_INPUT", "block requires state_id");
  }
  if (input.action === "unblock" && !input.state_id) {
    return toolError("INVALID_INPUT", "unblock requires state_id");
  }
  if (input.action === "set_wave_progress" && !input.state_id) {
    return toolError("INVALID_INPUT", "set_wave_progress requires state_id");
  }
  if (input.action === "set_wave_progress" && !input.wave_data) {
    return toolError("INVALID_INPUT", "set_wave_progress requires wave_data");
  }
  if (input.action === "set_metadata" && !input.metadata) {
    return toolError("INVALID_INPUT", "set_metadata requires metadata");
  }

  let board: Board | null = null;

  switch (input.action) {
    case "enter_state": {
      store.transaction(() => {
        // Read board inside transaction for atomic read-modify-write
        const boardOrNull = store.getBoard();
        if (!boardOrNull) return; // handled below
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
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      break;
    }

    case "skip_state": {
      // Validate next_state_id before entering the transaction (requires one read,
      // but this check is idempotent so it doesn't need to be inside the CAS).
      if (input.next_state_id) {
        const checkBoard = store.getBoard();
        if (!checkBoard) {
          return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
        }
        if (!checkBoard.states[input.next_state_id]) {
          return toolError("INVALID_INPUT", `skip_state next_state_id "${input.next_state_id}" does not exist in board states`);
        }
      }
      store.transaction(() => {
        const boardOrNull = store.getBoard();
        if (!boardOrNull) return; // handled below
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
          // State entry not in board but workspace exists — treat as no-op, return current board
          board = boardOrNull;
        }
      });
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      break;
    }

    case "block": {
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
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      break;
    }

    case "unblock": {
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
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      break;
    }

    case "complete_flow": {
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
          last_updated: board.last_updated,
        });
      });
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      // TypeScript can't narrow through the closure assignment — assert after null check
      const completedBoard = board as Board;

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

        const completedAt = completedBoard.last_updated;
        const flowRun: FlowRunEntry = {
          run_id: generateId("run"),
          flow: completedBoard.flow,
          tier: sessionTier,
          task: completedBoard.task,
          started: completedBoard.started,
          completed: completedAt,
          total_duration_ms: new Date(completedAt).getTime() - new Date(completedBoard.started).getTime(),
          state_durations: stateDurations,
          state_iterations: stateIterations,
          skipped_states: completedBoard.skipped,
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
          status: (stateEntry?.status as any) ?? "pending",
          entries: stateEntry?.entries ?? 0,
          wave: input.wave_data!.wave,
          wave_total: input.wave_data!.wave_total,
          wave_results: newWaveResults,
        });
        store.updateExecution({ last_updated: board.last_updated });
      });
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      break;
    }

    case "set_metadata": {
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
      if (!board) {
        return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
      }
      break;
    }

    default:
      return toolError("INVALID_INPUT", `Unknown action: ${(input as UpdateBoardInput).action}`);
  }

  // board is guaranteed non-null here (all cases return early on null or set board)
  const finalBoard = board as Board;

  // Emit events (best-effort)
  const now = finalBoard.last_updated;
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
          iterationCount: finalBoard.iterations[input.state_id]?.count ?? 0,
        });
      } finally {
        flowEventBus.removeListener("state_entered", onStateEntered);
      }
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }

  return toolOk({ board: finalBoard });
}
