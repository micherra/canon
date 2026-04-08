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
  IterationEntry,
  Session,
} from "@domains/flows/board-state-schemas.ts";
import type { StuckWhen } from "@domains/flows/flow-definition-schemas.ts";
import type { WaveEvent } from "@domains/flows/event-schemas.ts";
import type {
  GetEventsOptions,
  GetMessagesOptions,
  GetWaveEventsOptions,
  InitExecutionParams,
  MessageOutput,
  UpdateExecutionFields,
  UpdateWaveEventFields,
  EventOutput,
} from "./execution-store.ts";

export interface IExecutionStore {
  // Execution (board + session singleton)
  initExecution(params: InitExecutionParams): void;
  getExecution(): (Record<string, unknown> & {
    blocked: Board["blocked"];
    concerns: Board["concerns"];
    skipped: string[];
    metadata: Board["metadata"];
  }) | null;
  getSession(): Session | null;
  updateExecution(fields: UpdateExecutionFields): void;

  // Board reconstruction
  getBoard(): Board | null;

  // States
  upsertState(
    stateId: string,
    fields: Partial<BoardStateEntry> & { status: BoardStateEntry["status"]; entries: number },
  ): void;
  getState(stateId: string): BoardStateEntry | null;
  getAllStates(): Array<BoardStateEntry & { state_id: string }>;

  // Iterations
  upsertIteration(
    stateId: string,
    fields: { count: number; max: number; history: unknown[]; cannot_fix?: unknown[] },
  ): void;
  getIteration(stateId: string): IterationEntry | null;

  // Iteration results (SQL-based stuck detection)
  recordIterationResult(
    stateId: string,
    iteration: number,
    status: string,
    data: Record<string, unknown>,
  ): void;
  isStuck(stateId: string, stuckWhen: StuckWhen): boolean;

  // Progress
  appendProgress(line: string): void;
  getProgress(maxEntries?: number): string;

  // Messages
  appendMessage(channel: string, sender: string, content: string): MessageOutput;
  getMessages(channel: string, options?: GetMessagesOptions): MessageOutput[];
  getMessagesSinceId(channel: string, sinceId: number): MessageOutput[];
  hasMessages(channel: string): boolean;

  // Wave events
  postWaveEvent(event: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string;
    status: string;
  }): void;
  getWaveEvents(options?: GetWaveEventsOptions): WaveEvent[];
  updateWaveEvent(id: string, fields: UpdateWaveEventFields): void;

  // Event log
  appendEvent(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  getEvents(options?: GetEventsOptions): EventOutput[];
  getEventsByType(type: string): EventOutput[];
  getCorrelationId(): string | null;

  // Metrics
  updateStateMetrics(stateId: string, metrics: Record<string, number | string>): boolean;

  // Cache prefix
  getCachePrefix(): string;
  setCachePrefix(prefix: string): void;

  // Transcript path
  setTranscriptPath(stateId: string, transcriptPath: string): boolean;
  getTranscriptPath(stateId: string): string | null;

  // Agent session
  updateAgentSession(stateId: string, sessionId: string): void;
  getAgentSession(
    stateId: string,
  ): { agent_session_id: string; last_agent_activity: string } | null;

  // Transaction / lifecycle
  walCheckpoint(): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}
