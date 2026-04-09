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
import type { WaveEvent } from "@domains/flows/event-schemas.ts";
import type { StuckWhen } from "@domains/flows/flow-definition-schemas.ts";
import type Database from "better-sqlite3";
import {
  buildUpsertStateParams,
  deserializeExecutionRow,
  deserializeStateRow,
  getBoard,
} from "./execution-store-board.ts";
import {
  appendEvent,
  appendMessage,
  type EventStmts,
  getEvents,
  getMessages,
  getMessagesSinceId,
  getWaveEvents,
  hasMessages,
  postWaveEvent,
  updateWaveEvent,
} from "./execution-store-messages.ts";
import { prepareAllStatements } from "./execution-store-statements.ts";
import type {
  EventOutput,
  ExecutionRow,
  ExecutionStateRow,
  GetEventsOptions,
  GetMessagesOptions,
  GetWaveEventsOptions,
  InitExecutionParams,
  IterationRow,
  MessageOutput,
  ProgressRow,
  UpdateExecutionFields,
  UpdateWaveEventFields,
} from "./execution-store-types.ts";
import {
  ALLOWED_UPDATE_EXECUTION_COLUMNS,
  setsEqual,
  unorderedEqual,
} from "./execution-store-types.ts";

// Re-export cache functions so existing importers of execution-store.ts continue to work
// biome-ignore lint/performance/noBarrelFile: execution-store.ts is the public API for this domain; re-exporting cache helpers preserves the 25+ importers' import paths
export {
  assertWorkspacePath,
  clearStoreCache,
  getExecutionStore,
} from "./execution-store-cache.ts";
// Re-export types so all existing importers continue to work unchanged
export type {
  EventOutput,
  GetEventsOptions,
  GetMessagesOptions,
  GetWaveEventsOptions,
  InitExecutionParams,
  MessageOutput,
  UpdateExecutionFields,
  UpdateWaveEventFields,
} from "./execution-store-types.ts";

// ExecutionStore

export class ExecutionStore {
  // Expose db for test introspection (tests access via `(store as any).db`)
  private readonly db: Database.Database;
  private readonly s: ReturnType<typeof prepareAllStatements>;

  constructor(db: Database.Database) {
    this.db = db;
    this.s = prepareAllStatements(db);
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

  /** Reconstructs the full Board object from SQL. Returns null when no execution exists. */
  getBoard(): Board | null {
    return getBoard(this.db, this.s.stmtGetExecution, this.s.stmtGetAllStates);
  }

  // States

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

  // Iterations

  upsertIteration(
    stateId: string,
    fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
  ): void {
    this.s.stmtUpsertIteration.run({
      cannot_fix: JSON.stringify(fields.cannot_fix ?? []),
      count: fields.count,
      history: JSON.stringify(fields.history),
      max: fields.max,
      state_id: stateId,
    });
  }

  getIteration(stateId: string): IterationEntry | null {
    const row = this.s.stmtGetIteration.get(stateId) as IterationRow | undefined;
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
   * Uses INSERT OR REPLACE — re-recording the same iteration number overwrites the previous entry.
   */
  recordIterationResult(
    stateId: string,
    iteration: number,
    status: string,
    data: Record<string, unknown>,
  ): void {
    this.s.stmtRecordIterationResult.run({
      data: JSON.stringify(data),
      iteration,
      state_id: stateId,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  private isSameViolations(
    currData: Record<string, unknown>,
    prevData: Record<string, unknown>,
  ): boolean {
    return (
      setsEqual(
        (currData.principle_ids as string[]) ?? [],
        (prevData.principle_ids as string[]) ?? [],
      ) &&
      setsEqual((currData.file_paths as string[]) ?? [], (prevData.file_paths as string[]) ?? [])
    );
  }

  isStuck(stateId: string, stuckWhen: StuckWhen): boolean {
    const rows = this.s.stmtGetLastTwoIterationResults.all(stateId) as Array<{
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
        return this.isSameViolations(currData, prevData);
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

  // Wave events — delegate to execution-store-messages.ts

  postWaveEvent(event: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string;
    status: string;
  }): void {
    postWaveEvent(this.s.stmtPostWaveEvent, event);
  }

  getWaveEvents(options?: GetWaveEventsOptions): WaveEvent[] {
    return getWaveEvents(this.s.stmtGetWaveEvents, this.s.stmtGetWaveEventsByStatus, options);
  }

  updateWaveEvent(id: string, fields: UpdateWaveEventFields): void {
    updateWaveEvent(this.s.stmtUpdateWaveEvent, id, fields);
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

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // Domain-language operations (compose infrastructure methods)

  /** Record a state being entered — sets status to in_progress and increments entries. */
  recordStateEntry(stateId: string, fields?: Partial<BoardStateEntry>): void {
    const current = this.getState(stateId);
    this.upsertState(stateId, {
      ...fields,
      entered_at: new Date().toISOString(),
      entries: (current?.entries ?? 0) + 1,
      status: "in_progress",
    });
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
    this.transaction(() => {
      const current = this.getState(stateId);
      this.upsertState(stateId, {
        ...current,
        ...(artifacts ? { artifacts } : {}),
        completed_at: new Date().toISOString(),
        entries: current?.entries ?? 1,
        result,
        status: "done",
      });
      if (iterationHistory !== undefined) {
        const iteration = this.getIteration(stateId);
        if (iteration !== null) {
          this.upsertIteration(stateId, { ...iteration, history: iterationHistory });
        }
      }
    });
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
    const { iteration, status, data, stuckWhen } = options;
    this.recordIterationResult(stateId, iteration, status, data);
    if (stuckWhen !== undefined) {
      return { recorded: true, stuck: this.isStuck(stateId, stuckWhen) };
    }
    return { recorded: true, stuck: false };
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

  // Orientation ratio (ADR-003a)

  /** Compute orientation_calls / tool_calls for a state. Returns 0 when data absent. */
  getOrientationRatio(stateId: string): number {
    const row = this.s.stmtGetState.get(stateId) as ExecutionStateRow | undefined;
    if (!row?.metrics) return 0;

    const metrics = JSON.parse(row.metrics) as Record<string, unknown>;
    const toolCalls = typeof metrics.tool_calls === "number" ? metrics.tool_calls : 0;
    const orientationCalls =
      typeof metrics.orientation_calls === "number" ? metrics.orientation_calls : 0;

    if (toolCalls === 0) return 0;
    return orientationCalls / toolCalls;
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
    const info = this.s.stmtSetTranscriptPath.run(transcriptPath, stateId);
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
