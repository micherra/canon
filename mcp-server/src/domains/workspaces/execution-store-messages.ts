/**
 * Message and event-log operations for ExecutionStore.
 * Extracted from execution-store.ts to keep each file under 600 lines.
 *
 * All functions take a `db` parameter (better-sqlite3 Database) so they can be
 * called from ExecutionStore methods without circular imports.
 */

import { validateEventPayload } from "@domains/messages/events.ts";
import type Database from "better-sqlite3";
import type {
  EventOutput,
  GetEventsOptions,
  GetMessagesOptions,
  MessageOutput,
  MessageRow,
} from "./execution-store-types.ts";

// ---- Message operations ----

export function appendMessage(
  stmtAppendMessage: Database.Statement,
  channel: string,
  sender: string,
  content: string,
): MessageOutput {
  const timestamp = new Date().toISOString();
  const row = stmtAppendMessage.get({ channel, content, sender, timestamp }) as MessageRow;
  return {
    channel: row.channel,
    content: row.content,
    id: row.id,
    sender: row.sender,
    timestamp: row.timestamp,
  };
}

export function getMessages(
  stmtGetMessages: Database.Statement,
  stmtGetMessagesSince: Database.Statement,
  channel: string,
  options?: GetMessagesOptions,
): MessageOutput[] {
  let rows: MessageRow[];
  if (options?.since !== undefined) {
    rows = stmtGetMessagesSince.all(channel, options.since) as MessageRow[];
  } else {
    rows = stmtGetMessages.all(channel) as MessageRow[];
  }
  return rows.map((r) => ({
    channel: r.channel,
    content: r.content,
    id: r.id,
    sender: r.sender,
    timestamp: r.timestamp,
  }));
}

/**
 * Returns messages in `channel` whose numeric id is strictly greater than `sinceId`.
 * Results are ordered ascending by id.
 */
export function getMessagesSinceId(
  stmtGetMessagesSinceId: Database.Statement,
  channel: string,
  sinceId: number,
): MessageOutput[] {
  const rows = stmtGetMessagesSinceId.all(channel, sinceId) as MessageRow[];
  return rows.map((r) => ({
    channel: r.channel,
    content: r.content,
    id: r.id,
    sender: r.sender,
    timestamp: r.timestamp,
  }));
}

/** Returns true when at least one message exists in the channel, without loading all messages. */
export function hasMessages(stmtHasMessages: Database.Statement, channel: string): boolean {
  return stmtHasMessages.get(channel) !== undefined;
}

// ---- Event log operations ----

export type AppendEventArgs = {
  stmtAppendEvent: Database.Statement;
  getCorrelationIdFn: () => string | null;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
};

export function appendEvent(args: AppendEventArgs): void {
  const { stmtAppendEvent, getCorrelationIdFn, type, payload, correlationId } = args;
  const validation = validateEventPayload(type, payload);
  if (!validation.valid) {
    console.warn(`[canon] Event payload validation failed for type "${type}":`, validation.errors);
  }
  stmtAppendEvent.run({
    correlation_id: correlationId ?? getCorrelationIdFn(),
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    type,
  });
}

export type EventStmts = {
  db: Database.Database;
  stmtGetEventsAll: Database.Statement;
  stmtGetEventsByCorrelation: Database.Statement;
  stmtGetEventsByType: Database.Statement;
};

/**
 * Query events with optional filtering.
 * Returns empty array when no events match. SQLite errors may still be thrown.
 */
export function getEvents(stmts: EventStmts, options?: GetEventsOptions): EventOutput[] {
  const { db, stmtGetEventsAll, stmtGetEventsByCorrelation, stmtGetEventsByType } = stmts;
  const { correlation_id, type, since, limit } = options ?? {};

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
    rows = stmtGetEventsAll.all() as typeof rows;
  } else if (hasCorrelation && !hasType && !hasSince && !hasLimit) {
    rows = stmtGetEventsByCorrelation.all(correlation_id) as typeof rows;
  } else if (hasType && !hasCorrelation && !hasSince && !hasLimit) {
    rows = stmtGetEventsByType.all(type) as typeof rows;
  } else {
    rows = buildEventQuery(db, options ?? {});
  }

  const events: EventOutput[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // best-effort: corrupt event payload in DB; skip this row and continue collecting others
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

function buildEventQuery(
  db: Database.Database,
  options: GetEventsOptions,
): Array<{
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

  return db.prepare(sql).all(...params) as Array<{
    id: number;
    type: string;
    payload: string;
    correlation_id: string | null;
    timestamp: string;
  }>;
}
