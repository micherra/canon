/**
 * ExecutionStore — SQLite DAO for workspace orchestration state.
 *
 * Wraps a better-sqlite3 Database with typed CRUD operations.
 * All statements are prepared once at construction time and reused.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Replaces: board.json, session.json, progress.md, messages, wave events, log.jsonl
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { CANON_FILES } from "../shared/constants.ts";
import { validateEventPayload } from "./events.ts";
import { initExecutionDb } from "./execution-schema.ts";
import type {
  Board,
  BoardStateEntry,
  IterationEntry,
  Session,
  StuckWhen,
  WaveEvent,
} from "./flow-schema.ts";

// Row types (internal — not exported; callers receive typed objects)

type ExecutionRow = {
  id: number;
  flow: string;
  task: string;
  entry: string;
  current_state: string;
  base_commit: string;
  started: string;
  last_updated: string;
  blocked: string | null; // JSON: BlockedInfo | null
  concerns: string; // JSON array
  skipped: string; // JSON array
  metadata: string | null; // JSON object | null
  branch: string;
  sanitized: string;
  created: string;
  original_task: string | null;
  tier: string;
  flow_name: string;
  slug: string;
  status: string;
  completed_at: string | null;
  rolled_back_at: string | null;
  rolled_back_to: string | null;
  correlation_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
};

type ExecutionStateRow = {
  state_id: string;
  status: string;
  entries: number;
  entered_at: string | null;
  completed_at: string | null;
  result: string | null;
  artifacts: string | null; // JSON array | null
  artifact_history: string | null; // JSON array | null
  error: string | null;
  wave: number | null;
  wave_total: number | null;
  wave_results: string | null; // JSON object | null
  metrics: string | null; // JSON object | null
  gate_results: string | null; // JSON array | null
  postcondition_results: string | null; // JSON array | null
  discovered_gates: string | null; // JSON array | null
  discovered_postconditions: string | null; // JSON array | null
  parallel_results: string | null; // JSON array | null
  compete_results: string | null; // JSON array | null
  synthesized: number | null; // 0/1 | null
  transcript_path: string | null; // ADR-015
};

type IterationRow = {
  state_id: string;
  count: number;
  max: number;
  history: string; // JSON array
  cannot_fix: string; // JSON array
};

type ProgressRow = {
  id: number;
  line: string;
  timestamp: string;
};

type MessageRow = {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
};

type WaveEventRow = {
  id: string;
  type: string;
  payload: string; // JSON
  timestamp: string;
  status: string;
  applied_at: string | null;
  resolution: string | null; // JSON | null
  rejection_reason: string | null;
};

// Parameter types for public API

export type InitExecutionParams = {
  flow: string;
  task: string;
  entry: string;
  current_state: string;
  base_commit: string;
  started: string;
  last_updated: string;
  branch: string;
  sanitized: string;
  created: string;
  original_task?: string;
  tier: "small" | "medium" | "large";
  flow_name: string;
  slug: string;
  status?: string;
  completed_at?: string;
  rolled_back_at?: string;
  rolled_back_to?: string;
  worktree_path?: string;
  worktree_branch?: string;
};

export type UpdateExecutionFields = {
  current_state?: string;
  blocked?: Board["blocked"];
  concerns?: Board["concerns"];
  skipped?: string[];
  metadata?: Board["metadata"];
  last_updated?: string;
  status?: string;
  completed_at?: string;
  rolled_back_at?: string;
  rolled_back_to?: string;
  worktree_path?: string | null;
  worktree_branch?: string | null;
};

export type MessageOutput = {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
};

export type GetMessagesOptions = {
  since?: string;
};

export type GetWaveEventsOptions = {
  status?: string;
};

export type UpdateWaveEventFields = {
  status?: string;
  applied_at?: string;
  resolution?: Record<string, unknown>;
  rejection_reason?: string;
};

export type GetEventsOptions = {
  correlation_id?: string;
  type?: string;
  since?: string;
  limit?: number;
};

export type EventOutput = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  timestamp: string;
};

// Helper — parse nullable JSON column

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value) as T;
}

// Module-level constants

/** Allowlist of columns updateExecution is permitted to SET. Hoisted to avoid recreation per call. */
const ALLOWED_UPDATE_EXECUTION_COLUMNS = new Set([
  "current_state",
  "blocked",
  "concerns",
  "skipped",
  "metadata",
  "status",
  "completed_at",
  "rolled_back_at",
  "rolled_back_to",
  "last_updated",
  "worktree_path",
  "worktree_branch",
]);

// ExecutionStore

export class ExecutionStore {
  // Expose db for test introspection (tests access via `(store as any).db`)
  private readonly db: Database.Database;

  // ---- Execution statements ----
  private stmtInitExecution!: Database.Statement;
  private stmtGetExecution!: Database.Statement;

  // ---- State statements ----
  private stmtUpsertState!: Database.Statement;
  private stmtGetState!: Database.Statement;
  private stmtGetAllStates!: Database.Statement;

  // ---- Iteration statements ----
  private stmtUpsertIteration!: Database.Statement;
  private stmtGetIteration!: Database.Statement;

  // ---- Progress statements ----
  private stmtAppendProgress!: Database.Statement;
  private stmtGetProgressAll!: Database.Statement;
  private stmtGetProgressLimited!: Database.Statement;

  // ---- Message statements ----
  private stmtAppendMessage!: Database.Statement;
  private stmtGetMessages!: Database.Statement;
  private stmtGetMessagesSince!: Database.Statement;
  private stmtHasMessages!: Database.Statement;

  // ---- Wave event statements ----
  private stmtPostWaveEvent!: Database.Statement;
  private stmtGetWaveEvents!: Database.Statement;
  private stmtGetWaveEventsByStatus!: Database.Statement;
  private stmtUpdateWaveEvent!: Database.Statement;

  // ---- Event statements ----
  private stmtAppendEvent!: Database.Statement;
  private stmtGetEventsByCorrelation!: Database.Statement;
  private stmtGetEventsByType!: Database.Statement;
  private stmtGetEventsAll!: Database.Statement;

  // ---- Iteration results statements (SQL-based stuck detection) ----
  private stmtRecordIterationResult!: Database.Statement;
  private stmtGetLastTwoIterationResults!: Database.Statement;

  // ---- Transcript path statements (ADR-015) ----
  private stmtSetTranscriptPath!: Database.Statement;
  private stmtGetTranscriptPath!: Database.Statement;

  // ---- Metrics statements ----
  private stmtUpdateStateMetrics!: Database.Statement;

  // ---- Cache prefix statements (ADR-006a) ----
  private stmtGetCachePrefix!: Database.Statement;
  private stmtSetCachePrefix!: Database.Statement;

  // ---- Agent session statements (ADR-009a) ----
  private stmtUpdateAgentSession!: Database.Statement;
  private stmtGetAgentSession!: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareExecutionStmts(db);
    this.prepareStateStmts(db);
    this.prepareIterationStmts(db);
    this.prepareProgressStmts(db);
    this.prepareMessageStmts(db);
    this.prepareWaveEventStmts(db);
    this.prepareEventStmts(db);
    this.prepareIterationResultStmts(db);
    this.prepareMiscStmts(db);
  }

  private prepareExecutionStmts(db: Database.Database): void {
    this.stmtInitExecution = db.prepare(`
      INSERT INTO execution (
        id, flow, task, entry, current_state, base_commit,
        started, last_updated, blocked, concerns, skipped, metadata,
        branch, sanitized, created, original_task,
        tier, flow_name, slug, status, completed_at,
        rolled_back_at, rolled_back_to, correlation_id,
        worktree_path, worktree_branch
      ) VALUES (
        1, @flow, @task, @entry, @current_state, @base_commit,
        @started, @last_updated, @blocked, @concerns, @skipped, @metadata,
        @branch, @sanitized, @created, @original_task,
        @tier, @flow_name, @slug, @status, @completed_at,
        @rolled_back_at, @rolled_back_to, @correlation_id,
        @worktree_path, @worktree_branch
      )
    `);
    this.stmtGetExecution = db.prepare(`SELECT * FROM execution WHERE id = 1`);
  }

  private prepareStateStmts(db: Database.Database): void {
    this.stmtUpsertState = db.prepare(`
      INSERT INTO execution_states (
        state_id, status, entries, entered_at, completed_at,
        result, artifacts, artifact_history, error,
        wave, wave_total, wave_results, metrics,
        gate_results, postcondition_results, discovered_gates,
        discovered_postconditions, parallel_results, compete_results, synthesized
      ) VALUES (
        @state_id, @status, @entries, @entered_at, @completed_at,
        @result, @artifacts, @artifact_history, @error,
        @wave, @wave_total, @wave_results, @metrics,
        @gate_results, @postcondition_results, @discovered_gates,
        @discovered_postconditions, @parallel_results, @compete_results, @synthesized
      )
      ON CONFLICT(state_id) DO UPDATE SET
        status                    = excluded.status,
        entries                   = excluded.entries,
        entered_at                = excluded.entered_at,
        completed_at              = excluded.completed_at,
        result                    = excluded.result,
        artifacts                 = excluded.artifacts,
        artifact_history          = excluded.artifact_history,
        error                     = excluded.error,
        wave                      = excluded.wave,
        wave_total                = excluded.wave_total,
        wave_results              = excluded.wave_results,
        metrics                   = excluded.metrics,
        gate_results              = excluded.gate_results,
        postcondition_results     = excluded.postcondition_results,
        discovered_gates          = excluded.discovered_gates,
        discovered_postconditions = excluded.discovered_postconditions,
        parallel_results          = excluded.parallel_results,
        compete_results           = excluded.compete_results,
        synthesized               = excluded.synthesized
        -- transcript_path intentionally omitted: preserves existing value on update
    `);
    this.stmtGetState = db.prepare(`SELECT * FROM execution_states WHERE state_id = ?`);
    this.stmtGetAllStates = db.prepare(`SELECT * FROM execution_states ORDER BY state_id`);
  }

  private prepareIterationStmts(db: Database.Database): void {
    this.stmtUpsertIteration = db.prepare(`
      INSERT INTO iterations (state_id, count, max, history, cannot_fix)
      VALUES (@state_id, @count, @max, @history, @cannot_fix)
      ON CONFLICT(state_id) DO UPDATE SET
        count      = excluded.count,
        max        = excluded.max,
        history    = excluded.history,
        cannot_fix = excluded.cannot_fix
    `);
    this.stmtGetIteration = db.prepare(`SELECT * FROM iterations WHERE state_id = ?`);
  }

  private prepareProgressStmts(db: Database.Database): void {
    this.stmtAppendProgress = db.prepare(
      `INSERT INTO progress_entries (line, timestamp) VALUES (@line, @timestamp)`,
    );
    this.stmtGetProgressAll = db.prepare(`SELECT * FROM progress_entries ORDER BY id ASC`);
    this.stmtGetProgressLimited = db.prepare(`
      SELECT * FROM (
        SELECT * FROM progress_entries ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `);
  }

  private prepareMessageStmts(db: Database.Database): void {
    this.stmtAppendMessage = db.prepare(`
      INSERT INTO messages (channel, sender, content, timestamp)
      VALUES (@channel, @sender, @content, @timestamp)
      RETURNING *
    `);
    this.stmtGetMessages = db.prepare(`SELECT * FROM messages WHERE channel = ? ORDER BY id ASC`);
    this.stmtGetMessagesSince = db.prepare(
      `SELECT * FROM messages WHERE channel = ? AND timestamp > ? ORDER BY id ASC`,
    );
    this.stmtHasMessages = db.prepare(`SELECT 1 FROM messages WHERE channel = ? LIMIT 1`);
  }

  private prepareWaveEventStmts(db: Database.Database): void {
    this.stmtPostWaveEvent = db.prepare(`
      INSERT INTO wave_events (id, type, payload, timestamp, status)
      VALUES (@id, @type, @payload, @timestamp, @status)
    `);
    this.stmtGetWaveEvents = db.prepare(`SELECT * FROM wave_events ORDER BY timestamp ASC`);
    this.stmtGetWaveEventsByStatus = db.prepare(
      `SELECT * FROM wave_events WHERE status = ? ORDER BY timestamp ASC`,
    );
    this.stmtUpdateWaveEvent = db.prepare(`
      UPDATE wave_events
      SET status           = COALESCE(@status, status),
          applied_at       = COALESCE(@applied_at, applied_at),
          resolution       = COALESCE(@resolution, resolution),
          rejection_reason = COALESCE(@rejection_reason, rejection_reason)
      WHERE id = @id AND status = 'pending'
    `);
  }

  private prepareEventStmts(db: Database.Database): void {
    this.stmtAppendEvent = db.prepare(`
      INSERT INTO events (type, payload, correlation_id, timestamp)
      VALUES (@type, @payload, @correlation_id, @timestamp)
    `);
    this.stmtGetEventsByCorrelation = db.prepare(
      `SELECT * FROM events WHERE correlation_id = ? ORDER BY id ASC`,
    );
    this.stmtGetEventsByType = db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY id ASC`);
    this.stmtGetEventsAll = db.prepare(`SELECT * FROM events ORDER BY id ASC`);
  }

  private prepareIterationResultStmts(db: Database.Database): void {
    this.stmtRecordIterationResult = db.prepare(`
      INSERT OR REPLACE INTO iteration_results (state_id, iteration, status, data, timestamp)
      VALUES (@state_id, @iteration, @status, @data, @timestamp)
    `);
    this.stmtGetLastTwoIterationResults = db.prepare(`
      SELECT status, data FROM iteration_results
      WHERE state_id = ?
      ORDER BY iteration DESC
      LIMIT 2
    `);
  }

  private prepareMiscStmts(db: Database.Database): void {
    this.stmtUpdateStateMetrics = db.prepare(
      `UPDATE execution_states SET metrics = ? WHERE state_id = ?`,
    );
    this.stmtGetCachePrefix = db.prepare(`SELECT cache_prefix FROM execution WHERE id = 1`);
    this.stmtSetCachePrefix = db.prepare(`UPDATE execution SET cache_prefix = ? WHERE id = 1`);
    this.stmtSetTranscriptPath = db.prepare(
      `UPDATE execution_states SET transcript_path = ? WHERE state_id = ?`,
    );
    this.stmtGetTranscriptPath = db.prepare(
      `SELECT transcript_path FROM execution_states WHERE state_id = ?`,
    );
    this.stmtUpdateAgentSession = db.prepare(
      `UPDATE execution_states SET agent_session_id = ?, last_agent_activity = ? WHERE state_id = ?`,
    );
    this.stmtGetAgentSession = db.prepare(
      `SELECT agent_session_id, last_agent_activity FROM execution_states WHERE state_id = ?`,
    );
  }

  // Execution (board + session singleton)

  initExecution(params: InitExecutionParams): void {
    this.stmtInitExecution.run({
      base_commit: params.base_commit,
      blocked: null,
      branch: params.branch,
      completed_at: params.completed_at ?? null,
      concerns: "[]",
      correlation_id: randomUUID(),
      created: params.created,
      current_state: params.current_state,
      entry: params.entry,
      flow: params.flow,
      flow_name: params.flow_name,
      last_updated: params.last_updated,
      metadata: null,
      original_task: params.original_task ?? null,
      rolled_back_at: params.rolled_back_at ?? null,
      rolled_back_to: params.rolled_back_to ?? null,
      sanitized: params.sanitized,
      skipped: "[]",
      slug: params.slug,
      started: params.started,
      status: params.status ?? "active",
      task: params.task,
      tier: params.tier,
      worktree_branch: params.worktree_branch ?? null,
      worktree_path: params.worktree_path ?? null,
    });
  }

  getExecution():
    | (ExecutionRow & {
        blocked: Board["blocked"];
        concerns: Board["concerns"];
        skipped: string[];
        metadata: Board["metadata"];
      })
    | null {
    const row = this.stmtGetExecution.get() as ExecutionRow | undefined;
    if (!row) return null;
    return this.deserializeExecutionRow(row);
  }

  /**
   * Projects Session fields from the execution row.
   * Returns null when no execution exists.
   */
  getSession(): Session | null {
    const row = this.stmtGetExecution.get() as ExecutionRow | undefined;
    if (!row) return null;
    return {
      branch: row.branch,
      completed_at: row.completed_at ?? undefined,
      created: row.created,
      flow: row.flow_name,
      original_task: row.original_task ?? undefined,
      rolled_back_at: row.rolled_back_at ?? undefined,
      rolled_back_to: row.rolled_back_to ?? undefined,
      sanitized: row.sanitized,
      slug: row.slug,
      status: row.status as Session["status"],
      task: row.task,
      tier: row.tier as "small" | "medium" | "large",
      worktree_branch: row.worktree_branch ?? undefined,
      worktree_path: row.worktree_path ?? undefined,
    };
  }

  /**
   * Targeted UPDATE for execution-level fields.
   * Only the provided fields are changed.
   *
   * Security: column names are programmer-controlled (not user input), but we
   * validate each name against an explicit allowlist before embedding it in SQL
   * to prevent future misuse if callers evolve.
   */
  updateExecution(fields: UpdateExecutionFields): void {
    const parts: string[] = [];
    const params: Record<string, unknown> = {};

    const addColumn = (col: string, value: unknown): void => {
      if (!ALLOWED_UPDATE_EXECUTION_COLUMNS.has(col)) {
        throw new Error(`updateExecution: column '${col}' is not in the allowed list`);
      }
      parts.push(`${col} = @${col}`);
      params[col] = value;
    };

    this.collectJsonColumns(fields, addColumn);
    this.collectScalarColumns(fields, addColumn);

    // Always update last_updated
    const now = fields.last_updated ?? new Date().toISOString();
    addColumn("last_updated", now);

    if (parts.length === 0) return;

    const sql = `UPDATE execution SET ${parts.join(", ")} WHERE id = 1`;
    this.db.prepare(sql).run(params);
  }

  /** Map UpdateExecutionFields JSON-serialized columns. */
  private collectJsonColumns(
    fields: UpdateExecutionFields,
    addColumn: (col: string, value: unknown) => void,
  ): void {
    if ("blocked" in fields) {
      const val =
        fields.blocked !== null && fields.blocked !== undefined
          ? JSON.stringify(fields.blocked)
          : null;
      addColumn("blocked", val);
    }
    if (fields.concerns !== undefined) addColumn("concerns", JSON.stringify(fields.concerns));
    if (fields.skipped !== undefined) addColumn("skipped", JSON.stringify(fields.skipped));
    if (fields.metadata !== undefined) {
      addColumn("metadata", fields.metadata !== null ? JSON.stringify(fields.metadata) : null);
    }
  }

  /** Map UpdateExecutionFields scalar columns. */
  private collectScalarColumns(
    fields: UpdateExecutionFields,
    addColumn: (col: string, value: unknown) => void,
  ): void {
    if (fields.current_state !== undefined) addColumn("current_state", fields.current_state);
    if (fields.status !== undefined) addColumn("status", fields.status);
    if (fields.completed_at !== undefined) addColumn("completed_at", fields.completed_at);
    if (fields.rolled_back_at !== undefined) addColumn("rolled_back_at", fields.rolled_back_at);
    if (fields.rolled_back_to !== undefined) addColumn("rolled_back_to", fields.rolled_back_to);
    if ("worktree_path" in fields) addColumn("worktree_path", fields.worktree_path ?? null);
    if ("worktree_branch" in fields) addColumn("worktree_branch", fields.worktree_branch ?? null);
  }

  // Board reconstruction

  /**
   * Reconstructs the full Board object from execution + execution_states + iterations.
   * Returns null when no execution exists.
   */
  getBoard(): Board | null {
    const exRow = this.stmtGetExecution.get() as ExecutionRow | undefined;
    if (!exRow) return null;

    const stateRows = this.stmtGetAllStates.all() as ExecutionStateRow[];
    const iterRows = this.db.prepare("SELECT * FROM iterations").all() as IterationRow[];

    const states: Board["states"] = {};
    for (const row of stateRows) {
      states[row.state_id] = this.deserializeStateRow(row);
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

  // States

  upsertState(
    stateId: string,
    fields: Partial<BoardStateEntry> & { status: BoardStateEntry["status"]; entries: number },
  ): void {
    this.stmtUpsertState.run(this.buildUpsertStateParams(stateId, fields));
  }

  /** Serialize BoardStateEntry fields into the parameter object for stmtUpsertState. */
  private buildUpsertStateParams(
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

  getState(stateId: string): BoardStateEntry | null {
    const row = this.stmtGetState.get(stateId) as ExecutionStateRow | undefined;
    if (!row) return null;
    return this.deserializeStateRow(row);
  }

  getAllStates(): Array<BoardStateEntry & { state_id: string }> {
    const rows = this.stmtGetAllStates.all() as ExecutionStateRow[];
    return rows.map((row) => ({
      state_id: row.state_id,
      ...this.deserializeStateRow(row),
    }));
  }

  // Iterations

  upsertIteration(
    stateId: string,
    fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
  ): void {
    this.stmtUpsertIteration.run({
      cannot_fix: JSON.stringify(fields.cannot_fix ?? []),
      count: fields.count,
      history: JSON.stringify(fields.history),
      max: fields.max,
      state_id: stateId,
    });
  }

  getIteration(stateId: string): IterationEntry | null {
    const row = this.stmtGetIteration.get(stateId) as IterationRow | undefined;
    if (!row) return null;
    return {
      cannot_fix: JSON.parse(row.cannot_fix),
      count: row.count,
      history: JSON.parse(row.history),
      max: row.max,
    };
  }

  // Iteration results (SQL-based stuck detection — ADR-004)

  /**
   * Record a raw iteration result for a state.
   * `data` should contain the fields relevant to the state's `stuck_when` strategy.
   * Uses INSERT OR REPLACE — re-recording the same iteration number overwrites the previous entry.
   */
  recordIterationResult(
    stateId: string,
    iteration: number,
    status: string,
    data: Record<string, unknown>,
  ): void {
    this.stmtRecordIterationResult.run({
      data: JSON.stringify(data),
      iteration,
      state_id: stateId,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Determine whether a state is stuck by querying the last two iteration results.
   * Returns false when fewer than 2 iteration results exist.
   *
   * The comparison logic mirrors the pure `isStuck` in transitions.ts but reads from
   * the `iteration_results` table rather than caller-supplied history arrays.
   */
  isStuck(stateId: string, stuckWhen: StuckWhen): boolean {
    const rows = this.stmtGetLastTwoIterationResults.all(stateId) as Array<{
      status: string;
      data: string;
    }>;

    if (rows.length < 2) return false;

    // rows[0] is the latest (DESC order), rows[1] is the previous
    const curr = rows[0];
    const prev = rows[1];
    const currData = JSON.parse(curr.data) as Record<string, unknown>;
    const prevData = JSON.parse(prev.data) as Record<string, unknown>;

    switch (stuckWhen) {
      case "same_violations":
        return (
          setsEqual(
            (currData.principle_ids as string[]) ?? [],
            (prevData.principle_ids as string[]) ?? [],
          ) &&
          setsEqual(
            (currData.file_paths as string[]) ?? [],
            (prevData.file_paths as string[]) ?? [],
          )
        );
      case "same_file_test": {
        const currPairs = (currData.pairs ?? []) as unknown[];
        const prevPairs = (prevData.pairs ?? []) as unknown[];
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

  // Progress

  appendProgress(line: string): void {
    this.stmtAppendProgress.run({
      line,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Returns progress entries formatted as a markdown bullet list.
   * Returns empty string when no entries exist.
   * maxEntries: if provided, returns only the last N entries.
   */
  getProgress(maxEntries?: number): string {
    let rows: ProgressRow[];
    if (maxEntries !== undefined && maxEntries > 0) {
      rows = this.stmtGetProgressLimited.all(maxEntries) as ProgressRow[];
    } else {
      rows = this.stmtGetProgressAll.all() as ProgressRow[];
    }
    if (rows.length === 0) return "";
    return rows.map((r) => r.line).join("\n");
  }

  // Messages

  appendMessage(channel: string, sender: string, content: string): MessageOutput {
    const timestamp = new Date().toISOString();
    const row = this.stmtAppendMessage.get({ channel, content, sender, timestamp }) as MessageRow;
    return {
      channel: row.channel,
      content: row.content,
      id: row.id,
      sender: row.sender,
      timestamp: row.timestamp,
    };
  }

  getMessages(channel: string, options?: GetMessagesOptions): MessageOutput[] {
    let rows: MessageRow[];
    if (options?.since !== undefined) {
      rows = this.stmtGetMessagesSince.all(channel, options.since) as MessageRow[];
    } else {
      rows = this.stmtGetMessages.all(channel) as MessageRow[];
    }
    return rows.map((r) => ({
      channel: r.channel,
      content: r.content,
      id: r.id,
      sender: r.sender,
      timestamp: r.timestamp,
    }));
  }

  /** Returns true when at least one message exists in the channel, without loading all messages. */
  hasMessages(channel: string): boolean {
    return this.stmtHasMessages.get(channel) !== undefined;
  }

  // Wave events

  postWaveEvent(event: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string;
    status: string;
  }): void {
    this.stmtPostWaveEvent.run({
      id: event.id,
      payload: JSON.stringify(event.payload),
      status: event.status,
      timestamp: event.timestamp,
      type: event.type,
    });
  }

  getWaveEvents(options?: GetWaveEventsOptions): WaveEvent[] {
    let rows: WaveEventRow[];
    if (options?.status !== undefined) {
      rows = this.stmtGetWaveEventsByStatus.all(options.status) as WaveEventRow[];
    } else {
      rows = this.stmtGetWaveEvents.all() as WaveEventRow[];
    }
    return rows.map((r) => this.deserializeWaveEventRow(r));
  }

  updateWaveEvent(id: string, fields: UpdateWaveEventFields): void {
    const result = this.stmtUpdateWaveEvent.run({
      applied_at: fields.applied_at ?? null,
      id,
      rejection_reason: fields.rejection_reason ?? null,
      resolution: fields.resolution !== undefined ? JSON.stringify(fields.resolution) : null,
      status: fields.status ?? null,
    });
    if (result.changes === 0) {
      throw new Error(`Event ${id} is already not pending — CAS update rejected (no rows changed)`);
    }
  }

  // Event log

  appendEvent(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    const validation = validateEventPayload(type, payload);
    if (!validation.valid) {
      console.warn(
        `[canon] Event payload validation failed for type "${type}":`,
        validation.errors,
      );
    }
    this.stmtAppendEvent.run({
      correlation_id: correlationId ?? this.getCorrelationId(),
      payload: JSON.stringify(payload),
      timestamp: new Date().toISOString(),
      type,
    });
  }

  /**
   * Query events with optional filtering.
   * Returns empty array when no events match. SQLite errors may still be thrown.
   */
  getEvents(options?: GetEventsOptions): EventOutput[] {
    const { correlation_id, type, since, limit } = options ?? {};

    // Use prepared statements for the common single-filter cases to avoid
    // string interpolation. Fall back to dynamic SQL when multiple filters
    // or the `since` / `limit` modifiers are needed.
    const hasCorrelation = correlation_id !== undefined;
    const hasType = type !== undefined;
    const hasSince = since !== undefined;
    const hasLimit = limit !== undefined;

    let rows: Array<{
      id: number;
      type: string;
      payload: string;
      correlation_id: string | null;
      timestamp: string;
    }>;

    if (!hasCorrelation && !hasType && !hasSince && !hasLimit) {
      rows = this.stmtGetEventsAll.all() as typeof rows;
    } else if (hasCorrelation && !hasType && !hasSince && !hasLimit) {
      rows = this.stmtGetEventsByCorrelation.all(correlation_id) as typeof rows;
    } else if (hasType && !hasCorrelation && !hasSince && !hasLimit) {
      rows = this.stmtGetEventsByType.all(type) as typeof rows;
    } else {
      rows = this.buildEventQuery(options ?? {});
    }

    const events: EventOutput[] = [];
    for (const r of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(r.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      events.push({
        correlation_id: r.correlation_id,
        id: r.id,
        payload,
        timestamp: r.timestamp,
        type: r.type,
      });
    }
    return events;
  }

  /** Returns all events of the given type, ordered by id ASC. */
  getEventsByType(type: string): EventOutput[] {
    return this.getEvents({ type });
  }

  /** Returns the correlation_id from the execution row, or null if absent. */
  getCorrelationId(): string | null {
    const row = this.stmtGetExecution.get() as ExecutionRow | undefined;
    return row?.correlation_id ?? null;
  }

  /** Run a WAL passive checkpoint. Safe to call at any time. */
  walCheckpoint(): void {
    this.db.pragma("wal_checkpoint(PASSIVE)");
  }

  // Private helpers — event query builder

  private buildEventQuery(options: GetEventsOptions): Array<{
    id: number;
    type: string;
    payload: string;
    correlation_id: string | null;
    timestamp: string;
  }> {
    const { correlation_id, type, since, limit } = options;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (correlation_id !== undefined) {
      conditions.push("correlation_id = ?");
      params.push(correlation_id);
    }
    if (type !== undefined) {
      conditions.push("type = ?");
      params.push(type);
    }
    if (since !== undefined) {
      conditions.push("timestamp > ?");
      params.push(since);
    }

    let sql = "SELECT * FROM events";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY id ASC";
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    return this.db.prepare(sql).all(...params) as Array<{
      id: number;
      type: string;
      payload: string;
      correlation_id: string | null;
      timestamp: string;
    }>;
  }

  // Transaction

  /**
   * Wrap a function in a SQLite transaction.
   * Commits on success, rolls back on throw.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // Lifecycle

  close(): void {
    this.db.close();
  }

  // Private helpers — deserialization

  private deserializeExecutionRow(row: ExecutionRow) {
    return {
      ...row,
      blocked: row.blocked !== null ? JSON.parse(row.blocked) : null,
      concerns: JSON.parse(row.concerns),
      metadata: row.metadata !== null ? JSON.parse(row.metadata) : undefined,
      skipped: JSON.parse(row.skipped),
    };
  }

  private deserializeStateRow(row: ExecutionStateRow): BoardStateEntry {
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

  private deserializeWaveEventRow(row: WaveEventRow): WaveEvent {
    return {
      applied_at: row.applied_at ?? undefined,
      id: row.id,
      payload: JSON.parse(row.payload),
      rejection_reason: row.rejection_reason ?? undefined,
      resolution: row.resolution !== null ? JSON.parse(row.resolution) : undefined,
      status: row.status as WaveEvent["status"],
      timestamp: row.timestamp,
      type: row.type as WaveEvent["type"],
    };
  }

  // Targeted metrics update (ADR-003a agent performance metrics)

  /**
   * Merge the provided metrics fields into the existing metrics JSON for a state.
   * Only defined fields from `metrics` are merged — existing fields not present
   * in `metrics` are preserved (including orchestrator-written fields like
   * duration_ms, spawns, model).
   *
   * The row must exist (i.e. the state must have been upserted) before calling this.
   * Returns `true` when the row was found and updated, `false` when not found.
   */
  updateStateMetrics(stateId: string, metrics: Record<string, number | string>): boolean {
    const row = this.stmtGetState.get(stateId) as ExecutionStateRow | undefined;
    if (!row) return false;

    const existing: Record<string, unknown> = row.metrics ? JSON.parse(row.metrics) : {};
    const merged = { ...existing, ...metrics };

    this.stmtUpdateStateMetrics.run(JSON.stringify(merged), stateId);

    return true;
  }

  // Cache prefix (ADR-006a)

  /**
   * Returns the shared prompt cache prefix for this workspace.
   * Returns an empty string when no prefix has been stored yet or when the
   * execution row does not exist (e.g. unmigrated workspace or pre-init call).
   */
  getCachePrefix(): string {
    const row = this.stmtGetCachePrefix.get() as { cache_prefix: string } | undefined;
    return row?.cache_prefix ?? "";
  }

  /**
   * Stores the shared prompt cache prefix for this workspace.
   * The prefix content must be bit-for-bit stable across all agent spawns.
   * Called once during initWorkspaceFlow after board initialization.
   */
  setCachePrefix(prefix: string): void {
    this.stmtSetCachePrefix.run(prefix);
  }

  // Transcript path (ADR-015)

  /**
   * Store the transcript file path for a state.
   * Returns true when the row was found and updated, false when the state does not exist.
   * Errors-are-values: never throws for expected conditions.
   */
  setTranscriptPath(stateId: string, transcriptPath: string): boolean {
    const info = this.stmtSetTranscriptPath.run(transcriptPath, stateId);
    return info.changes > 0;
  }

  /**
   * Retrieve the transcript file path for a state.
   * Returns null when the state does not exist or no transcript has been set.
   * Errors-are-values: never throws for expected conditions.
   */
  getTranscriptPath(stateId: string): string | null {
    const row = this.stmtGetTranscriptPath.get(stateId) as
      | { transcript_path: string | null }
      | undefined;
    return row?.transcript_path ?? null;
  }

  // Agent session (ADR-009a)

  /**
   * Record the agent session ID and update the last activity timestamp.
   * Used to track session continuations for the fix-loop in drive_flow.
   * The sessionId is the agentId returned by Claude Code's Agent tool.
   */
  updateAgentSession(stateId: string, sessionId: string): void {
    this.stmtUpdateAgentSession.run(sessionId, new Date().toISOString(), stateId);
  }

  /**
   * Retrieve the agent session ID and last activity timestamp for a state.
   * Returns null when no session has been recorded for this state.
   * Callers use last_agent_activity to determine whether the session has expired
   * (idle > 600000ms = 10 minutes) before attempting SendMessage continuation.
   */
  getAgentSession(
    stateId: string,
  ): { agent_session_id: string; last_agent_activity: string } | null {
    const row = this.stmtGetAgentSession.get(stateId) as
      | {
          agent_session_id: string | null;
          last_agent_activity: string | null;
        }
      | undefined;
    if (!row || row.agent_session_id === null || row.last_agent_activity === null) {
      return null;
    }
    return {
      agent_session_id: row.agent_session_id,
      last_agent_activity: row.last_agent_activity,
    };
  }
}

// Private helpers — stuck detection

function setsEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

/** Order-insensitive comparison for arrays of objects (e.g. file+test pairs). */
function unorderedEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const serialize = (item: unknown) =>
    JSON.stringify(item, Object.keys(item as Record<string, unknown>).sort());
  const sortedA = a.map(serialize).sort();
  const sortedB = b.map(serialize).sort();
  return sortedA.every((val, i) => val === sortedB[i]);
}

// Factory — workspace-scoped cache

/** Cache keyed by absolute workspace path. */
const storeCache = new Map<string, ExecutionStore>();

/**
 * Returns a cached ExecutionStore for the given workspace directory.
 * Creates orchestration.db in the workspace on first call.
 */
/**
 * Guards that a workspace path follows the canonical `.canon/workspaces/` convention.
 * Throws when the path does not contain the expected segment, preventing accidental
 * misuse (e.g. passing a project root instead of a workspace subdirectory).
 *
 * Skipped when `CANON_SKIP_WORKSPACE_VALIDATION=true` or when running under Vitest
 * (`VITEST` env var set). Tests that operate on temp dirs typically do not include
 * the `.canon/workspaces/` segment in their paths.
 */
export function assertWorkspacePath(workspace: string): void {
  if (process.env.CANON_SKIP_WORKSPACE_VALIDATION !== "true" && !process.env.VITEST) {
    // Use the raw string for the segment check so Windows-style paths work
    // cross-platform (resolve() would rewrite them on macOS).
    const hasValidSegment =
      workspace.includes(".canon/workspaces/") || workspace.includes(".canon\\workspaces\\");
    if (!hasValidSegment) {
      throw new Error(
        `Invalid workspace path: "${workspace}". Expected a path containing ".canon/workspaces/".`,
      );
    }
  }
}

export function getExecutionStore(workspace: string): ExecutionStore {
  assertWorkspacePath(workspace);

  const key = resolve(workspace);
  const existing = storeCache.get(key);
  if (existing) return existing;

  if (!existsSync(key)) {
    throw new Error(`Workspace directory does not exist: ${key}`);
  }

  const dbPath = join(key, CANON_FILES.ORCHESTRATION_DB);
  const db = initExecutionDb(dbPath);
  const store = new ExecutionStore(db);
  storeCache.set(key, store);
  return store;
}

/**
 * Close and evict all cached ExecutionStore instances.
 * Call this in test afterEach/afterAll to release SQLite file handles
 * before deleting temp workspace directories.
 */
export function clearStoreCache(): void {
  for (const store of storeCache.values()) {
    try {
      store.close();
    } catch {
      /* ignore close errors */
    }
  }
  storeCache.clear();
}
