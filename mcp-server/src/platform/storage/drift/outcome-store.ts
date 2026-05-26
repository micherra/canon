/**
 * OutcomeStore DAO — violation_outcomes table
 *
 * Records user decisions on reviewer-flagged violations (fix / acknowledge / defer).
 * Added in drift schema v7.
 *
 * Follows the DriftDbSignals pattern:
 * - Constructor prepares all statements once
 * - All methods are synchronous (better-sqlite3)
 * - All methods catch errors and return safe defaults (errors-are-values)
 * - Outcome recording must never prevent a review from being written
 *
 * The table uses a composite PRIMARY KEY (file_path, principle_id, slug) so each
 * workflow records at most one outcome per file-principle pair. INSERT OR REPLACE
 * gives upsert semantics — the last action per workflow wins.
 */

import type Database from "better-sqlite3";

// ---- Types ----

/** A recorded user decision on a reviewer-flagged violation. */
export type ViolationOutcome = {
  file_path: string;
  principle_id: string;
  action: "fix" | "acknowledge" | "defer";
  slug: string;
  timestamp: string;
};

/** Aggregated action counts for a single principle. */
export type OutcomeStats = {
  principle_id: string;
  fix_count: number;
  acknowledge_count: number;
  defer_count: number;
  total: number;
};

// ---- DAO Class ----

/**
 * DAO for the violation_outcomes table added in drift schema v7.
 *
 * Construct with the same Database.Database handle used by DriftDb / initDriftDb().
 * All statements are prepared once in the constructor for performance.
 * Obtain a shared instance via DriftDb — do not construct for every request.
 */
export class OutcomeStore {
  private readonly stmtRecordOutcome: Database.Statement;
  private readonly stmtGetForPrinciple: Database.Statement;
  private readonly stmtGetStats: Database.Statement;
  private readonly stmtGetForFiles: Database.Statement;

  constructor(db: Database.Database) {
    // INSERT OR REPLACE gives upsert semantics per (file_path, principle_id, slug) PK
    this.stmtRecordOutcome = db.prepare(`
      INSERT OR REPLACE INTO violation_outcomes (file_path, principle_id, action, slug, timestamp)
      VALUES (@file_path, @principle_id, @action, @slug, @timestamp)
    `);

    this.stmtGetForPrinciple = db.prepare(`
      SELECT file_path, principle_id, action, slug, timestamp
      FROM violation_outcomes
      WHERE principle_id = ?
      ORDER BY timestamp DESC
    `);

    // Aggregated stats — no principleId filter
    this.stmtGetStats = db.prepare(`
      SELECT
        principle_id,
        SUM(CASE WHEN action = 'fix' THEN 1 ELSE 0 END)         AS fix_count,
        SUM(CASE WHEN action = 'acknowledge' THEN 1 ELSE 0 END) AS acknowledge_count,
        SUM(CASE WHEN action = 'defer' THEN 1 ELSE 0 END)       AS defer_count,
        COUNT(*)                                                  AS total
      FROM violation_outcomes
      GROUP BY principle_id
      ORDER BY total DESC
    `);

    this.stmtGetForFiles = db.prepare(`
      SELECT file_path, principle_id, action, slug, timestamp
      FROM violation_outcomes
      WHERE file_path = ?
      ORDER BY timestamp DESC
    `);
  }

  /**
   * Record (or replace) a violation outcome for a given workflow.
   * INSERT OR REPLACE ensures upsert: the last action per (file, principle, slug) wins.
   * Silently swallows errors — outcome recording must never block a review write.
   */
  recordOutcome(input: ViolationOutcome): void {
    try {
      this.stmtRecordOutcome.run(input);
    } catch (e) {
      console.warn("[OutcomeStore] recordOutcome failed:", e);
    }
  }

  /**
   * Get all outcomes for a given principle ID, ordered by timestamp DESC.
   * Returns empty array for unknown principles (define-errors-out-of-existence).
   */
  getOutcomesForPrinciple(principleId: string): ViolationOutcome[] {
    try {
      return this.stmtGetForPrinciple.all(principleId) as ViolationOutcome[];
    } catch (e) {
      console.warn("[OutcomeStore] getOutcomesForPrinciple failed:", e);
      return [];
    }
  }

  /**
   * Get aggregated outcome stats per principle.
   * When principleIds is provided, filters to only those principles.
   * Empty principleIds array returns [] immediately.
   * Returns empty array when no outcomes exist.
   */
  getOutcomeStats(principleIds?: string[]): OutcomeStats[] {
    try {
      if (principleIds !== undefined) {
        if (principleIds.length === 0) return [];
        // Build dynamic IN clause — principleIds is validated above
        // We re-prepare here because better-sqlite3 doesn't support array bindings.
        // This is safe: principleIds values are principle IDs (no user-controlled SQL).
        const placeholders = principleIds.map(() => "?").join(", ");
        const stmt = (this.stmtGetForPrinciple.database as Database.Database).prepare(`
          SELECT
            principle_id,
            SUM(CASE WHEN action = 'fix' THEN 1 ELSE 0 END)         AS fix_count,
            SUM(CASE WHEN action = 'acknowledge' THEN 1 ELSE 0 END) AS acknowledge_count,
            SUM(CASE WHEN action = 'defer' THEN 1 ELSE 0 END)       AS defer_count,
            COUNT(*)                                                  AS total
          FROM violation_outcomes
          WHERE principle_id IN (${placeholders})
          GROUP BY principle_id
          ORDER BY total DESC
        `);
        return stmt.all(...principleIds) as OutcomeStats[];
      }
      return this.stmtGetStats.all() as OutcomeStats[];
    } catch (e) {
      console.warn("[OutcomeStore] getOutcomeStats failed:", e);
      return [];
    }
  }

  /**
   * Get all outcomes for a list of file paths.
   * Returns a flat array of all matching rows ordered by timestamp DESC per file.
   * Returns empty array for empty input (define-errors-out-of-existence).
   */
  getOutcomesForFiles(filePaths: string[]): ViolationOutcome[] {
    if (filePaths.length === 0) return [];
    try {
      const results: ViolationOutcome[] = [];
      for (const fp of filePaths) {
        const rows = this.stmtGetForFiles.all(fp) as ViolationOutcome[];
        results.push(...rows);
      }
      return results;
    } catch (e) {
      console.warn("[OutcomeStore] getOutcomesForFiles failed:", e);
      return [];
    }
  }
}
