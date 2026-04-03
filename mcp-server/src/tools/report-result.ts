/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  normalizeStatus,
  evaluateTransition,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  isStuck,
  aggregateParallelPerResults,
  aggregateReviewResults,
  isRoleOptional,
} from "../orchestration/transitions.ts";
import {
  completeState,
  setBlocked,
} from "../orchestration/board.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { syncBoardToStore } from "../orchestration/board-sync.ts";
import { toolError } from "../utils/tool-result.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import type { Board, ResolvedFlow, CannotFixItem, GateResult, PostconditionResult, DiscoveredGate, PostconditionAssertion, ViolationSeverities, TestResults } from "../orchestration/flow-schema.ts";
import { STATUS_KEYWORDS, STATUS_ALIASES } from "../orchestration/flow-schema.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { executeEffects } from "../orchestration/effects.ts";
import { inspectDebateProgress } from "../orchestration/debate.ts";

/** Maps producer agent type to the handoff file they should write.
 * NOTE: must stay in sync with HANDOFF_CONSUMER_MAP in prompt-pipeline/inject-handoffs.ts */
const HANDOFF_PRODUCER_MAP: Record<string, string> = {
  "canon:canon-researcher": "research-synthesis.md",
  "canon:canon-architect": "design-brief.md",
  "canon:canon-implementor": "impl-handoff.md",
  "canon:canon-tester": "test-findings.md",
};

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
  // ADR-015: path to the agent transcript JSONL file (best-effort persistence)
  transcript_path?: string;
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

export async function reportResult(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  return reportResultLocked(input);
}

async function reportResultLocked(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  const store = getExecutionStore(input.workspace);

  // Guard: check board existence before entering the SQLite transaction so we
  // can return a typed WORKSPACE_NOT_FOUND error instead of throwing UNEXPECTED.
  if (!store.getBoard()) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found in workspace: ${input.workspace}`);
  }

  // Pre-fetch debate progress asynchronously before entering the synchronous
  // transaction. inspectDebateProgress reads separate message/event tables
  // and does not depend on board state, so fetching it here is safe.
  // better-sqlite3 transactions must be fully synchronous; any await inside
  // db.transaction() is not allowed.
  let debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  const stateDef = input.flow.states[input.state_id];
  if (input.state_id === input.flow.entry && input.flow.debate) {
    debateResult = await inspectDebateProgress(input.workspace, input.flow.debate);
  }

  // ---------------------------------------------------------------------------
  // Synchronous read-modify-write — wrapped in a single SQLite transaction so
  // that the board read and all subsequent writes are atomic. This prevents
  // concurrent callers from racing on a stale snapshot and overwriting each
  // other's accumulated fields (discovered_gates, discovered_postconditions,
  // cannot_fix, etc.).
  // ---------------------------------------------------------------------------
  const { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason } =
    store.transaction((): {
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
        // Safety net: should not reach here since we checked above, but
        // the transaction is atomic so a concurrent caller could delete the
        // workspace between our check and the transaction start.
        throw new Error(`No execution found in workspace: ${input.workspace}`);
      }

      // Normalize status keyword
      let condition = normalizeStatus(input.status_keyword);

      // Apply review threshold if flow has one
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

        // Build the set of optional role names from the state's roles definition.
        const optionalRoles = new Set<string>();
        if (stateDef?.roles) {
          for (const roleEntry of stateDef.roles) {
            if (isRoleOptional(roleEntry)) {
              const name = typeof roleEntry === "string" ? roleEntry : roleEntry.name;
              optionalRoles.add(name);
            }
          }
        }

        const aggregated = isReviewAggregation
          ? aggregateReviewResults(input.parallel_results)
          : aggregateParallelPerResults(input.parallel_results, optionalRoles.size > 0 ? optionalRoles : undefined);
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

      // Accumulate discovered gates (append, not replace — multiple agents may discover gates).
      // Reading existing state from the DB inside the transaction ensures we see the latest
      // committed value rather than a stale in-memory snapshot (concurrent-safe accumulation).
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

      // Persist compete results to board state entry
      if (input.compete_results?.length && board.states[input.state_id]) {
        board = {
          ...board,
          states: {
            ...board.states,
            [input.state_id]: {
              ...board.states[input.state_id],
              compete_results: input.compete_results,
              ...(input.synthesized != null ? { synthesized: input.synthesized } : {}),
            },
          },
        };
      } else if (input.synthesized != null && board.states[input.state_id]) {
        // synthesized can be set without compete_results (e.g., marking synthesis complete)
        board = {
          ...board,
          states: {
            ...board.states,
            [input.state_id]: {
              ...board.states[input.state_id],
              synthesized: input.synthesized,
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

      // Apply debate result (pre-fetched asynchronously before this transaction)
      let hitl_required = false;
      let hitl_reason: string | undefined;

      if (debateResult !== undefined) {
        board = {
          ...board,
          metadata: {
            ...(board.metadata ?? {}),
            debate_last_round: debateResult.last_completed_round,
            debate_completed: debateResult.completed,
            ...(debateResult.summary ? { debate_summary: debateResult.summary } : {}),
          },
        };

        if (!debateResult.completed) {
          nextState = input.state_id;
        } else if (input.flow.debate!.hitl_checkpoint) {
          nextState = null;
          hitl_required = true;
          hitl_reason = `Debate completed after round ${debateResult.last_completed_round}${
            debateResult.convergence?.reason ? `: ${debateResult.convergence.reason}` : ""
          }`;
        }
      }

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
      } else if (!hitl_required && nextState === null && stateDef?.type !== "terminal") {
        hitl_required = true;
        if (!isRecognized) {
          hitl_reason = `Unrecognized status keyword '${input.status_keyword}' from state '${input.state_id}' (normalized to '${condition}')`;
        } else {
          hitl_reason = `No matching transition from '${input.state_id}' for condition '${condition}'`;
        }
        board = setBlocked(board, input.state_id, hitl_reason);
      }

      if (hitl_required && hitl_reason && board.blocked == null && stateDef?.type !== "terminal") {
        board = setBlocked(board, input.state_id, hitl_reason);
      }

      // Update current_state if we have a valid next state
      if (nextState && nextState !== "hitl") {
        board = {
          ...board,
          current_state: nextState,
        };
      }

      // Write board — still inside the transaction
      syncBoardToStore(store, board);

      return { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason };
    });

  // Persist transcript path (ADR-015) — path validation is pure, setTranscriptPath
  // returns boolean (errors-are-values). No try/catch needed; if the DB is broken,
  // let it propagate to wrapHandler.
  if (input.transcript_path) {
    const transcriptsDir = resolve(input.workspace, "transcripts");
    const resolvedPath = resolve(input.transcript_path);
    const rel = relative(transcriptsDir, resolvedPath);
    if (!rel.startsWith("..") && resolve(transcriptsDir, rel) === resolvedPath) {
      store.setTranscriptPath(input.state_id, input.transcript_path);
    }
  }

  // Append progress line (best-effort — cosmetic, never blocks the flow)
  if (input.progress_line) {
    try {
      store.appendProgress(input.progress_line);
    } catch {
      // best-effort — never blocks the flow
    }
  }

  // Execute drift effects (best-effort — never blocks the flow)
  if (stateDef?.effects?.length && input.artifacts?.length) {
    const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
    await executeEffects(stateDef, input.workspace, input.artifacts, projectDir).catch(() => {});
  }

  // Check expected handoff file existence (best-effort — never blocks the flow)
  if (stateDef?.agent) {
    const expectedHandoff = HANDOFF_PRODUCER_MAP[stateDef.agent];
    if (expectedHandoff) {
      try {
        const handoffPath = resolve(input.workspace, "handoffs", expectedHandoff);
        if (!existsSync(handoffPath)) {
          const correlationId = store.getCorrelationId();
          const handoffMissingPayload = {
            stateId: input.state_id,
            expectedFile: expectedHandoff,
            agentType: stateDef.agent,
            timestamp: new Date().toISOString(),
            ...(correlationId ? { correlation_id: correlationId } : {}),
          };
          try {
            store.appendEvent("handoff_missing", handoffMissingPayload, correlationId ?? undefined);
          } catch { /* best-effort */ }
          try {
            flowEventBus.emit("handoff_missing", handoffMissingPayload);
          } catch { /* best-effort */ }
        }
      } catch (err) { console.debug("handoff check failed:", err); /* best-effort — never blocks the flow */ }
    }
  }

  // Emit stuck_detected event (best-effort — follows established best-effort pattern).
  // This is explicit and happens before the other events so it's visible in the event log
  // before state_completed / transition_evaluated are appended.
  if (stuck && stuck_reason) {
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
    } catch { /* best-effort */ }
    try {
      flowEventBus.emit("stuck_detected", stuckPayload);
    } catch { /* best-effort */ }
  }

  // Emit events (best-effort — listeners must swallow errors).
  // once() auto-removes listeners on first fire; the finally block removes any
  // listeners that were registered but not fired due to an error mid-sequence.
  const correlationId = store.getCorrelationId();
  const onStateCompleted = (event: import("../orchestration/events.js").FlowEventMap["state_completed"]) => {
    try { store.appendEvent("state_completed", event as Record<string, unknown>, correlationId ?? undefined); } catch { /* best-effort */ }
  };
  const onTransitionEvaluated = (event: import("../orchestration/events.js").FlowEventMap["transition_evaluated"]) => {
    try { store.appendEvent("transition_evaluated", event as Record<string, unknown>, correlationId ?? undefined); } catch { /* best-effort */ }
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
      ...(correlationId ? { correlation_id: correlationId } : {}),
    });
    flowEventBus.emit("transition_evaluated", {
      stateId: input.state_id,
      statusKeyword: input.status_keyword,
      normalizedCondition: condition,
      nextState: nextState ?? "null",
      timestamp: new Date().toISOString(),
      ...(correlationId ? { correlation_id: correlationId } : {}),
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
