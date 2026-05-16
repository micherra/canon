/**
 * DriftDbSignals DAO — signal tables for the Continuous Learning System
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v4 migration tables: file_violation_history and path_effects.
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the DriftDb pattern: constructor prepares statements, synchronous
 * methods, callers never see SQL.
 */

import type Database from "better-sqlite3";

// ---- Types ----

/**
 * A row from the file_violation_history table.
 * Tracks per-file, per-principle violation aggregates.
 */
export type FileViolationHistoryRow = {
  file_path: string;
  principle_id: string;
  violation_count: number;
  last_seen: string;
  first_seen: string;
};

/**
 * A row from the path_effects table.
 * Tracks per-file review metadata for signal compilation.
 */
export type PathEffectRow = {
  file_path: string;
  total_violations: number;
  total_reviews: number;
  last_violation_at: string | null;
  last_clean_at: string | null;
  clean_streak: number;
  violation_streak: number;
};

/**
 * Input for upserting a file violation record.
 */
export type UpsertFileViolationInput = {
  file_path: string;
  principle_id: string;
  violation_count: number;
  last_seen: string;
  first_seen: string;
};

/**
 * Input for upserting a path effect record.
 */
export type UpsertPathEffectInput = {
  file_path: string;
  total_violations: number;
  total_reviews: number;
  last_violation_at: string | null;
  last_clean_at: string | null;
  clean_streak: number;
  violation_streak: number;
};

// ---- DAO Class ----

/**
 * DAO for the signal tables added in drift schema v4.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getSignals() in production code.
 */
export class DriftDbSignals {
  // Prepared statements
  private readonly stmtGetFileViolationHistory: Database.Statement;
  private readonly stmtUpsertFileViolation: Database.Statement;
  private readonly stmtMarkFixed: Database.Statement;
  private readonly stmtGetPathEffects: Database.Statement;
  private readonly stmtUpsertPathEffect: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtGetFileViolationHistory = db.prepare(`
      SELECT file_path, principle_id, violation_count, last_seen, first_seen
      FROM file_violation_history
      WHERE file_path = ?
      ORDER BY violation_count DESC
    `);

    this.stmtUpsertFileViolation = db.prepare(`
      INSERT INTO file_violation_history (file_path, principle_id, violation_count, last_seen, first_seen)
      VALUES (@file_path, @principle_id, @violation_count, @last_seen, @first_seen)
      ON CONFLICT(file_path, principle_id) DO UPDATE SET
        violation_count = @violation_count,
        last_seen = @last_seen
    `);

    this.stmtMarkFixed = db.prepare(`
      DELETE FROM file_violation_history
      WHERE file_path = @file_path AND principle_id = @principle_id
    `);

    this.stmtGetPathEffects = db.prepare(`
      SELECT file_path, total_violations, total_reviews,
             last_violation_at, last_clean_at, clean_streak, violation_streak
      FROM path_effects
      WHERE file_path = ?
    `);

    this.stmtUpsertPathEffect = db.prepare(`
      INSERT INTO path_effects (file_path, total_violations, total_reviews,
                                last_violation_at, last_clean_at, clean_streak, violation_streak)
      VALUES (@file_path, @total_violations, @total_reviews,
              @last_violation_at, @last_clean_at, @clean_streak, @violation_streak)
      ON CONFLICT(file_path) DO UPDATE SET
        total_violations = @total_violations,
        total_reviews = @total_reviews,
        last_violation_at = @last_violation_at,
        last_clean_at = @last_clean_at,
        clean_streak = @clean_streak,
        violation_streak = @violation_streak
    `);
  }

  /**
   * Get violation history for a list of file paths.
   * Returns a flat array of all matching rows, ordered by violation_count DESC per file.
   * Returns empty array for empty input (define-errors-out-of-existence).
   */
  getFileViolationHistory(filePaths: string[]): FileViolationHistoryRow[] {
    if (filePaths.length === 0) return [];
    const results: FileViolationHistoryRow[] = [];
    for (const fp of filePaths) {
      const rows = this.stmtGetFileViolationHistory.all(fp) as FileViolationHistoryRow[];
      results.push(...rows);
    }
    return results;
  }

  /**
   * Upsert a file violation record.
   * INSERT OR UPDATE on (file_path, principle_id) unique key.
   * On conflict, updates violation_count and last_seen only; preserves first_seen.
   */
  upsertFileViolation(input: UpsertFileViolationInput): void {
    this.stmtUpsertFileViolation.run(input);
  }

  /**
   * Mark a violation as fixed by deleting the record.
   * No-op if no matching record exists (define-errors-out-of-existence).
   */
  markFixed(filePath: string, principleId: string): void {
    this.stmtMarkFixed.run({ file_path: filePath, principle_id: principleId });
  }

  /**
   * Get path effects for a list of file paths.
   * Returns a flat array of all matching rows (at most one per file path).
   * Returns empty array for empty input (define-errors-out-of-existence).
   */
  getPathEffects(filePaths: string[]): PathEffectRow[] {
    if (filePaths.length === 0) return [];
    const results: PathEffectRow[] = [];
    for (const fp of filePaths) {
      const row = this.stmtGetPathEffects.get(fp) as PathEffectRow | undefined;
      if (row) results.push(row);
    }
    return results;
  }

  /**
   * Upsert a path effect record.
   * INSERT OR UPDATE on file_path unique key.
   * On conflict, updates all fields.
   */
  upsertPathEffect(input: UpsertPathEffectInput): void {
    this.stmtUpsertPathEffect.run(input);
  }
}
