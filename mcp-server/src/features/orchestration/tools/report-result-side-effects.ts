/**
 * Post-transaction side effects for report-result.
 * Handles transcript persistence, progress lines, drift effects,
 * event emission, and log entry construction.
 */

import { relative, resolve } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type {
  ResolvedFlow,
  StateDefinition,
  StuckWhen,
} from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import type { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { executeEffects } from "../engine/effects.ts";
import type {
  LogEntry,
  ReportResultInput,
  ReportResultResult,
  TransactionResult,
} from "./report-result.ts";
import { validateRequiredHandoffs } from "./report-result-validation.ts";

export async function postTransactionSideEffects({
  store,
  input,
  stateDef,
  txResult,
  escalateToHitl,
}: {
  store: ReturnType<typeof getExecutionStore>;
  input: ReportResultInput;
  stateDef: ResolvedFlow["states"][string] | undefined;
  txResult: TransactionResult;
  escalateToHitl?: ReportResultResult["escalate_to_hitl"];
}): Promise<import("@shared/lib/tool-result.ts").ToolResult<ReportResultResult>> {
  const { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason } = txResult;

  persistTranscriptPath(store, input);
  persistProgressLine(store, input.progress_line);
  await runDriftEffects(stateDef, input);
  emitStuckEvent(store, { board, input, stateDef, stuck, stuck_reason });
  emitReportEvents(store, { condition, hitl_reason, hitl_required, input, nextState });

  const handoffWarnings = stateDef?.required_handoffs
    ? await validateRequiredHandoffs(input.workspace, stateDef.required_handoffs)
    : [];

  const log_entry = buildLogEntry(input, {
    condition,
    hitl_reason,
    hitl_required,
    nextState,
    stuck,
    stuck_reason,
  });

  return {
    board,
    hitl_reason,
    hitl_required,
    log_entry,
    next_state: nextState,
    ok: true as const,
    stuck,
    stuck_reason,
    transition_condition: condition,
    ...(escalateToHitl ? { escalate_to_hitl: escalateToHitl } : {}),
    ...(handoffWarnings.length > 0 ? { warnings: handoffWarnings } : {}),
  };
}

export function persistTranscriptPath(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
): void {
  if (!input.transcript_path) return;
  const transcriptsDir = resolve(input.workspace, "transcripts");
  const resolvedPath = resolve(input.transcript_path);
  const rel = relative(transcriptsDir, resolvedPath);
  if (!rel.startsWith("..") && resolve(transcriptsDir, rel) === resolvedPath) {
    store.setTranscriptPath(input.state_id, input.transcript_path);
  }
}

export function persistProgressLine(
  store: ReturnType<typeof getExecutionStore>,
  line?: string,
): void {
  if (!line) return;
  try {
    store.appendProgress(line);
  } catch (err) {
    console.warn("[canon] progress write failed:", err instanceof Error ? err.message : err);
  }
}

export async function runDriftEffects(
  stateDef: ReturnType<typeof Object.values<Record<string, unknown>>>[number] | undefined,
  input: ReportResultInput,
): Promise<void> {
  const def = stateDef as { effects?: unknown[] } | undefined;
  if (!def?.effects?.length || !input.artifacts?.length) return;
  const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
  await executeEffects(def as StateDefinition, {
    artifacts: input.artifacts,
    projectDir,
    workspace: input.workspace,
  }).catch((err) => {
    console.warn("[canon] drift effects failed:", err instanceof Error ? err.message : err);
  });
}

export type EmitStuckEventOptions = {
  board: Board;
  input: ReportResultInput;
  stuck: boolean;
  stuck_reason: string | undefined;
  stateDef: { stuck_when?: StuckWhen } | undefined;
};

function buildStuckPayload(options: EmitStuckEventOptions, correlationId: string | null) {
  const { board, input, stuck_reason, stateDef } = options;
  const history = board.iterations[input.state_id]?.history ?? [];
  return {
    comparison: {
      current: history.length >= 1 ? (history[history.length - 1] as Record<string, unknown>) : {},
      previous: history.length >= 2 ? (history[history.length - 2] as Record<string, unknown>) : {},
    },
    iteration_count: history.length,
    reason: stuck_reason!,
    stateId: input.state_id,
    strategy: stateDef?.stuck_when ?? "unknown",
    timestamp: new Date().toISOString(),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  };
}

export function emitStuckEvent(
  store: ReturnType<typeof getExecutionStore>,
  options: EmitStuckEventOptions,
): void {
  if (!options.stuck || !options.stuck_reason) return;
  const correlationId = store.getCorrelationId();
  const payload = buildStuckPayload(options, correlationId);
  try {
    store.appendEvent("stuck_detected", payload, correlationId ?? undefined);
  } catch (err) {
    console.warn(
      "[canon] stuck event persistence failed:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    flowEventBus.emit("stuck_detected", payload);
  } catch (err) {
    console.warn("[canon] stuck event emission failed:", err instanceof Error ? err.message : err);
  }
}

export type EmitReportEventsOptions = {
  input: ReportResultInput;
  condition: string;
  nextState: string | null;
  hitl_required: boolean;
  hitl_reason: string | undefined;
};

export function emitReportEvents(
  store: ReturnType<typeof getExecutionStore>,
  options: EmitReportEventsOptions,
): void {
  const { input, condition, nextState, hitl_required, hitl_reason } = options;
  const correlationId = store.getCorrelationId();
  const onStateCompleted = (
    event: import("@domains/messages/events.js").FlowEventMap["state_completed"],
  ) => {
    try {
      store.appendEvent(
        "state_completed",
        event as Record<string, unknown>,
        correlationId ?? undefined,
      );
    } catch (err) {
      console.warn(
        "[canon] state_completed event persistence failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };
  const onTransitionEvaluated = (
    event: import("@domains/messages/events.js").FlowEventMap["transition_evaluated"],
  ) => {
    try {
      store.appendEvent(
        "transition_evaluated",
        event as Record<string, unknown>,
        correlationId ?? undefined,
      );
    } catch (err) {
      console.warn(
        "[canon] transition_evaluated event persistence failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };
  flowEventBus.once("state_completed", onStateCompleted);
  flowEventBus.once("transition_evaluated", onTransitionEvaluated);
  try {
    flowEventBus.emit("state_completed", {
      artifacts: input.artifacts ?? [],
      duration_ms: input.metrics?.duration_ms ?? 0,
      result: condition,
      stateId: input.state_id,
      timestamp: new Date().toISOString(),
      ...collectQualitySignals(input),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    });
    flowEventBus.emit("transition_evaluated", {
      nextState: nextState ?? "null",
      normalizedCondition: condition,
      stateId: input.state_id,
      statusKeyword: input.status_keyword,
      timestamp: new Date().toISOString(),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    });
    if (hitl_required) {
      flowEventBus.emit("hitl_triggered", {
        reason: hitl_reason ?? "unknown",
        stateId: input.state_id,
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    flowEventBus.removeListener("state_completed", onStateCompleted);
    flowEventBus.removeListener("transition_evaluated", onTransitionEvaluated);
  }
}

export function collectQualitySignals(input: ReportResultInput): Partial<LogEntry> {
  const signals: Partial<LogEntry> = {};
  if (input.gate_results?.length) signals.gate_results = input.gate_results;
  if (input.postcondition_results?.length)
    signals.postcondition_results = input.postcondition_results;
  if (input.violation_count != null) signals.violation_count = input.violation_count;
  if (input.violation_severities) signals.violation_severities = input.violation_severities;
  if (input.test_results) signals.test_results = input.test_results;
  if (input.files_changed != null) signals.files_changed = input.files_changed;
  if (input.discovered_gates?.length)
    signals.discovered_gates_count = input.discovered_gates.length;
  if (input.discovered_postconditions?.length)
    signals.discovered_postconditions_count = input.discovered_postconditions.length;
  return signals;
}

export type BuildLogEntryOptions = {
  condition: string;
  nextState: string | null;
  stuck: boolean;
  hitl_required: boolean;
  stuck_reason?: string;
  hitl_reason?: string;
};

export function buildLogEntry(input: ReportResultInput, options: BuildLogEntryOptions): LogEntry {
  const { condition, nextState, stuck, hitl_required, stuck_reason, hitl_reason } = options;
  return {
    hitl_required,
    next_state: nextState,
    normalized_condition: condition,
    state_id: input.state_id,
    status_keyword: input.status_keyword,
    stuck,
    timestamp: new Date().toISOString(),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(stuck_reason ? { stuck_reason } : {}),
    ...(hitl_reason ? { hitl_reason } : {}),
    ...collectQualitySignals(input),
  };
}
