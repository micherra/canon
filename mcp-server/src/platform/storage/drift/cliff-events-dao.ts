/**
 * CliffEventsDao — durable cliff_detected event aggregation
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v10 migration table: cliff_events.
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the CraftProfileDao pattern: constructor prepares statements,
 * synchronous methods, callers never see SQL.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty table → []; unknown outcomes → "unknown"; updateOutcome on absent row → no-op
 * - prefer-constructor-injection: Database.Database handle passed via constructor
 * - backward-compatible-schema-changes: nullable columns for legacy payloads
 * - aggregates-reference-by-id: rows reference workspace by slug, step by step_id (no embedded state)
 */

import type Database from "better-sqlite3";

// ---- Outcome constant + derived union ----

export const CLIFF_RECOVERY_OUTCOMES = ["recovered", "abandoned", "unresolved", "unknown"] as const;
export type CliffRecoveryOutcome = (typeof CLIFF_RECOVERY_OUTCOMES)[number];

// ---- Public types ----

/**
 * A row from the cliff_events table.
 * Represents one durable cliff_detected event for a (workspace_slug, step_id) pair.
 * agent_type / missing_count / partial_count are nullable — legacy payloads lack per-step data.
 */
export type CliffEventRow = {
  id: number;
  workspace_slug: string;
  step_id: string;
  agent_type: string | null;
  source: string; // "resume" | "post_subagent" at write sites; string here (foreign data)
  detected_at: string; // ISO-8601
  missing_count: number | null;
  partial_count: number | null;
  recovery_outcome: CliffRecoveryOutcome;
  recorded_at: string; // ISO-8601
  /** Path to the captured transcript evidence (v15, cliff-transcript-01), when capture succeeded. */
  transcript_path: string | null;
  /** Typed reason capture did not happen (v15, cliff-transcript-01), when it didn't. */
  transcript_uncaptured_reason: string | null;
};

/**
 * Input for inserting or updating a cliff event.
 * recovery_outcome defaults to "unknown" when omitted.
 */
export type UpsertCliffEventInput = {
  workspace_slug: string;
  step_id: string;
  agent_type?: string;
  source: string;
  detected_at: string;
  missing_count?: number;
  partial_count?: number;
  recovery_outcome?: CliffRecoveryOutcome; // defaults to "unknown"
  /** Captured transcript evidence path (v15, cliff-transcript-01). */
  transcript_path?: string;
  /** Typed absent-reason when capture did not happen (v15, cliff-transcript-01). */
  transcript_uncaptured_reason?: string;
};

// ---- Raw DB row type ----

type CliffEventDbRow = {
  id: number;
  workspace_slug: string;
  step_id: string;
  agent_type: string | null;
  source: string;
  detected_at: string;
  missing_count: number | null;
  partial_count: number | null;
  recovery_outcome: string;
  recorded_at: string;
  transcript_path: string | null;
  transcript_uncaptured_reason: string | null;
};

// ---- Row deserializer ----

/**
 * Convert a raw SQLite row to a CliffEventRow.
 * Maps unrecognized recovery_outcome values to "unknown" (foreign data tolerance).
 */
function rowToCliffEventRow(row: CliffEventDbRow): CliffEventRow {
  const outcome: CliffRecoveryOutcome = (CLIFF_RECOVERY_OUTCOMES as ReadonlyArray<string>).includes(
    row.recovery_outcome,
  )
    ? (row.recovery_outcome as CliffRecoveryOutcome)
    : "unknown";

  return {
    agent_type: row.agent_type,
    detected_at: row.detected_at,
    id: row.id,
    missing_count: row.missing_count,
    partial_count: row.partial_count,
    recorded_at: row.recorded_at,
    recovery_outcome: outcome,
    source: row.source,
    step_id: row.step_id,
    transcript_path: row.transcript_path,
    transcript_uncaptured_reason: row.transcript_uncaptured_reason,
    workspace_slug: row.workspace_slug,
  };
}

// ---- DAO Class ----

/**
 * DAO for the cliff_events table added in drift schema v10.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getCliffEvents() in production code.
 */
export class CliffEventsDao {
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGetAll: Database.Statement;
  private readonly stmtGetByWorkspace: Database.Statement;
  private readonly stmtUpdateOutcome: Database.Statement;

  constructor(db: Database.Database) {
    // Upsert on (workspace_slug, step_id):
    // - detected_at, source, agent_type, missing_count, partial_count are refreshed
    // - agent_type uses COALESCE: existing non-null preserved over incoming null
    // - missing_count / partial_count: COALESCE preserves existing non-null
    // - recovery_outcome: CASE guards against downgrading a known outcome to "unknown"
    // - transcript_path: COALESCE preserves a previously-captured path across a later
    //   count-only re-upsert (v15)
    // - transcript_uncaptured_reason: path-or-reason invariant — once the resulting
    //   row has a transcript_path (existing or incoming), the reason is forced NULL,
    //   so a stale reason can never survive a later successful capture and an
    //   incoming reason can never clobber an already-captured path
    this.stmtUpsert = db.prepare(`
      INSERT INTO cliff_events (
        workspace_slug, step_id, agent_type, source, detected_at,
        missing_count, partial_count, recovery_outcome, recorded_at,
        transcript_path, transcript_uncaptured_reason
      ) VALUES (
        @workspace_slug, @step_id, @agent_type, @source, @detected_at,
        @missing_count, @partial_count, @recovery_outcome, @recorded_at,
        @transcript_path, @transcript_uncaptured_reason
      )
      ON CONFLICT(workspace_slug, step_id) DO UPDATE SET
        detected_at      = excluded.detected_at,
        source           = excluded.source,
        agent_type       = COALESCE(excluded.agent_type, cliff_events.agent_type),
        missing_count    = COALESCE(excluded.missing_count, cliff_events.missing_count),
        partial_count    = COALESCE(excluded.partial_count, cliff_events.partial_count),
        recovery_outcome = CASE
          WHEN excluded.recovery_outcome != 'unknown'
            THEN excluded.recovery_outcome
            ELSE cliff_events.recovery_outcome
          END,
        transcript_path = COALESCE(excluded.transcript_path, cliff_events.transcript_path),
        transcript_uncaptured_reason = CASE
          WHEN COALESCE(excluded.transcript_path, cliff_events.transcript_path) IS NOT NULL
            THEN NULL
            ELSE COALESCE(excluded.transcript_uncaptured_reason, cliff_events.transcript_uncaptured_reason)
          END
    `);

    this.stmtGetAll = db.prepare(`
      SELECT id, workspace_slug, step_id, agent_type, source, detected_at,
             missing_count, partial_count, recovery_outcome, recorded_at,
             transcript_path, transcript_uncaptured_reason
      FROM cliff_events
      ORDER BY detected_at ASC
    `);

    this.stmtGetByWorkspace = db.prepare(`
      SELECT id, workspace_slug, step_id, agent_type, source, detected_at,
             missing_count, partial_count, recovery_outcome, recorded_at,
             transcript_path, transcript_uncaptured_reason
      FROM cliff_events
      WHERE workspace_slug = ?
      ORDER BY detected_at ASC
    `);

    this.stmtUpdateOutcome = db.prepare(`
      UPDATE cliff_events
      SET recovery_outcome = ?
      WHERE workspace_slug = ? AND step_id = ?
    `);
  }

  /**
   * Insert or update a cliff event on (workspace_slug, step_id).
   * Update refreshes detected_at, source, and enrichment counts.
   * COALESCE semantics: never overwrites non-null agent_type/counts with null.
   * CASE semantics: never downgrades a known recovery_outcome to "unknown".
   */
  upsert(input: UpsertCliffEventInput): void {
    this.stmtUpsert.run({
      agent_type: input.agent_type ?? null,
      detected_at: input.detected_at,
      missing_count: input.missing_count ?? null,
      partial_count: input.partial_count ?? null,
      recorded_at: new Date().toISOString(),
      recovery_outcome: input.recovery_outcome ?? "unknown",
      source: input.source,
      step_id: input.step_id,
      transcript_path: input.transcript_path ?? null,
      transcript_uncaptured_reason: input.transcript_uncaptured_reason ?? null,
      workspace_slug: input.workspace_slug,
    });
  }

  /**
   * Get all cliff events across all workspaces, ordered by detected_at ASC.
   * Returns [] when no events exist (define-errors-out-of-existence).
   */
  getAll(): CliffEventRow[] {
    const rows = this.stmtGetAll.all() as CliffEventDbRow[];
    return rows.map(rowToCliffEventRow);
  }

  /**
   * Get all cliff events for a specific workspace_slug, ordered by detected_at ASC.
   * Returns [] for an unknown workspace slug (define-errors-out-of-existence).
   */
  getByWorkspace(workspaceSlug: string): CliffEventRow[] {
    const rows = this.stmtGetByWorkspace.all(workspaceSlug) as CliffEventDbRow[];
    return rows.map(rowToCliffEventRow);
  }

  /**
   * Set recovery_outcome for a (workspace_slug, step_id) pair.
   * No-op when the row does not exist (define-errors-out-of-existence).
   */
  updateOutcome(workspaceSlug: string, stepId: string, outcome: CliffRecoveryOutcome): void {
    this.stmtUpdateOutcome.run(outcome, workspaceSlug, stepId);
  }
}
