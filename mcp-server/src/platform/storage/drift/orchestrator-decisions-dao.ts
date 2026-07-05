/**
 * OrchestratorDecisionsDao — durable, cross-workspace decisions corpus
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v14 migration table: orchestrator_decisions.
 *
 * Hosts the real `log_decision` corpus after a workspace is reaped (ADR-0038).
 * NOT the dead `decisions` table (see decisions-dao.ts) — that table's schema
 * (built for the removed architect docs) has no gate/outcome/rationale/refs
 * columns and cannot host this corpus without losing queryability.
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the ActiveWorkspacesDao pattern: constructor prepares statements,
 * synchronous methods, callers never see SQL.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty table -> []
 * - reuse-before-rebuild: additive table in the existing project-level drift.db
 */

import type { DecisionRecord } from "@shared/lib/decision-event-reader.ts";
import type Database from "better-sqlite3";

/** A row from the orchestrator_decisions table, as persisted durably. */
export type PersistedDecision = {
  id: number;
  source_slug: string;
  source_event_id: number;
  decision_type: string;
  summary: string;
  rationale: string | null;
  outcome: string | null;
  gate: string | null;
  refs: string[];
  decided_at: string;
  persisted_at: string;
};

// ---- Raw DB row type ----

type PersistedDecisionDbRow = {
  id: number;
  source_slug: string;
  source_event_id: number;
  decision_type: string;
  summary: string;
  rationale: string | null;
  outcome: string | null;
  gate: string | null;
  refs_json: string | null;
  decided_at: string;
  persisted_at: string;
};

// ---- Row deserializer ----

/** Convert a raw SQLite row to a PersistedDecision, defensively parsing refs_json. */
function rowToPersistedDecision(row: PersistedDecisionDbRow): PersistedDecision {
  let refs: string[] = [];
  if (row.refs_json) {
    try {
      const parsed = JSON.parse(row.refs_json) as unknown;
      if (Array.isArray(parsed)) {
        refs = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // Malformed refs_json — degrade to empty array rather than throw
    }
  }
  return {
    decided_at: row.decided_at,
    decision_type: row.decision_type,
    gate: row.gate,
    id: row.id,
    outcome: row.outcome,
    persisted_at: row.persisted_at,
    rationale: row.rationale,
    refs,
    source_event_id: row.source_event_id,
    source_slug: row.source_slug,
    summary: row.summary,
  };
}

// ---- DAO Class ----

/**
 * DAO for the orchestrator_decisions table added in drift schema v14.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getOrchestratorDecisions() in production code.
 */
export class OrchestratorDecisionsDao {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetAll: Database.Statement;
  private readonly stmtGetBySlug: Database.Statement;

  constructor(private readonly db: Database.Database) {
    // INSERT OR IGNORE + UNIQUE(source_slug, source_event_id) make persist
    // idempotent — a crash between persist and rmSync re-persists on a later
    // run without creating duplicate rows.
    this.stmtInsert = db.prepare(`
      INSERT OR IGNORE INTO orchestrator_decisions (
        source_slug, source_event_id, decision_type, summary, rationale,
        outcome, gate, refs_json, decided_at, persisted_at
      ) VALUES (
        @source_slug, @source_event_id, @decision_type, @summary, @rationale,
        @outcome, @gate, @refs_json, @decided_at, @persisted_at
      )
    `);

    this.stmtGetAll = db.prepare(
      `SELECT * FROM orchestrator_decisions ORDER BY decided_at ASC, id ASC`,
    );

    this.stmtGetBySlug = db.prepare(
      `SELECT * FROM orchestrator_decisions WHERE source_slug = ? ORDER BY decided_at ASC, id ASC`,
    );
  }

  /**
   * Persist a batch of decision records for a workspace slug, inside a single
   * transaction. Idempotent: re-running with the same records inserts 0 new
   * rows (INSERT OR IGNORE + UNIQUE(source_slug, source_event_id)).
   */
  persistMany(slug: string, records: DecisionRecord[]): void {
    const persistedAt = new Date().toISOString();
    const insertAll = this.db.transaction((rs: DecisionRecord[]) => {
      for (const r of rs) {
        this.stmtInsert.run({
          decided_at: r.decided_at,
          decision_type: r.decision_type,
          gate: r.gate ?? null,
          outcome: r.outcome ?? null,
          persisted_at: persistedAt,
          rationale: r.rationale ?? null,
          refs_json: r.refs !== undefined ? JSON.stringify(r.refs) : null,
          source_event_id: r.source_event_id,
          source_slug: slug,
          summary: r.summary,
        });
      }
    });
    insertAll(records);
  }

  /**
   * Fetch all durably persisted decisions across every workspace, ordered by
   * decided_at ASC. Returns [] when the table is empty (define-errors-out-of-existence).
   */
  getAll(): PersistedDecision[] {
    const rows = this.stmtGetAll.all() as PersistedDecisionDbRow[];
    return rows.map(rowToPersistedDecision);
  }

  /**
   * Fetch durably persisted decisions for a single workspace slug, ordered by
   * decided_at ASC. Returns [] when no rows exist for the slug (define-errors-out-of-existence).
   */
  getBySlug(slug: string): PersistedDecision[] {
    const rows = this.stmtGetBySlug.all(slug) as PersistedDecisionDbRow[];
    return rows.map(rowToPersistedDecision);
  }
}
