/**
 * Board reconstruction and state serialization helpers for ExecutionStore.
 * Extracted from execution-store.ts to keep each file under 600 lines.
 *
 * All functions take explicit statement/db parameters so they can be called from
 * ExecutionStore without circular imports.
 */

import type { Board, BoardStateEntry } from "@domains/flows/board-state-schemas.ts";
import type Database from "better-sqlite3";
import type { ExecutionRow, ExecutionStateRow, IterationRow } from "./execution-store-types.ts";
import { parseJson } from "./execution-store-types.ts";

// ---- Board reconstruction ----

/**
 * Reconstructs the full Board object from execution + execution_states + iterations.
 * Returns null when no execution exists.
 */
export function getBoard(
  db: Database.Database,
  stmtGetExecution: Database.Statement,
  stmtGetAllStates: Database.Statement,
): Board | null {
  const exRow = stmtGetExecution.get() as ExecutionRow | undefined;
  if (!exRow) return null;

  const stateRows = stmtGetAllStates.all() as ExecutionStateRow[];
  const iterRows = db.prepare("SELECT * FROM iterations").all() as IterationRow[];

  const states: Board["states"] = {};
  for (const row of stateRows) {
    states[row.state_id] = deserializeStateRow(row);
  }

  const iterations: Board["iterations"] = {};
  for (const row of iterRows) {
    iterations[row.state_id] = {
      cannot_fix: JSON.parse(row.cannot_fix),
      count: row.count,
      history: JSON.parse(row.history),
      max: row.max,
    };
  }

  return {
    base_commit: exRow.base_commit,
    blocked: exRow.blocked !== null ? JSON.parse(exRow.blocked) : null,
    concerns: JSON.parse(exRow.concerns),
    current_state: exRow.current_state,
    entry: exRow.entry,
    flow: exRow.flow,
    iterations,
    last_updated: exRow.last_updated,
    metadata: exRow.metadata !== null ? JSON.parse(exRow.metadata) : undefined,
    skipped: JSON.parse(exRow.skipped),
    started: exRow.started,
    states,
    task: exRow.task,
  };
}

// ---- Serialization helpers ----

/** Serialize BoardStateEntry fields into the parameter object for stmtUpsertState. */
export function buildUpsertStateParams(
  stateId: string,
  fields: Partial<BoardStateEntry> & { status: BoardStateEntry["status"]; entries: number },
): Record<string, unknown> {
  const jsonOrNull = (v: unknown) => (v !== undefined ? JSON.stringify(v) : null);
  return {
    artifact_history: jsonOrNull(fields.artifact_history),
    artifacts: jsonOrNull(fields.artifacts),
    compete_results: jsonOrNull(fields.compete_results),
    completed_at: fields.completed_at ?? null,
    discovered_gates: jsonOrNull(fields.discovered_gates),
    discovered_postconditions: jsonOrNull(fields.discovered_postconditions),
    entered_at: fields.entered_at ?? null,
    entries: fields.entries,
    error: fields.error ?? null,
    gate_results: jsonOrNull(fields.gate_results),
    inserted_return_to: fields.inserted_return_to ?? null,
    metrics: jsonOrNull(fields.metrics),
    parallel_results: jsonOrNull(fields.parallel_results),
    postcondition_results: jsonOrNull(fields.postcondition_results),
    result: fields.result ?? null,
    state_id: stateId,
    status: fields.status,
    synthesized: fields.synthesized !== undefined ? (fields.synthesized ? 1 : 0) : null,
    wave: fields.wave ?? null,
    wave_results: jsonOrNull(fields.wave_results),
    wave_total: fields.wave_total ?? null,
  };
}

// ---- Deserialization helpers ----

export function deserializeExecutionRow(row: ExecutionRow) {
  return {
    ...row,
    blocked: row.blocked !== null ? JSON.parse(row.blocked) : null,
    concerns: JSON.parse(row.concerns),
    metadata: row.metadata !== null ? JSON.parse(row.metadata) : undefined,
    skipped: JSON.parse(row.skipped),
  };
}

export function deserializeStateRow(row: ExecutionStateRow): BoardStateEntry {
  return {
    artifact_history: parseJson(row.artifact_history),
    artifacts: parseJson<string[]>(row.artifacts),
    compete_results: parseJson(row.compete_results),
    completed_at: row.completed_at ?? undefined,
    discovered_gates: parseJson(row.discovered_gates),
    discovered_postconditions: parseJson(row.discovered_postconditions),
    entered_at: row.entered_at ?? undefined,
    entries: row.entries,
    error: row.error ?? undefined,
    gate_results: parseJson(row.gate_results),
    inserted_return_to: row.inserted_return_to ?? undefined,
    metrics: parseJson(row.metrics),
    parallel_results: parseJson(row.parallel_results),
    postcondition_results: parseJson(row.postcondition_results),
    result: row.result ?? undefined,
    status: row.status as BoardStateEntry["status"],
    synthesized: row.synthesized !== null ? Boolean(row.synthesized) : undefined,
    wave: row.wave ?? undefined,
    wave_results: parseJson(row.wave_results),
    wave_total: row.wave_total ?? undefined,
  };
}
