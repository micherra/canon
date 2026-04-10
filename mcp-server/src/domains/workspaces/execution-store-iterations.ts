/**
 * Iteration lifecycle and stuck detection operations for ExecutionStore.
 * Extracted from execution-store.ts to keep each file under 600 lines.
 *
 * All functions take explicit statement/db parameters so they can be called from
 * ExecutionStore without circular imports.
 */

import type { HistoryEntry, IterationEntry } from "@domains/flows/board-state-schemas.ts";
import type { StuckWhen } from "@domains/flows/flow-definition-schemas.ts";
import type Database from "better-sqlite3";
import type { ExecutionStateRow, IterationRow } from "./execution-store-types.ts";
import { setsEqual, unorderedEqual } from "./execution-store-types.ts";

// ---- Iteration upsert / get ----

export function upsertIteration(
  stmtUpsertIteration: Database.Statement,
  stateId: string,
  fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
): void {
  stmtUpsertIteration.run({
    cannot_fix: JSON.stringify(fields.cannot_fix ?? []),
    count: fields.count,
    history: JSON.stringify(fields.history),
    max: fields.max,
    state_id: stateId,
  });
}

export function getIteration(
  stmtGetIteration: Database.Statement,
  stateId: string,
): IterationEntry | null {
  const row = stmtGetIteration.get(stateId) as IterationRow | undefined;
  if (!row) return null;
  return {
    cannot_fix: JSON.parse(row.cannot_fix),
    count: row.count,
    history: JSON.parse(row.history),
    max: row.max,
  };
}

// ---- Iteration results (SQL-based stuck detection — ADR-004) ----

export type RecordIterationResultOptions = {
  stateId: string;
  iteration: number;
  status: string;
  data: Record<string, unknown>;
};

/**
 * Record a raw iteration result for a state.
 * Uses INSERT OR REPLACE — re-recording the same iteration number overwrites the previous entry.
 */
export function recordIterationResult(
  stmtRecordIterationResult: Database.Statement,
  opts: RecordIterationResultOptions,
): void {
  stmtRecordIterationResult.run({
    data: JSON.stringify(opts.data),
    iteration: opts.iteration,
    state_id: opts.stateId,
    status: opts.status,
    timestamp: new Date().toISOString(),
  });
}

function isSameViolations(
  currData: Record<string, unknown>,
  prevData: Record<string, unknown>,
): boolean {
  return (
    setsEqual(
      (currData.principle_ids as string[]) ?? [],
      (prevData.principle_ids as string[]) ?? [],
    ) && setsEqual((currData.file_paths as string[]) ?? [], (prevData.file_paths as string[]) ?? [])
  );
}

export function isStuck(
  stmtGetLastTwoIterationResults: Database.Statement,
  stateId: string,
  stuckWhen: StuckWhen,
): boolean {
  const rows = stmtGetLastTwoIterationResults.all(stateId) as Array<{
    status: string;
    data: string;
  }>;

  if (rows.length < 2) return false;

  const curr = rows[0];
  const prev = rows[1];
  const currData = JSON.parse(curr.data) as Record<string, unknown>;
  const prevData = JSON.parse(prev.data) as Record<string, unknown>;

  switch (stuckWhen) {
    case "same_violations":
      return isSameViolations(currData, prevData);
    case "same_file_test": {
      const currPairs = (currData.pairs ?? []) as unknown[];
      const prevPairs = (prevData.pairs ?? []) as unknown[];
      if (currPairs.length === 0) return false;
      return unorderedEqual(currPairs, prevPairs);
    }
    case "same_status":
      return curr.status === prev.status;
    case "no_progress":
      return (
        currData.commit_sha === prevData.commit_sha &&
        currData.artifact_count === prevData.artifact_count
      );
    case "no_gate_progress":
      return currData.gate_output_hash === prevData.gate_output_hash && !currData.passed;
    default:
      return false;
  }
}

// ---- Domain-language operations ----

export type StateEntryCallbacks = {
  upsertStateFn: (
    stateId: string,
    fields: { status: string; entered_at: string; entries: number },
  ) => void;
  getStateFn: (stateId: string) => { entries?: number } | null;
};

/**
 * Record a state being entered — sets status to in_progress and increments entries.
 * Takes callbacks to avoid a circular dependency on ExecutionStore.
 */
export function recordStateEntry(
  callbacks: StateEntryCallbacks,
  stateId: string,
  fields?: Record<string, unknown>,
): void {
  const current = callbacks.getStateFn(stateId);
  callbacks.upsertStateFn(stateId, {
    ...fields,
    entered_at: new Date().toISOString(),
    entries: (current?.entries ?? 0) + 1,
    status: "in_progress",
  });
}

export type StateCompletionCallbacks = {
  transactionFn: <T>(fn: () => T) => T;
  upsertStateFn: (stateId: string, fields: Record<string, unknown>) => void;
  getStateFn: (stateId: string) => Record<string, unknown> | null;
  upsertIterationFn: (
    stateId: string,
    fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
  ) => void;
  getIterationFn: (stateId: string) => IterationEntry | null;
};

export type StateCompletionOptions = {
  stateId: string;
  result: string;
  artifacts?: string[];
  iterationHistory?: HistoryEntry[];
};

/**
 * Record a state completing — sets status to done, persists result and artifacts.
 * Wrapped in a transaction so state update and iteration update are atomic.
 */
export function recordStateCompletion(
  callbacks: StateCompletionCallbacks,
  opts: StateCompletionOptions,
): void {
  callbacks.transactionFn(() => {
    const current = callbacks.getStateFn(opts.stateId);
    callbacks.upsertStateFn(opts.stateId, {
      ...current,
      ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
      completed_at: new Date().toISOString(),
      entries: (current?.entries as number) ?? 1,
      result: opts.result,
      status: "done",
    });
    if (opts.iterationHistory !== undefined) {
      const iteration = callbacks.getIterationFn(opts.stateId);
      if (iteration !== null) {
        callbacks.upsertIterationFn(opts.stateId, { ...iteration, history: opts.iterationHistory });
      }
    }
  });
}

export type IterationAttemptCallbacks = {
  recordIterationResultFn: (
    stateId: string,
    iteration: number,
    status: string,
    data: Record<string, unknown>,
  ) => void;
  isStuckFn: (stateId: string, stuckWhen: StuckWhen) => boolean;
};

/** Record one iteration attempt; check stuck if stuckWhen provided. */
export function recordIterationAttempt(
  callbacks: IterationAttemptCallbacks,
  stateId: string,
  options: {
    iteration: number;
    status: string;
    data: Record<string, unknown>;
    stuckWhen?: StuckWhen;
  },
): { recorded: true; stuck: boolean } {
  const { iteration, status, data, stuckWhen } = options;
  callbacks.recordIterationResultFn(stateId, iteration, status, data);
  if (stuckWhen !== undefined) {
    return { recorded: true, stuck: callbacks.isStuckFn(stateId, stuckWhen) };
  }
  return { recorded: true, stuck: false };
}

// ---- Orientation ratio (ADR-003a) ----

/** Compute orientation_calls / tool_calls for a state. Returns 0 when data absent. */
export function getOrientationRatio(stmtGetState: Database.Statement, stateId: string): number {
  const row = stmtGetState.get(stateId) as ExecutionStateRow | undefined;
  if (!row?.metrics) return 0;

  const metrics = JSON.parse(row.metrics) as Record<string, unknown>;
  const toolCalls = typeof metrics.tool_calls === "number" ? metrics.tool_calls : 0;
  const orientationCalls =
    typeof metrics.orientation_calls === "number" ? metrics.orientation_calls : 0;

  if (toolCalls === 0) return 0;
  return orientationCalls / toolCalls;
}
