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
import type {
  Board,
  BoardStateEntry,
  HistoryEntry,
  IterationEntry,
  Session,
} from "@domains/flows/board-state-schemas.ts";
import type { StuckWhen } from "@domains/flows/flow-definition-schemas.ts";
import type Database from "better-sqlite3";
import {
  buildUpsertStateParams,
  deserializeExecutionRow,
  deserializeStateRow,
  getBoard,
} from "./execution-store-board.ts";
import {
  getIteration,
  getOrientationRatio,
  isStuck,
  recordIterationAttempt,
  recordIterationResult,
  recordStateCompletion,
  recordStateEntry,
  upsertIteration,
} from "./execution-store-iterations.ts";
import {
  getFlowLineage as _getFlowLineage,
  getLatestFlowForBranch as _getLatestFlowForBranch,
  recordFlowLineage as _recordFlowLineage,
  type FlowLineageEntry,
  type LineageStatements,
  prepareLineageStatements,
} from "./execution-store-lineage.ts";
import {
  appendEvent,
  appendMessage,
  type EventStmts,
  getEvents,
  getMessages,
  getMessagesSinceId,
  hasMessages,
} from "./execution-store-messages.ts";
import { prepareAllStatements } from "./execution-store-statements.ts";
import type {
  EventOutput,
  ExecutionRow,
  ExecutionStateRow,
  GetEventsOptions,
  GetMessagesOptions,
  InitExecutionParams,
  MessageOutput,
  ProgressRow,
  UpdateExecutionFields,
} from "./execution-store-types.ts";
import {
  updateExecution as _updateExecution,
  updateExecutionVersioned as _updateExecutionVersioned,
  type VersionedUpdateResult,
} from "./execution-store-updater.ts";

// ExecutionStore

export class ExecutionStore {
  // Expose db for test introspection (tests access via `(store as any).db`)
  private readonly db: Database.Database;
  private readonly s: ReturnType<typeof prepareAllStatements>;
  private readonly lineage: LineageStatements;

  constructor(db: Database.Database) {
    this.db = db;
    this.s = prepareAllStatements(db);
    this.lineage = prepareLineageStatements(db);
  }

  // Execution (board + session singleton)

  initExecution(params: InitExecutionParams): void {
    this.s.stmtInitExecution.run({
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
    const row = this.s.stmtGetExecution.get() as ExecutionRow | undefined;
    if (!row) return null;
    return deserializeExecutionRow(row);
  }

  /** Projects Session fields from the execution row. Returns null when no execution exists. */
  getSession(): Session | null {
    const row = this.s.stmtGetExecution.get() as ExecutionRow | undefined;
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
   *
   * @internal — tool handlers should call updateExecutionVersioned instead.
   */
  updateExecution(fields: UpdateExecutionFields): void {
    _updateExecution(this.db, fields);
  }

  // Board reconstruction

  /** Reconstructs the full Board object from SQL. Returns null when no execution exists. */
  getBoard(): Board | null {
    return getBoard(this.db, this.s.stmtGetExecution, this.s.stmtGetAllStates);
  }

  // States

  /** @internal */
  upsertState(
    stateId: string,
    fields: Partial<BoardStateEntry> & { status: BoardStateEntry["status"]; entries: number },
  ): void {
    this.s.stmtUpsertState.run(buildUpsertStateParams(stateId, fields));
  }

  getState(stateId: string): BoardStateEntry | null {
    const row = this.s.stmtGetState.get(stateId) as ExecutionStateRow | undefined;
    if (!row) return null;
    return deserializeStateRow(row);
  }

  getAllStates(): Array<BoardStateEntry & { state_id: string }> {
    const rows = this.s.stmtGetAllStates.all() as ExecutionStateRow[];
    return rows.map((row) => ({
      state_id: row.state_id,
      ...deserializeStateRow(row),
    }));
  }

  // Iterations — delegate to execution-store-iterations.ts

  /** @internal */
  upsertIteration(
    stateId: string,
    fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
  ): void {
    upsertIteration(this.s.stmtUpsertIteration, stateId, fields);
  }

  getIteration(stateId: string): IterationEntry | null {
    return getIteration(this.s.stmtGetIteration, stateId);
  }

  recordIterationResult(
    stateId: string,
    iteration: number,
    status: string,
    data: Record<string, unknown>,
  ): void {
    recordIterationResult(this.s.stmtRecordIterationResult, { data, iteration, stateId, status });
  }

  isStuck(stateId: string, stuckWhen: StuckWhen): boolean {
    return isStuck(this.s.stmtGetLastTwoIterationResults, stateId, stuckWhen);
  }

  // Progress

  appendProgress(line: string): void {
    this.s.stmtAppendProgress.run({ line, timestamp: new Date().toISOString() });
  }

  /**
   * Returns progress entries as newline-separated lines.
   * Returns empty string when no entries exist.
   * maxEntries: if provided, returns only the last N entries.
   */
  getProgress(maxEntries?: number): string {
    let rows: ProgressRow[];
    if (maxEntries !== undefined && maxEntries > 0) {
      rows = this.s.stmtGetProgressLimited.all(maxEntries) as ProgressRow[];
    } else {
      rows = this.s.stmtGetProgressAll.all() as ProgressRow[];
    }
    if (rows.length === 0) return "";
    return rows.map((r) => r.line).join("\n");
  }

  // Messages — delegate to execution-store-messages.ts

  appendMessage(channel: string, sender: string, content: string): MessageOutput {
    return appendMessage(this.s.stmtAppendMessage, channel, sender, content);
  }

  getMessages(channel: string, options?: GetMessagesOptions): MessageOutput[] {
    return getMessages(this.s.stmtGetMessages, this.s.stmtGetMessagesSince, channel, options);
  }

  getMessagesSinceId(channel: string, sinceId: number): MessageOutput[] {
    return getMessagesSinceId(this.s.stmtGetMessagesSinceId, channel, sinceId);
  }

  hasMessages(channel: string): boolean {
    return hasMessages(this.s.stmtHasMessages, channel);
  }

  // Event log — delegate to execution-store-messages.ts

  appendEvent(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    appendEvent({
      correlationId,
      getCorrelationIdFn: () => this.getCorrelationId(),
      payload,
      stmtAppendEvent: this.s.stmtAppendEvent,
      type,
    });
  }

  getEvents(options?: GetEventsOptions): EventOutput[] {
    const eventStmts: EventStmts = {
      db: this.db,
      stmtGetEventsAll: this.s.stmtGetEventsAll,
      stmtGetEventsByCorrelation: this.s.stmtGetEventsByCorrelation,
      stmtGetEventsByType: this.s.stmtGetEventsByType,
    };
    return getEvents(eventStmts, options);
  }

  getEventsByType(type: string): EventOutput[] {
    return this.getEvents({ type });
  }

  getCorrelationId(): string | null {
    const row = this.s.stmtGetExecution.get() as ExecutionRow | undefined;
    return row?.correlation_id ?? null;
  }

  walCheckpoint(): void {
    this.db.pragma("wal_checkpoint(PASSIVE)");
  }

  // Transaction

  /**
   * Retry wrapper for SQLITE_BUSY errors.
   * Retries up to maxAttempts times with Atomics.wait backoff (100ms, 200ms, 400ms, ...).
   * Does NOT retry other error codes — only SQLITE_BUSY.
   *
   * @internal
   */
  withRetry<T>(fn: () => T, maxAttempts = 3): T {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return fn();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "SQLITE_BUSY") throw err;
        lastError = err;
        if (attempt < maxAttempts - 1) {
          // Atomics.wait backoff: 100ms × 2^attempt
          const backoffMs = 100 * 2 ** attempt;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
        }
      }
    }
    throw lastError;
  }

  /**
   * Wrap a function in a SQLite transaction and execute it.
   * Uses withRetry internally for transparent SQLITE_BUSY retry.
   */
  transaction<T>(fn: () => T): T {
    return this.withRetry(() => this.db.transaction(fn)());
  }

  /**
   * Optimistic-locking UPDATE for execution-level fields.
   * Increments the version column atomically; returns a discriminated union.
   *
   * errors-are-values: never throws for version conflicts.
   *
   * @internal — prefer this over updateExecution in handler code.
   */
  updateExecutionVersioned(
    fields: UpdateExecutionFields,
    expectedVersion: number,
  ): VersionedUpdateResult {
    return _updateExecutionVersioned(this.db, this.s.stmtGetExecution, fields, expectedVersion);
  }

  /** Read current execution version for optimistic locking. */
  getVersion(): number {
    const row = this.s.stmtGetExecution.get() as ExecutionRow | undefined;
    return row?.version ?? 1;
  }

  // Domain-language operations — delegate to execution-store-iterations.ts

  /** Record a state being entered — sets status to in_progress and increments entries. */
  recordStateEntry(stateId: string, fields?: Partial<BoardStateEntry>): void {
    recordStateEntry(
      {
        getStateFn: (sid) => this.getState(sid),
        upsertStateFn: (sid, f) =>
          this.upsertState(sid, f as Parameters<typeof this.upsertState>[1]),
      },
      stateId,
      fields as Record<string, unknown> | undefined,
    );
  }

  /**
   * Record a state completing — sets status to done, persists result and artifacts.
   * Wrapped in a transaction so state update and iteration update are atomic.
   */
  recordStateCompletion(
    stateId: string,
    result: string,
    artifacts?: string[],
    iterationHistory?: HistoryEntry[],
  ): void {
    recordStateCompletion(
      {
        getIterationFn: (sid) => this.getIteration(sid),
        getStateFn: (sid) => this.getState(sid) as Record<string, unknown> | null,
        transactionFn: (fn) => this.transaction(fn),
        upsertIterationFn: (sid, f) => this.upsertIteration(sid, f),
        upsertStateFn: (sid, f) =>
          this.upsertState(sid, f as Parameters<typeof this.upsertState>[1]),
      },
      { artifacts, iterationHistory, result, stateId },
    );
  }

  /** Record one iteration attempt; check stuck if stuckWhen provided. */
  recordIterationAttempt(
    stateId: string,
    options: {
      iteration: number;
      status: string;
      data: Record<string, unknown>;
      stuckWhen?: StuckWhen;
    },
  ): { recorded: true; stuck: boolean } {
    return recordIterationAttempt(
      {
        isStuckFn: (sid, sw) => this.isStuck(sid, sw),
        recordIterationResultFn: (sid, iter, stat, data) =>
          this.recordIterationResult(sid, iter, stat, data),
      },
      stateId,
      options,
    );
  }

  // Flow lineage (cfcp-03)

  recordFlowLineage(entry: FlowLineageEntry): void {
    _recordFlowLineage(this.lineage, entry);
  }

  getFlowLineage(branch: string): FlowLineageEntry[] {
    return _getFlowLineage(this.lineage, branch);
  }

  getLatestFlowForBranch(branch: string): FlowLineageEntry | null {
    return _getLatestFlowForBranch(this.lineage, branch);
  }

  // Lifecycle

  close(): void {
    this.db.close();
  }

  // Targeted metrics update (ADR-003a)

  /**
   * Merge provided metrics fields into existing metrics JSON for a state.
   * Preserves orchestrator-written fields (duration_ms, spawns, model).
   * Returns true when updated, false when state not found.
   */
  updateStateMetrics(stateId: string, metrics: Record<string, number | string>): boolean {
    const row = this.s.stmtGetState.get(stateId) as ExecutionStateRow | undefined;
    if (!row) return false;

    const existing: Record<string, unknown> = row.metrics ? JSON.parse(row.metrics) : {};
    const merged = { ...existing, ...metrics };

    this.s.stmtUpdateStateMetrics.run(JSON.stringify(merged), stateId);
    return true;
  }

  // Orientation ratio — delegate to execution-store-iterations.ts

  /** Compute orientation_calls / tool_calls for a state. Returns 0 when data absent. */
  getOrientationRatio(stateId: string): number {
    return getOrientationRatio(this.s.stmtGetState, stateId);
  }

  // Cache prefix (ADR-006a)

  getCachePrefix(): string {
    const row = this.s.stmtGetCachePrefix.get() as { cache_prefix: string } | undefined;
    return row?.cache_prefix ?? "";
  }

  setCachePrefix(prefix: string): void {
    this.s.stmtSetCachePrefix.run(prefix);
  }

  // Transcript path (ADR-015)

  setTranscriptPath(stateId: string, transcriptPath: string): boolean {
    const info = this.s.stmtSetTranscriptPath.run(stateId, transcriptPath);
    return info.changes > 0;
  }

  getTranscriptPath(stateId: string): string | null {
    const row = this.s.stmtGetTranscriptPath.get(stateId) as
      | { transcript_path: string | null }
      | undefined;
    return row?.transcript_path ?? null;
  }

  // Agent session (ADR-009a)

  updateAgentSession(stateId: string, sessionId: string): void {
    this.s.stmtUpdateAgentSession.run(sessionId, new Date().toISOString(), stateId);
  }

  getAgentSession(
    stateId: string,
  ): { agent_session_id: string; last_agent_activity: string } | null {
    const row = this.s.stmtGetAgentSession.get(stateId) as
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

// Factory and cache helpers live in execution-store-cache.ts and are re-exported at the top.
