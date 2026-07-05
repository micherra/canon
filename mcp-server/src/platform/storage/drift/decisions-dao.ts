/**
 * DecisionsDao — legacy per-run decision notes (ADR-019)
 *
 * Relocated out of drift-db.ts (line-count remediation, decisions-corpus
 * build, ADR-0040) — a pure move, no behavior change. Operates on the v2
 * migration table: decisions.
 *
 * This table is a DEAD WIRE: 0 rows, 0 live writers (`append` — formerly
 * `appendDecision` — has no non-test caller); its only reader is `get_history`,
 * which therefore always reports 0 decisions. Its schema (built for the
 * removed architect `decisions/` docs) predates and is unrelated to the real
 * `log_decision` corpus — do NOT confuse this with `orchestrator-decisions-dao.ts`,
 * which hosts that corpus durably. Left in place per ADR-0040 (filed as a
 * learner signal, not resolved here).
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 */

import type Database from "better-sqlite3";
import type { DecisionEntry } from "./drift-analytics-types.ts";
import type { DecisionRow } from "./drift-db-rows.ts";
import { rowToDecisionEntry } from "./drift-db-rows.ts";

/**
 * DAO for the decisions table added in drift schema v2.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getDecisionsLegacy() in production code.
 */
export class DecisionsDao {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetByRun: Database.Statement;
  private readonly stmtGetRecent: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT OR IGNORE INTO decisions (
        decision_id, run_id, flow, task, title, content, file_path, timestamp
      ) VALUES (
        @decision_id, @run_id, @flow, @task, @title, @content, @file_path, @timestamp
      )
    `);

    this.stmtGetByRun = db.prepare(
      `SELECT * FROM decisions WHERE run_id = ? ORDER BY timestamp ASC`,
    );

    this.stmtGetRecent = db.prepare(`SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?`);
  }

  /**
   * INSERT a DecisionEntry into the decisions table.
   * Uses INSERT OR IGNORE — duplicate decision_id is a no-op (idempotent).
   * (no-silent-failures: the duplicate is intentional, not an error)
   */
  append(entry: DecisionEntry): void {
    this.stmtInsert.run({
      content: entry.content,
      decision_id: entry.decision_id,
      file_path: entry.file_path ?? null,
      flow: entry.flow ?? null,
      run_id: entry.run_id ?? null,
      task: entry.task ?? null,
      timestamp: entry.timestamp,
      title: entry.title,
    });
  }

  /**
   * Fetch all decisions for a given run_id, ordered by timestamp ASC.
   * Returns empty array when no decisions exist for the run
   * (define-errors-out-of-existence).
   */
  getByRun(runId: string): DecisionEntry[] {
    const rows = this.stmtGetByRun.all(runId) as DecisionRow[];
    return rows.map(rowToDecisionEntry);
  }

  /**
   * Fetch the most recent N decisions across all runs, ordered by timestamp DESC.
   * Returns empty array when no decisions exist (define-errors-out-of-existence).
   */
  getRecent(limit: number): DecisionEntry[] {
    const rows = this.stmtGetRecent.all(limit) as DecisionRow[];
    return rows.map(rowToDecisionEntry);
  }
}
