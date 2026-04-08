/**
 * IExecutionStore — capability interface for workspace orchestration state.
 *
 * Defines the public contract of ExecutionStore without exposing the concrete
 * SQLite DAO implementation. Cross-context callers depend on this interface,
 * not on the concrete class.
 */

import type {
  Board,
  BoardStateEntry,
  HistoryEntry,
  IterationEntry,
  Session,
} from "@domains/flows/board-state-schemas.ts";
import type { WaveEvent } from "@domains/flows/event-schemas.ts";
import type { StuckWhen } from "@domains/flows/flow-definition-schemas.ts";
import type {
  EventOutput,
  GetEventsOptions,
  GetMessagesOptions,
  GetWaveEventsOptions,
  InitExecutionParams,
  MessageOutput,
  UpdateExecutionFields,
  UpdateWaveEventFields,
} from "./execution-store.ts";

export type IExecutionStore = {
  // Event log
  appendEvent(type: string, payload: Record<string, unknown>, correlationId?: string): void;

  // Messages
  appendMessage(channel: string, sender: string, content: string): MessageOutput;

  // Progress
  appendProgress(line: string): void;
  close(): void;
  getAgentSession(
    stateId: string,
  ): { agent_session_id: string; last_agent_activity: string } | null;
  getAllStates(): Array<BoardStateEntry & { state_id: string }>;

  // Board reconstruction
  getBoard(): Board | null;

  // Cache prefix
  getCachePrefix(): string;
  getCorrelationId(): string | null;
  getEvents(options?: GetEventsOptions): EventOutput[];
  getEventsByType(type: string): EventOutput[];
  getExecution():
    | (Record<string, unknown> & {
        blocked: Board["blocked"];
        concerns: Board["concerns"];
        skipped: string[];
        metadata: Board["metadata"];
      })
    | null;
  getIteration(stateId: string): IterationEntry | null;
  getMessages(channel: string, options?: GetMessagesOptions): MessageOutput[];
  getMessagesSinceId(channel: string, sinceId: number): MessageOutput[];
  getProgress(maxEntries?: number): string;
  getSession(): Session | null;
  getState(stateId: string): BoardStateEntry | null;
  getTranscriptPath(stateId: string): string | null;
  getWaveEvents(options?: GetWaveEventsOptions): WaveEvent[];
  hasMessages(channel: string): boolean;
  // Execution (board + session singleton)
  initExecution(params: InitExecutionParams): void;
  isStuck(stateId: string, stuckWhen: StuckWhen): boolean;

  // Wave events
  postWaveEvent(event: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string;
    status: string;
  }): void;

  // Iteration results (SQL-based stuck detection)
  recordIterationResult(
    stateId: string,
    iteration: number,
    status: string,
    data: Record<string, unknown>,
  ): void;
  setCachePrefix(prefix: string): void;

  // Transcript path
  setTranscriptPath(stateId: string, transcriptPath: string): boolean;
  transaction<T>(fn: () => T): T;

  // Agent session
  updateAgentSession(stateId: string, sessionId: string): void;
  updateExecution(fields: UpdateExecutionFields): void;

  // Metrics
  updateStateMetrics(stateId: string, metrics: Record<string, number | string>): boolean;
  updateWaveEvent(id: string, fields: UpdateWaveEventFields): void;

  // Iterations
  upsertIteration(
    stateId: string,
    fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
  ): void;

  // States
  upsertState(
    stateId: string,
    fields: Partial<BoardStateEntry> & { status: BoardStateEntry["status"]; entries: number },
  ): void;

  // Transaction / lifecycle
  walCheckpoint(): void;

  // Domain-language operations (compose infrastructure methods)
  recordStateEntry(stateId: string, fields?: Partial<BoardStateEntry>): void;
  recordStateCompletion(
    stateId: string,
    result: string,
    artifacts?: string[],
    iterationHistory?: HistoryEntry[],
  ): void;
  recordIterationAttempt(
    stateId: string,
    options: {
      iteration: number;
      status: string;
      data: Record<string, unknown>;
      stuckWhen?: StuckWhen;
    },
  ): { recorded: true; stuck: boolean };
};
