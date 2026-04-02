/**
 * ExecutionStore — SQLite DAO for workspace orchestration state.
 *
 * Wraps a better-sqlite3 Database with typed CRUD operations.
 * All statements are prepared once at construction time and reused.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Replaces: board.json, session.json, progress.md, messages, wave events, log.jsonl
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import type {
  Board,
  Session,
  BoardStateEntry,
  IterationEntry,
  WaveEvent,
  StuckWhen,
} from './flow-schema.ts';
import { initExecutionDb } from './execution-schema.ts';
import { validateEventPayload } from './events.ts';
import { CANON_FILES } from '../constants.ts';

// ---------------------------------------------------------------------------
// Row types (internal — not exported; callers receive typed objects)
// ---------------------------------------------------------------------------

interface ExecutionRow {
  id: number;
  flow: string;
  task: string;
  entry: string;
  current_state: string;
  base_commit: string;
  started: string;
  last_updated: string;
  blocked: string | null;       // JSON: BlockedInfo | null
  concerns: string;             // JSON array
  skipped: string;              // JSON array
  metadata: string | null;      // JSON object | null
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
}

interface ExecutionStateRow {
  state_id: string;
  status: string;
  entries: number;
  entered_at: string | null;
  completed_at: string | null;
  result: string | null;
  artifacts: string | null;             // JSON array | null
  artifact_history: string | null;      // JSON array | null
  error: string | null;
  wave: number | null;
  wave_total: number | null;
  wave_results: string | null;          // JSON object | null
  metrics: string | null;               // JSON object | null
  gate_results: string | null;          // JSON array | null
  postcondition_results: string | null; // JSON array | null
  discovered_gates: string | null;      // JSON array | null
  discovered_postconditions: string | null; // JSON array | null
  parallel_results: string | null;      // JSON array | null
  compete_results: string | null;       // JSON array | null
  synthesized: number | null;           // 0/1 | null
}

interface IterationRow {
  state_id: string;
  count: number;
  max: number;
  history: string;    // JSON array
  cannot_fix: string; // JSON array
}

interface ProgressRow {
  id: number;
  line: string;
  timestamp: string;
}

interface MessageRow {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
}

interface WaveEventRow {
  id: string;
  type: string;
  payload: string;      // JSON
  timestamp: string;
  status: string;
  applied_at: string | null;
  resolution: string | null;       // JSON | null
  rejection_reason: string | null;
}

// ---------------------------------------------------------------------------
// Parameter types for public API
// ---------------------------------------------------------------------------

export interface InitExecutionParams {
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
  tier: 'small' | 'medium' | 'large';
  flow_name: string;
  slug: string;
  status?: string;
  completed_at?: string;
  rolled_back_at?: string;
  rolled_back_to?: string;
}

export interface UpdateExecutionFields {
  current_state?: string;
  blocked?: Board['blocked'];
  concerns?: Board['concerns'];
  skipped?: string[];
  metadata?: Board['metadata'];
  last_updated?: string;
  status?: string;
  completed_at?: string;
  rolled_back_at?: string;
  rolled_back_to?: string;
}

export interface MessageOutput {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
}

export interface GetMessagesOptions {
  since?: string;
}

export interface GetWaveEventsOptions {
  status?: string;
}

export interface UpdateWaveEventFields {
  status?: string;
  applied_at?: string;
  resolution?: Record<string, unknown>;
  rejection_reason?: string;
}

export interface GetEventsOptions {
  correlation_id?: string;
  type?: string;
  since?: string;
  limit?: number;
}

export interface EventOutput {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helper — parse nullable JSON column
// ---------------------------------------------------------------------------

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value) as T;
}

function parseJsonOrDefault<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(value) as T;
}

// ---------------------------------------------------------------------------
// ExecutionStore
// ---------------------------------------------------------------------------

export class ExecutionStore {
  // Expose db for test introspection (tests access via `(store as any).db`)
  private readonly db: Database.Database;

  // ---- Execution statements ----
  private readonly stmtInitExecution: Database.Statement;
  private readonly stmtGetExecution: Database.Statement;
  private readonly stmtUpdateExecution: Database.Statement;

  // ---- State statements ----
  private readonly stmtUpsertState: Database.Statement;
  private readonly stmtGetState: Database.Statement;
  private readonly stmtGetAllStates: Database.Statement;

  // ---- Iteration statements ----
  private readonly stmtUpsertIteration: Database.Statement;
  private readonly stmtGetIteration: Database.Statement;

  // ---- Progress statements ----
  private readonly stmtAppendProgress: Database.Statement;
  private readonly stmtGetProgressAll: Database.Statement;
  private readonly stmtGetProgressLimited: Database.Statement;

  // ---- Message statements ----
  private readonly stmtAppendMessage: Database.Statement;
  private readonly stmtGetMessages: Database.Statement;
  private readonly stmtGetMessagesSince: Database.Statement;
  private readonly stmtHasMessages: Database.Statement;

  // ---- Wave event statements ----
  private readonly stmtPostWaveEvent: Database.Statement;
  private readonly stmtGetWaveEvents: Database.Statement;
  private readonly stmtGetWaveEventsByStatus: Database.Statement;
  private readonly stmtUpdateWaveEvent: Database.Statement;

  // ---- Event statements ----
  private readonly stmtAppendEvent: Database.Statement;
  private readonly stmtGetEventsByCorrelation: Database.Statement;
  private readonly stmtGetEventsByType: Database.Statement;
  private readonly stmtGetEventsAll: Database.Statement;

  // ---- Iteration results statements (SQL-based stuck detection) ----
  private readonly stmtRecordIterationResult: Database.Statement;
  private readonly stmtGetLastTwoIterationResults: Database.Statement;

  // ---- Metrics statements ----
  private readonly stmtUpdateStateMetrics: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Execution
    this.stmtInitExecution = db.prepare(`
      INSERT INTO execution (
        id, flow, task, entry, current_state, base_commit,
        started, last_updated, blocked, concerns, skipped, metadata,
        branch, sanitized, created, original_task,
        tier, flow_name, slug, status, completed_at,
        rolled_back_at, rolled_back_to, correlation_id
      ) VALUES (
        1, @flow, @task, @entry, @current_state, @base_commit,
        @started, @last_updated, @blocked, @concerns, @skipped, @metadata,
        @branch, @sanitized, @created, @original_task,
        @tier, @flow_name, @slug, @status, @completed_at,
        @rolled_back_at, @rolled_back_to, @correlation_id
      )
    `);

    this.stmtGetExecution = db.prepare(`
      SELECT * FROM execution WHERE id = 1
    `);

    // Dynamic update — we build SET clauses at runtime for the fields provided
    // This single-column statement is unused; updateExecution builds statements dynamically
    this.stmtUpdateExecution = db.prepare(`
      UPDATE execution SET last_updated = @last_updated WHERE id = 1
    `);

    // States
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
    `);

    this.stmtGetState = db.prepare(`
      SELECT * FROM execution_states WHERE state_id = ?
    `);

    this.stmtGetAllStates = db.prepare(`
      SELECT * FROM execution_states ORDER BY state_id
    `);

    // Iterations
    this.stmtUpsertIteration = db.prepare(`
      INSERT INTO iterations (state_id, count, max, history, cannot_fix)
      VALUES (@state_id, @count, @max, @history, @cannot_fix)
      ON CONFLICT(state_id) DO UPDATE SET
        count      = excluded.count,
        max        = excluded.max,
        history    = excluded.history,
        cannot_fix = excluded.cannot_fix
    `);

    this.stmtGetIteration = db.prepare(`
      SELECT * FROM iterations WHERE state_id = ?
    `);

    // Progress
    this.stmtAppendProgress = db.prepare(`
      INSERT INTO progress_entries (line, timestamp) VALUES (@line, @timestamp)
    `);

    this.stmtGetProgressAll = db.prepare(`
      SELECT * FROM progress_entries ORDER BY id ASC
    `);

    this.stmtGetProgressLimited = db.prepare(`
      SELECT * FROM (
        SELECT * FROM progress_entries ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `);

    // Messages
    this.stmtAppendMessage = db.prepare(`
      INSERT INTO messages (channel, sender, content, timestamp)
      VALUES (@channel, @sender, @content, @timestamp)
      RETURNING *
    `);

    this.stmtGetMessages = db.prepare(`
      SELECT * FROM messages WHERE channel = ? ORDER BY id ASC
    `);

    this.stmtGetMessagesSince = db.prepare(`
      SELECT * FROM messages WHERE channel = ? AND timestamp > ? ORDER BY id ASC
    `);

    this.stmtHasMessages = db.prepare(`
      SELECT 1 FROM messages WHERE channel = ? LIMIT 1
    `);

    // Wave events
    this.stmtPostWaveEvent = db.prepare(`
      INSERT INTO wave_events (id, type, payload, timestamp, status)
      VALUES (@id, @type, @payload, @timestamp, @status)
    `);

    this.stmtGetWaveEvents = db.prepare(`
      SELECT * FROM wave_events ORDER BY timestamp ASC
    `);

    this.stmtGetWaveEventsByStatus = db.prepare(`
      SELECT * FROM wave_events WHERE status = ? ORDER BY timestamp ASC
    `);

    this.stmtUpdateWaveEvent = db.prepare(`
      UPDATE wave_events
      SET status           = COALESCE(@status, status),
          applied_at       = COALESCE(@applied_at, applied_at),
          resolution       = COALESCE(@resolution, resolution),
          rejection_reason = COALESCE(@rejection_reason, rejection_reason)
      WHERE id = @id AND status = 'pending'
    `);

    // Events
    this.stmtAppendEvent = db.prepare(`
      INSERT INTO events (type, payload, correlation_id, timestamp)
      VALUES (@type, @payload, @correlation_id, @timestamp)
    `);

    this.stmtGetEventsByCorrelation = db.prepare(`
      SELECT * FROM events WHERE correlation_id = ? ORDER BY id ASC
    `);

    this.stmtGetEventsByType = db.prepare(`
      SELECT * FROM events WHERE type = ? ORDER BY id ASC
    `);

    this.stmtGetEventsAll = db.prepare(`
      SELECT * FROM events ORDER BY id ASC
    `);

    // Iteration results (SQL-based stuck detection)
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

    // Metrics
    this.stmtUpdateStateMetrics = db.prepare(
      `UPDATE execution_states SET metrics = ? WHERE state_id = ?`,
    );
  }

  // --------------------------------------------------------------------------
  // Execution (board + session singleton)
  // --------------------------------------------------------------------------

  initExecution(params: InitExecutionParams): void {
    this.stmtInitExecution.run({
      flow: params.flow,
      task: params.task,
      entry: params.entry,
      current_state: params.current_state,
      base_commit: params.base_commit,
      started: params.started,
      last_updated: params.last_updated,
      blocked: null,
      concerns: '[]',
      skipped: '[]',
      metadata: null,
      branch: params.branch,
      sanitized: params.sanitized,
      created: params.created,
      original_task: params.original_task ?? null,
      tier: params.tier,
      flow_name: params.flow_name,
      slug: params.slug,
      status: params.status ?? 'active',
      completed_at: params.completed_at ?? null,
      rolled_back_at: params.rolled_back_at ?? null,
      rolled_back_to: params.rolled_back_to ?? null,
      correlation_id: randomUUID(),
    });
  }

  getExecution(): (ExecutionRow & { blocked: Board['blocked']; concerns: Board['concerns']; skipped: string[]; metadata: Board['metadata'] }) | null {
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
      sanitized: row.sanitized,
      created: row.created,
      task: row.task,
      original_task: row.original_task ?? undefined,
      tier: row.tier as 'small' | 'medium' | 'large',
      flow: row.flow_name,
      slug: row.slug,
      status: row.status as Session['status'],
      completed_at: row.completed_at ?? undefined,
      rolled_back_at: row.rolled_back_at ?? undefined,
      rolled_back_to: row.rolled_back_to ?? undefined,
    };
  }

  /**
   * Targeted UPDATE for execution-level fields.
   * Only the provided fields are changed.
   */
  updateExecution(fields: UpdateExecutionFields): void {
    const parts: string[] = [];
    const params: Record<string, unknown> = {};

    if (fields.current_state !== undefined) {
      parts.push('current_state = @current_state');
      params['current_state'] = fields.current_state;
    }
    if ('blocked' in fields) {
      parts.push('blocked = @blocked');
      params['blocked'] = fields.blocked !== null && fields.blocked !== undefined
        ? JSON.stringify(fields.blocked)
        : null;
    }
    if (fields.concerns !== undefined) {
      parts.push('concerns = @concerns');
      params['concerns'] = JSON.stringify(fields.concerns);
    }
    if (fields.skipped !== undefined) {
      parts.push('skipped = @skipped');
      params['skipped'] = JSON.stringify(fields.skipped);
    }
    if (fields.metadata !== undefined) {
      parts.push('metadata = @metadata');
      params['metadata'] = fields.metadata !== null ? JSON.stringify(fields.metadata) : null;
    }
    if (fields.status !== undefined) {
      parts.push('status = @status');
      params['status'] = fields.status;
    }
    if (fields.completed_at !== undefined) {
      parts.push('completed_at = @completed_at');
      params['completed_at'] = fields.completed_at;
    }
    if (fields.rolled_back_at !== undefined) {
      parts.push('rolled_back_at = @rolled_back_at');
      params['rolled_back_at'] = fields.rolled_back_at;
    }
    if (fields.rolled_back_to !== undefined) {
      parts.push('rolled_back_to = @rolled_back_to');
      params['rolled_back_to'] = fields.rolled_back_to;
    }

    // Always update last_updated
    const now = fields.last_updated ?? new Date().toISOString();
    parts.push('last_updated = @last_updated');
    params['last_updated'] = now;

    if (parts.length === 0) return;

    const sql = `UPDATE execution SET ${parts.join(', ')} WHERE id = 1`;
    this.db.prepare(sql).run(params);
  }

  // --------------------------------------------------------------------------
  // Board reconstruction
  // --------------------------------------------------------------------------

  /**
   * Reconstructs the full Board object from execution + execution_states + iterations.
   * Returns null when no execution exists.
   */
  getBoard(): Board | null {
    const exRow = this.stmtGetExecution.get() as ExecutionRow | undefined;
    if (!exRow) return null;

    const stateRows = this.stmtGetAllStates.all() as ExecutionStateRow[];
    const iterRows = this.db.prepare('SELECT * FROM iterations').all() as IterationRow[];

    const states: Board['states'] = {};
    for (const row of stateRows) {
      states[row.state_id] = this.deserializeStateRow(row);
    }

    const iterations: Board['iterations'] = {};
    for (const row of iterRows) {
      iterations[row.state_id] = {
        count: row.count,
        max: row.max,
        history: JSON.parse(row.history),
        cannot_fix: JSON.parse(row.cannot_fix),
      };
    }

    return {
      flow: exRow.flow,
      task: exRow.task,
      entry: exRow.entry,
      current_state: exRow.current_state,
      base_commit: exRow.base_commit,
      started: exRow.started,
      last_updated: exRow.last_updated,
      states,
      iterations,
      blocked: exRow.blocked !== null ? JSON.parse(exRow.blocked) : null,
      concerns: JSON.parse(exRow.concerns),
      skipped: JSON.parse(exRow.skipped),
      metadata: exRow.metadata !== null ? JSON.parse(exRow.metadata) : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // States
  // --------------------------------------------------------------------------

  upsertState(stateId: string, fields: Partial<BoardStateEntry> & { status: BoardStateEntry['status']; entries: number }): void {
    this.stmtUpsertState.run({
      state_id: stateId,
      status: fields.status,
      entries: fields.entries,
      entered_at: fields.entered_at ?? null,
      completed_at: fields.completed_at ?? null,
      result: fields.result ?? null,
      artifacts: fields.artifacts !== undefined ? JSON.stringify(fields.artifacts) : null,
      artifact_history: fields.artifact_history !== undefined ? JSON.stringify(fields.artifact_history) : null,
      error: fields.error ?? null,
      wave: fields.wave ?? null,
      wave_total: fields.wave_total ?? null,
      wave_results: fields.wave_results !== undefined ? JSON.stringify(fields.wave_results) : null,
      metrics: fields.metrics !== undefined ? JSON.stringify(fields.metrics) : null,
      gate_results: fields.gate_results !== undefined ? JSON.stringify(fields.gate_results) : null,
      postcondition_results: fields.postcondition_results !== undefined ? JSON.stringify(fields.postcondition_results) : null,
      discovered_gates: fields.discovered_gates !== undefined ? JSON.stringify(fields.discovered_gates) : null,
      discovered_postconditions: fields.discovered_postconditions !== undefined ? JSON.stringify(fields.discovered_postconditions) : null,
      parallel_results: fields.parallel_results !== undefined ? JSON.stringify(fields.parallel_results) : null,
      compete_results: fields.compete_results !== undefined ? JSON.stringify(fields.compete_results) : null,
      synthesized: fields.synthesized !== undefined ? (fields.synthesized ? 1 : 0) : null,
    });
  }

  getState(stateId: string): BoardStateEntry | null {
    const row = this.stmtGetState.get(stateId) as ExecutionStateRow | undefined;
    if (!row) return null;
    return this.deserializeStateRow(row);
  }

  getAllStates(): Array<BoardStateEntry & { state_id: string }> {
    const rows = this.stmtGetAllStates.all() as ExecutionStateRow[];
    return rows.map(row => ({
      state_id: row.state_id,
      ...this.deserializeStateRow(row),
    }));
  }

  // --------------------------------------------------------------------------
  // Iterations
  // --------------------------------------------------------------------------

  upsertIteration(stateId: string, fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] }): void {
    this.stmtUpsertIteration.run({
      state_id: stateId,
      count: fields.count,
      max: fields.max,
      history: JSON.stringify(fields.history),
      cannot_fix: JSON.stringify(fields.cannot_fix ?? []),
    });
  }

  getIteration(stateId: string): IterationEntry | null {
    const row = this.stmtGetIteration.get(stateId) as IterationRow | undefined;
    if (!row) return null;
    return {
      count: row.count,
      max: row.max,
      history: JSON.parse(row.history),
      cannot_fix: JSON.parse(row.cannot_fix),
    };
  }

  // --------------------------------------------------------------------------
  // Iteration results (SQL-based stuck detection — ADR-004)
  // --------------------------------------------------------------------------

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
      state_id: stateId,
      iteration,
      status,
      data: JSON.stringify(data),
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
    const rows = this.stmtGetLastTwoIterationResults.all(stateId) as Array<{ status: string; data: string }>;

    if (rows.length < 2) return false;

    // rows[0] is the latest (DESC order), rows[1] is the previous
    const curr = rows[0];
    const prev = rows[1];
    const currData = JSON.parse(curr.data) as Record<string, unknown>;
    const prevData = JSON.parse(prev.data) as Record<string, unknown>;

    switch (stuckWhen) {
      case 'same_violations':
        return (
          setsEqual(currData.principle_ids as string[] ?? [], prevData.principle_ids as string[] ?? []) &&
          setsEqual(currData.file_paths as string[] ?? [], prevData.file_paths as string[] ?? [])
        );
      case 'same_file_test': {
        const currPairs = (currData.pairs ?? []) as unknown[];
        const prevPairs = (prevData.pairs ?? []) as unknown[];
        return unorderedEqual(currPairs, prevPairs);
      }
      case 'same_status':
        return curr.status === prev.status;
      case 'no_progress':
        return (
          currData.commit_sha === prevData.commit_sha &&
          currData.artifact_count === prevData.artifact_count
        );
      case 'no_gate_progress':
        return (
          currData.gate_output_hash === prevData.gate_output_hash &&
          !currData.passed
        );
      default:
        return false;
    }
  }

  // --------------------------------------------------------------------------
  // Progress
  // --------------------------------------------------------------------------

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
    if (rows.length === 0) return '';
    return rows.map(r => r.line).join('\n');
  }

  // --------------------------------------------------------------------------
  // Messages
  // --------------------------------------------------------------------------

  appendMessage(channel: string, sender: string, content: string): MessageOutput {
    const timestamp = new Date().toISOString();
    const row = this.stmtAppendMessage.get({ channel, sender, content, timestamp }) as MessageRow;
    return {
      id: row.id,
      channel: row.channel,
      sender: row.sender,
      content: row.content,
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
    return rows.map(r => ({
      id: r.id,
      channel: r.channel,
      sender: r.sender,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  /** Returns true when at least one message exists in the channel, without loading all messages. */
  hasMessages(channel: string): boolean {
    return this.stmtHasMessages.get(channel) !== undefined;
  }

  // --------------------------------------------------------------------------
  // Wave events
  // --------------------------------------------------------------------------

  postWaveEvent(event: { id: string; type: string; payload: Record<string, unknown>; timestamp: string; status: string }): void {
    this.stmtPostWaveEvent.run({
      id: event.id,
      type: event.type,
      payload: JSON.stringify(event.payload),
      timestamp: event.timestamp,
      status: event.status,
    });
  }

  getWaveEvents(options?: GetWaveEventsOptions): WaveEvent[] {
    let rows: WaveEventRow[];
    if (options?.status !== undefined) {
      rows = this.stmtGetWaveEventsByStatus.all(options.status) as WaveEventRow[];
    } else {
      rows = this.stmtGetWaveEvents.all() as WaveEventRow[];
    }
    return rows.map(r => this.deserializeWaveEventRow(r));
  }

  updateWaveEvent(id: string, fields: UpdateWaveEventFields): void {
    const result = this.stmtUpdateWaveEvent.run({
      id,
      status: fields.status ?? null,
      applied_at: fields.applied_at ?? null,
      resolution: fields.resolution !== undefined ? JSON.stringify(fields.resolution) : null,
      rejection_reason: fields.rejection_reason ?? null,
    });
    if (result.changes === 0) {
      throw new Error(`Event ${id} is already not pending — CAS update rejected (no rows changed)`);
    }
  }

  // --------------------------------------------------------------------------
  // Event log
  // --------------------------------------------------------------------------

  appendEvent(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    const validation = validateEventPayload(type, payload);
    if (!validation.valid) {
      console.warn(`[canon] Event payload validation failed for type "${type}":`, validation.errors);
    }
    this.stmtAppendEvent.run({
      type,
      payload: JSON.stringify(payload),
      correlation_id: correlationId ?? this.getCorrelationId(),
      timestamp: new Date().toISOString(),
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

    let rows: Array<{ id: number; type: string; payload: string; correlation_id: string | null; timestamp: string }>;

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
        id: r.id,
        type: r.type,
        payload,
        correlation_id: r.correlation_id,
        timestamp: r.timestamp,
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
    this.db.pragma('wal_checkpoint(PASSIVE)');
  }

  // --------------------------------------------------------------------------
  // Private helpers — event query builder
  // --------------------------------------------------------------------------

  private buildEventQuery(
    options: GetEventsOptions,
  ): Array<{ id: number; type: string; payload: string; correlation_id: string | null; timestamp: string }> {
    const { correlation_id, type, since, limit } = options;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (correlation_id !== undefined) {
      conditions.push('correlation_id = ?');
      params.push(correlation_id);
    }
    if (type !== undefined) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (since !== undefined) {
      conditions.push('timestamp > ?');
      params.push(since);
    }

    let sql = 'SELECT * FROM events';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY id ASC';
    if (limit !== undefined) {
      sql += ' LIMIT ?';
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

  // --------------------------------------------------------------------------
  // Transaction
  // --------------------------------------------------------------------------

  /**
   * Wrap a function in a SQLite transaction.
   * Commits on success, rolls back on throw.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }

  // --------------------------------------------------------------------------
  // Private helpers — deserialization
  // --------------------------------------------------------------------------

  private deserializeExecutionRow(row: ExecutionRow) {
    return {
      ...row,
      blocked: row.blocked !== null ? JSON.parse(row.blocked) : null,
      concerns: JSON.parse(row.concerns),
      skipped: JSON.parse(row.skipped),
      metadata: row.metadata !== null ? JSON.parse(row.metadata) : undefined,
    };
  }

  private deserializeStateRow(row: ExecutionStateRow): BoardStateEntry {
    return {
      status: row.status as BoardStateEntry['status'],
      entries: row.entries,
      entered_at: row.entered_at ?? undefined,
      completed_at: row.completed_at ?? undefined,
      result: row.result ?? undefined,
      artifacts: parseJson<string[]>(row.artifacts),
      artifact_history: parseJson(row.artifact_history),
      error: row.error ?? undefined,
      wave: row.wave ?? undefined,
      wave_total: row.wave_total ?? undefined,
      wave_results: parseJson(row.wave_results),
      metrics: parseJson(row.metrics),
      gate_results: parseJson(row.gate_results),
      postcondition_results: parseJson(row.postcondition_results),
      discovered_gates: parseJson(row.discovered_gates),
      discovered_postconditions: parseJson(row.discovered_postconditions),
      parallel_results: parseJson(row.parallel_results),
      compete_results: parseJson(row.compete_results),
      synthesized: row.synthesized !== null ? Boolean(row.synthesized) : undefined,
    };
  }

  private deserializeWaveEventRow(row: WaveEventRow): WaveEvent {
    return {
      id: row.id,
      type: row.type as WaveEvent['type'],
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp,
      status: row.status as WaveEvent['status'],
      applied_at: row.applied_at ?? undefined,
      resolution: row.resolution !== null ? JSON.parse(row.resolution) : undefined,
      rejection_reason: row.rejection_reason ?? undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Targeted metrics update (ADR-003a agent performance metrics)
  // --------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Private helpers — stuck detection
// ---------------------------------------------------------------------------

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
  const serialize = (item: unknown) => JSON.stringify(item, Object.keys(item as Record<string, unknown>).sort());
  const sortedA = a.map(serialize).sort();
  const sortedB = b.map(serialize).sort();
  return sortedA.every((val, i) => val === sortedB[i]);
}

// ---------------------------------------------------------------------------
// Factory — workspace-scoped cache
// ---------------------------------------------------------------------------

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
  if (
    process.env.CANON_SKIP_WORKSPACE_VALIDATION !== 'true' &&
    !process.env.VITEST
  ) {
    // Use the raw string for the segment check so Windows-style paths work
    // cross-platform (resolve() would rewrite them on macOS).
    const hasValidSegment =
      workspace.includes('.canon/workspaces/') ||
      workspace.includes('.canon\\workspaces\\');
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
    try { store.close(); } catch { /* ignore close errors */ }
  }
  storeCache.clear();
}
