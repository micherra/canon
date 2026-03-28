import { readBoard, writeBoard, enterState, setBlocked } from "../orchestration/board.ts";
import { withBoardLock, writeSession } from "../orchestration/workspace.ts";
import { SessionSchema, type Board } from "../orchestration/flow-schema.ts";
import { readFile } from "fs/promises";
import { join } from "path";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { createJsonlLogger } from "../orchestration/events.ts";
import { appendFlowRun, type FlowRunEntry } from "../drift/analytics.ts";
import { generateId } from "../utils/id.ts";

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

export async function updateBoard(input: UpdateBoardInput): Promise<UpdateBoardResult> {
  return withBoardLock(input.workspace, () => updateBoardLocked(input));
}

async function updateBoardLocked(input: UpdateBoardInput): Promise<UpdateBoardResult> {
  let board = await readBoard(input.workspace);

  switch (input.action) {
    case "enter_state": {
      if (!input.state_id) {
        throw new Error("enter_state requires state_id");
      }
      board = enterState(board, input.state_id);
      break;
    }

    case "skip_state": {
      if (!input.state_id) {
        throw new Error("skip_state requires state_id");
      }
      if (input.next_state_id && !board.states[input.next_state_id]) {
        throw new Error(
          `skip_state next_state_id "${input.next_state_id}" does not exist in board states`,
        );
      }
      const stateEntry = board.states[input.state_id];
      if (stateEntry) {
        board = {
          ...board,
          states: {
            ...board.states,
            [input.state_id]: {
              ...stateEntry,
              status: "skipped",
            },
          },
          skipped: [...board.skipped, input.state_id],
          // Advance current_state if caller provides the next state
          ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
          last_updated: new Date().toISOString(),
        };
      }
      break;
    }

    case "block": {
      if (!input.state_id) {
        throw new Error("block requires state_id");
      }
      const reason = input.blocked_reason ?? "No reason provided";
      board = setBlocked(board, input.state_id, reason);
      break;
    }

    case "unblock": {
      if (!input.state_id) {
        throw new Error("unblock requires state_id");
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
        last_updated: new Date().toISOString(),
      };
      break;
    }

    case "complete_flow": {
      const now = new Date().toISOString();
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

      // Update session status to completed
      let sessionTier = "unknown";
      try {
        const sessionPath = join(input.workspace, "session.json");
        const sessionData = await readFile(sessionPath, "utf-8");
        const session = SessionSchema.parse(JSON.parse(sessionData));
        sessionTier = session.tier;
        await writeSession(input.workspace, {
          ...session,
          status: "completed",
          completed_at: now,
        });
      } catch {
        // Best-effort — don't fail the board update if session can't be updated
      }

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
        throw new Error("set_wave_progress requires state_id");
      }
      if (!input.wave_data) {
        throw new Error("set_wave_progress requires wave_data");
      }
      const stateEntry = board.states[input.state_id];
      const waveKey = `wave_${input.wave_data.wave}`;
      board = {
        ...board,
        states: {
          ...board.states,
          [input.state_id]: {
            ...stateEntry,
            wave: input.wave_data.wave,
            wave_total: input.wave_data.wave_total,
            wave_results: {
              ...(stateEntry?.wave_results ?? {}),
              [waveKey]: {
                tasks: input.wave_data.tasks,
                status: input.result ?? "pending",
              },
            },
          },
        },
        last_updated: new Date().toISOString(),
      };
      break;
    }

    case "set_metadata": {
      if (!input.metadata) {
        throw new Error("set_metadata requires metadata");
      }
      board = {
        ...board,
        metadata: { ...(board.metadata ?? {}), ...input.metadata },
        last_updated: new Date().toISOString(),
      };
      break;
    }

    default:
      throw new Error(`Unknown action: ${input.action}`);
  }

  await writeBoard(input.workspace, board);

  // Emit events (best-effort — listeners must swallow errors).
  // once() auto-removes listeners on first fire; the finally block removes any
  // listeners that were registered but not fired due to an error mid-sequence.
  const log = createJsonlLogger(input.workspace);
  const onBoardUpdated = (event: import("../orchestration/events.js").FlowEventMap["board_updated"]) => {
    log("board_updated", event).catch(() => {});
  };
  flowEventBus.once("board_updated", onBoardUpdated);
  try {
    flowEventBus.emit("board_updated", {
      action: input.action,
      stateId: input.state_id,
      timestamp: new Date().toISOString(),
    });
    if (input.action === "enter_state" && input.state_id) {
      const onStateEntered = (event: import("../orchestration/events.js").FlowEventMap["state_entered"]) => {
        log("state_entered", event).catch(() => {});
      };
      flowEventBus.once("state_entered", onStateEntered);
      try {
        flowEventBus.emit("state_entered", {
          stateId: input.state_id,
          stateType: "unknown", // state type not available in update-board context
          timestamp: new Date().toISOString(),
          iterationCount: board.iterations[input.state_id]?.count ?? 0,
        });
      } finally {
        flowEventBus.removeListener("state_entered", onStateEntered);
      }
    }
  } finally {
    flowEventBus.removeListener("board_updated", onBoardUpdated);
  }

  return { board };
}
