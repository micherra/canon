/**
 * decision-event-reader — raw readonly reader for `orchestrator_decision` events.
 *
 * Shared primitive used by BOTH the janitor's reap-time persist path
 * (`decision-persistence.ts`) and, in a later build, the cross-workspace
 * decisions corpus reader (ADR-0038).
 *
 * Deliberately raw — does NOT go through getExecutionStore(), which would run
 * idempotent execution-schema migrations that MUTATE a soon-to-die or foreign
 * store on open. A plain readonly open + SELECT on the stable `events` table
 * tolerates execution-schema-version skew across old workspaces.
 *
 * Canon principles:
 * - define-errors-out-of-existence: any abnormal store (missing file, no
 *   `events` table, corrupt db, malformed row) degrades to [] / a skipped
 *   row rather than throwing.
 */

import Database from "better-sqlite3";

/**
 * Canonical shared shape for a read/persisted orchestrator decision event.
 * Distinct from decisions-ledger.ts's DecisionRecord (that type stays
 * workspace-local and untouched — do not couple the two).
 */
export type DecisionRecord = {
  source_event_id: number;
  decided_at: string;
  decision_type: string;
  summary: string;
  rationale?: string;
  outcome?: string;
  gate?: string;
  refs?: string[];
};

type EventRow = {
  id: number;
  payload: string;
  timestamp: string;
};

/** Read a string field from an arbitrary payload object safely. */
function readStr(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Read a string[] field from an arbitrary payload object safely. */
function readStrArr(payload: Record<string, unknown>, key: string): string[] | undefined {
  const v = payload[key];
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

/**
 * Map a raw events-table row to a DecisionRecord. Mirrors decisions-ledger.ts's
 * eventToDecisionRecord (same typeof-guarded, defensive payload parsing) —
 * different field names (source_event_id, decided_at) matching the durable
 * table's columns. Returns null for a malformed row (bad JSON, or missing the
 * required summary/decision_type fields) so callers can skip it safely.
 */
function rowToDecisionRecord(row: EventRow): DecisionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null;
  }
  const payload: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

  const summary = readStr(payload, "summary");
  const decisionType = readStr(payload, "decision_type");
  if (summary === undefined || decisionType === undefined) return null;

  const record: DecisionRecord = {
    decided_at: readStr(payload, "timestamp") ?? row.timestamp,
    decision_type: decisionType,
    source_event_id: row.id,
    summary,
  };

  const rationale = readStr(payload, "rationale");
  if (rationale !== undefined) record.rationale = rationale;
  const outcome = readStr(payload, "outcome");
  if (outcome !== undefined) record.outcome = outcome;
  const gate = readStr(payload, "gate");
  if (gate !== undefined) record.gate = gate;
  const refs = readStrArr(payload, "refs");
  if (refs !== undefined) record.refs = refs;

  return record;
}

/**
 * Read all `orchestrator_decision` events from a workspace's orchestration.db,
 * ordered by id ASC. Opens readonly — never runs migrations, never writes,
 * always closes in `finally`.
 *
 * Fail-open / errors-out-of-existence: any open or query error (missing file,
 * no `events` table, schema skew, corrupt db) returns `[]`, never throws.
 * A malformed individual row is skipped rather than aborting the whole read.
 */
export function readDecisionEvents(dbPath: string): DecisionRecord[] {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true, readonly: true });
    const rows = db
      .prepare(
        `SELECT id, payload, timestamp FROM events WHERE type = 'orchestrator_decision' ORDER BY id ASC`,
      )
      .all() as EventRow[];
    const records: DecisionRecord[] = [];
    for (const row of rows) {
      const record = rowToDecisionRecord(row);
      if (record) records.push(record);
    }
    return records;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close
    }
  }
}
