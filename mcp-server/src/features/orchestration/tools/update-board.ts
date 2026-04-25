import { enterState, setBlocked } from "@domains/board/board.ts";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { appendFlowRun, type FlowRunEntry } from "@platform/storage/drift/analytics.ts";
import { generateId } from "@shared/lib/id.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

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
    event: import("@domains/messages/events.js").FlowEventMap["board_updated"],
  ) => {
    try {
      store.appendEvent("board_updated", event as Record<string, unknown>);
    } catch (err: unknown) {
      console.warn(
        "[canon] failed to persist board_updated event:",
        err instanceof Error ? err.message : err,
      );
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
        event: import("@domains/messages/events.js").FlowEventMap["state_entered"],
      ) => {
        try {
          store.appendEvent("state_entered", event as Record<string, unknown>);
        } catch (err: unknown) {
          console.warn(
            "[canon] failed to persist state_entered event:",
            err instanceof Error ? err.message : err,
          );
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

type HandleCompleteFlowOptions = {
  store: ReturnType<typeof getExecutionStore>;
  board: Board;
  now: string;
  projectDir: string;
  workspacePath: string;
  version: number;
};

/** Append a FlowRunEntry to analytics. Best-effort — never throws. */
async function appendFlowAnalytics(
  updatedBoard: Board,
  now: string,
  projectDir: string,
  sessionTier: string,
): Promise<void> {
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
  } catch (err: unknown) {
    console.warn(
      "[canon] failed to append flow analytics:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function handleCompleteFlow(opts: HandleCompleteFlowOptions): Promise<Board> {
  const { store, board, now, projectDir, workspacePath, version } = opts;
  const currentEntry = board.states[board.current_state];
  const updatedBoard: Board = {
    ...board,
    blocked: null,
    last_updated: now,
    states: {
      ...board.states,
      [board.current_state]: { ...currentEntry, completed_at: now, status: "done" },
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
    store.updateExecutionVersioned(
      {
        blocked: null,
        completed_at: now,
        last_updated: now,
        status: "completed",
      },
      version,
    );
    // Note: version conflicts on complete_flow are ignored — completion is best-effort
    // once the flow has reached terminal state. The state upsert above is the critical write.
  });

  const session = store.getSession();
  const sessionTier = session?.tier ?? "unknown";

  try {
    store.recordFlowLineage({
      branch: session?.branch ?? "unknown",
      completed_at: now,
      flow_name: updatedBoard.flow,
      slug: session?.slug,
      status: "completed",
      task: updatedBoard.task,
      workspace_path: workspacePath,
    });
  } catch {
    console.warn("[canon] handleCompleteFlow: failed to record flow lineage");
  }

  try {
    const { releaseClaims } = await import("@shared/lib/file-claims.ts");
    const releaseSession = store.getSession();
    if (releaseSession) releaseClaims(projectDir, releaseSession.slug);
  } catch (err: unknown) {
    console.warn(
      "[canon] failed to release file claims:",
      err instanceof Error ? err.message : err,
    );
  }

  await appendFlowAnalytics(updatedBoard, now, projectDir, sessionTier);

  try {
    const { runJanitor } = await import("../services/janitor.ts");
    await runJanitor(projectDir);
  } catch (err: unknown) {
    console.warn("[canon] janitor run failed:", err instanceof Error ? err.message : err);
  }

  return updatedBoard;
}

type ActionResult = { board: Board } | ToolResult<never>;

function isError(result: ActionResult): result is ToolResult<never> {
  return "ok" in result && result.ok === false;
}

/** Shared context passed to all per-action handlers. */
type HandlerContext = {
  store: ReturnType<typeof getExecutionStore>;
  board: Board;
  input: UpdateBoardInput;
  now: string;
  version: number;
};

function boardLockedError(currentVersion: number): ToolResult<never> {
  return toolError(
    "BOARD_LOCKED",
    `Board version conflict: expected version was stale (current: ${currentVersion}). Retry the operation.`,
    true,
  );
}

function handleEnterState(ctx: HandlerContext): ActionResult {
  const { store, board, input, now, version } = ctx;
  if (!input.state_id) return toolError("INVALID_INPUT", "enter_state requires state_id");
  const enterResult = enterState(board, input.state_id);
  if (!enterResult.ok) {
    return toolError("INVALID_INPUT", enterResult.reason, false);
  }
  const updatedBoard = enterResult.board;
  const txResult = store.transaction(() => {
    const vr = store.updateExecutionVersioned(
      { current_state: input.state_id!, last_updated: now },
      version,
    );
    if (!vr.updated) return { currentVersion: vr.currentVersion, ok: false as const };
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
    return { ok: true as const };
  });
  if (!txResult.ok) return boardLockedError(txResult.currentVersion);
  return { board: updatedBoard };
}

function handleSkipState(ctx: HandlerContext): ActionResult {
  const { store, board, input, now, version } = ctx;
  if (!input.state_id) return toolError("INVALID_INPUT", "skip_state requires state_id");
  if (input.next_state_id && !board.states[input.next_state_id]) {
    return toolError(
      "INVALID_INPUT",
      `skip_state next_state_id "${input.next_state_id}" does not exist in board states`,
    );
  }
  const stateEntry = board.states[input.state_id];
  if (!stateEntry) return { board };

  const newSkipped = [...board.skipped, input.state_id];
  const updatedBoard: Board = {
    ...board,
    skipped: newSkipped,
    states: { ...board.states, [input.state_id]: { ...stateEntry, status: "skipped" } },
    ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
    last_updated: now,
  };
  const txResult = store.transaction(() => {
    store.upsertState(input.state_id!, {
      ...updatedBoard.states[input.state_id!],
      entries: stateEntry.entries,
      status: "skipped",
    });
    const vr = store.updateExecutionVersioned(
      {
        last_updated: now,
        skipped: newSkipped,
        ...(input.next_state_id ? { current_state: input.next_state_id } : {}),
      },
      version,
    );
    if (!vr.updated) return { currentVersion: vr.currentVersion, ok: false as const };
    return { ok: true as const };
  });
  if (!txResult.ok) return boardLockedError(txResult.currentVersion);
  return { board: updatedBoard };
}

function handleSetWaveProgress(ctx: HandlerContext): ActionResult {
  const { store, board, input, now, version } = ctx;
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
  const txResult = store.transaction(() => {
    store.upsertState(input.state_id!, {
      ...(stateEntry ?? { entries: 0, status: "pending" as const }),
      entries: stateEntry?.entries ?? 0,
      status: stateEntry?.status ?? ("pending" as const),
      wave: input.wave_data!.wave,
      wave_results: newWaveResults,
      wave_total: input.wave_data!.wave_total,
    });
    const vr = store.updateExecutionVersioned({ last_updated: now }, version);
    if (!vr.updated) return { currentVersion: vr.currentVersion, ok: false as const };
    return { ok: true as const };
  });
  if (!txResult.ok) return boardLockedError(txResult.currentVersion);
  return { board: updatedBoard };
}

/** Register file claims and return updated metadata with any overlap warnings. */
async function applyAffectedFilesClaims(
  store: ReturnType<typeof getExecutionStore>,
  metadata: Record<string, string | number | boolean>,
  affectedFiles: string,
  projectDir: string,
): Promise<Record<string, string | number | boolean>> {
  try {
    const { registerClaims, checkClaimOverlaps } = await import("@shared/lib/file-claims.ts");
    const filePaths: string[] = JSON.parse(affectedFiles);
    const session = store.getSession();
    if (!session) return metadata;
    registerClaims(projectDir, session.slug, filePaths);
    const overlaps = checkClaimOverlaps(projectDir, session.slug, filePaths);
    if (overlaps.length === 0) return metadata;
    const warningLines = overlaps.map(
      (o) => `${o.file_path} also claimed by: ${o.workflows.join(", ")}`,
    );
    return { ...metadata, claim_warnings: warningLines.join("; ") };
  } catch (err: unknown) {
    console.warn(
      "[canon] failed to register file claims:",
      err instanceof Error ? err.message : err,
    );
    return metadata;
  }
}

function handleBlock(ctx: HandlerContext): ActionResult {
  const { store, board, input, now, version } = ctx;
  if (!input.state_id) return toolError("INVALID_INPUT", "block requires state_id");
  const blocked = setBlocked(board, input.state_id, input.blocked_reason ?? "No reason provided");
  const txResult = store.transaction(() => {
    const vr = store.updateExecutionVersioned(
      { blocked: blocked.blocked, last_updated: now },
      version,
    );
    if (!vr.updated) return { currentVersion: vr.currentVersion, ok: false as const };
    const blockedState = blocked.states[input.state_id!];
    if (blockedState)
      store.upsertState(input.state_id!, {
        ...blockedState,
        entries: blockedState.entries,
        status: "blocked",
      });
    return { ok: true as const };
  });
  if (!txResult.ok) return boardLockedError(txResult.currentVersion);
  return { board: blocked };
}

function handleUnblock(ctx: HandlerContext): ActionResult {
  const { store, board, input, now, version } = ctx;
  if (!input.state_id) return toolError("INVALID_INPUT", "unblock requires state_id");
  const stateEntry = board.states[input.state_id];
  const unblocked: Board = {
    ...board,
    blocked: null,
    last_updated: now,
    states: {
      ...board.states,
      [input.state_id]: { ...stateEntry, error: undefined, status: "in_progress" as const },
    },
  };
  const txResult = store.transaction(() => {
    const vr = store.updateExecutionVersioned({ blocked: null, last_updated: now }, version);
    if (!vr.updated) return { currentVersion: vr.currentVersion, ok: false as const };
    const st = unblocked.states[input.state_id!];
    if (st)
      store.upsertState(input.state_id!, { ...st, entries: st.entries, status: "in_progress" });
    return { ok: true as const };
  });
  if (!txResult.ok) return boardLockedError(txResult.currentVersion);
  return { board: unblocked };
}

async function handleSetMetadata(ctx: HandlerContext): Promise<ActionResult> {
  const { store, board, input, now, version } = ctx;
  if (!input.metadata) return toolError("INVALID_INPUT", "set_metadata requires metadata");
  let metadata = { ...(board.metadata ?? {}), ...input.metadata };
  const txResult = store.transaction(() => {
    const vr = store.updateExecutionVersioned({ last_updated: now, metadata }, version);
    if (!vr.updated) return { currentVersion: vr.currentVersion, ok: false as const };
    return { ok: true as const };
  });
  if (!txResult.ok) return boardLockedError(txResult.currentVersion);

  // If affected_files metadata was set, register file claims and check for overlaps
  if (input.metadata.affected_files && typeof input.metadata.affected_files === "string") {
    const projectDir = input.project_dir ?? process.env.CANON_PROJECT_DIR ?? process.cwd();
    metadata = await applyAffectedFilesClaims(
      store,
      metadata,
      input.metadata.affected_files,
      projectDir,
    );
    if (metadata.claim_warnings) {
      // Best-effort: read current version for this follow-up update
      store.updateExecutionVersioned({ metadata }, store.getVersion());
    }
  }

  return { board: { ...board, last_updated: now, metadata } };
}

/** Dispatch block/unblock/set_metadata inline actions. */
async function handleInlineAction(ctx: HandlerContext): Promise<ActionResult> {
  switch (ctx.input.action) {
    case "block":
      return handleBlock(ctx);
    case "unblock":
      return handleUnblock(ctx);
    case "set_metadata":
      return handleSetMetadata(ctx);
    default:
      return toolError(
        "INVALID_INPUT",
        `Unknown action: ${(ctx.input as UpdateBoardInput).action}`,
      );
  }
}

export async function updateBoard(input: UpdateBoardInput): Promise<ToolResult<UpdateBoardResult>> {
  const store = getExecutionStore(input.workspace);
  const boardOrNull = store.getBoard();
  if (!boardOrNull)
    return toolError("WORKSPACE_NOT_FOUND", `No execution found for workspace: ${input.workspace}`);
  let board: Board = boardOrNull;
  const now = new Date().toISOString();
  // Read version once for optimistic locking — all handlers use this snapshot version.
  const version = store.getVersion();
  const ctx: HandlerContext = { board, input, now, store, version };

  let result: ActionResult;

  switch (input.action) {
    case "enter_state":
      result = handleEnterState(ctx);
      break;
    case "skip_state":
      result = handleSkipState(ctx);
      break;
    case "complete_flow": {
      board = await handleCompleteFlow({
        board,
        now,
        projectDir: input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd(),
        store,
        version,
        workspacePath: input.workspace,
      });
      result = { board };
      break;
    }
    case "set_wave_progress":
      result = handleSetWaveProgress(ctx);
      break;
    default:
      result = await handleInlineAction(ctx);
      break;
  }

  if (isError(result)) return result;
  board = result.board;

  emitBoardEvents(store, board, input, now);
  return toolOk({ board });
}
