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

/** A row from the predictions table. */
export type PredictionRow = {
  id: number;
  prediction_id: string;
  workspace: string | null;
  flow_id: string | null;
  file_paths: string; // JSON array
  principle_ids: string; // JSON array
  signals_json: string; // JSON
  timestamp: string;
  resolved: number; // 0 or 1
  resolved_at: string | null;
  outcome: string | null; // JSON
};

/** Input for inserting a prediction record. */
export type InsertPredictionInput = {
  prediction_id: string;
  workspace: string | null;
  flow_id: string | null;
  file_paths: string; // Pre-serialized JSON array
  principle_ids: string; // Pre-serialized JSON array
  signals_json: string; // Pre-serialized JSON
  timestamp: string;
};

/** Input for resolving a prediction. */
export type ResolvePredictionInput = {
  prediction_id: string;
  resolved_at: string;
  outcome: string; // Pre-serialized JSON
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
  // Prepared statements — signal tables (v4)
  private readonly stmtGetFileViolationHistory: Database.Statement;
  private readonly stmtUpsertFileViolation: Database.Statement;
  private readonly stmtMarkFixed: Database.Statement;
  private readonly stmtGetPathEffects: Database.Statement;
  private readonly stmtUpsertPathEffect: Database.Statement;

  // Prepared statements — predictions table (v5)
  private readonly stmtInsertPrediction: Database.Statement;
  private readonly stmtGetUnresolved: Database.Statement;
  private readonly stmtResolvePrediction: Database.Statement;
  private readonly stmtGetPredictionById: Database.Statement;
  private readonly stmtGetResolvedAll: Database.Statement;
  private readonly stmtGetResolvedByPrinciple: Database.Statement;

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

    // Predictions (v5)
    this.stmtInsertPrediction = db.prepare(`
      INSERT INTO predictions (prediction_id, workspace, flow_id, file_paths, principle_ids, signals_json, timestamp, resolved)
      VALUES (@prediction_id, @workspace, @flow_id, @file_paths, @principle_ids, @signals_json, @timestamp, 0)
    `);

    this.stmtGetUnresolved = db.prepare(`
      SELECT id, prediction_id, workspace, flow_id, file_paths, principle_ids, signals_json, timestamp, resolved, resolved_at, outcome
      FROM predictions
      WHERE resolved = 0
      ORDER BY timestamp DESC
      LIMIT 200
    `);

    this.stmtResolvePrediction = db.prepare(`
      UPDATE predictions
      SET resolved = 1, resolved_at = @resolved_at, outcome = @outcome
      WHERE prediction_id = @prediction_id
    `);

    this.stmtGetPredictionById = db.prepare(`
      SELECT id, prediction_id, workspace, flow_id, file_paths, principle_ids, signals_json, timestamp, resolved, resolved_at, outcome
      FROM predictions
      WHERE prediction_id = ?
    `);

    this.stmtGetResolvedAll = db.prepare(`
      SELECT id, prediction_id, workspace, flow_id, file_paths, principle_ids, signals_json, timestamp, resolved, resolved_at, outcome
      FROM predictions
      WHERE resolved = 1
        AND outcome IS NOT NULL
      ORDER BY resolved_at DESC
      LIMIT 500
    `);

    this.stmtGetResolvedByPrinciple = db.prepare(`
      SELECT DISTINCT p.id, p.prediction_id, p.workspace, p.flow_id, p.file_paths, p.principle_ids, p.signals_json, p.timestamp, p.resolved, p.resolved_at, p.outcome
      FROM predictions p, json_each(p.principle_ids) AS je
      WHERE p.resolved = 1
        AND p.outcome IS NOT NULL
        AND je.value = ?
      ORDER BY p.resolved_at DESC
      LIMIT 500
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

  // ---- Predictions (v5) ----

  /**
   * Insert a prediction record.
   * Throws on duplicate prediction_id (UNIQUE constraint violation).
   * JSON columns (file_paths, principle_ids, signals_json) are pre-serialized by the caller.
   */
  insertPrediction(input: InsertPredictionInput): void {
    this.stmtInsertPrediction.run(input);
  }

  /**
   * Return all unresolved predictions (resolved = 0), ordered by timestamp DESC.
   * Returns empty array when no unresolved predictions exist
   * (define-errors-out-of-existence).
   */
  getUnresolvedPredictions(): PredictionRow[] {
    return this.stmtGetUnresolved.all() as PredictionRow[];
  }

  /**
   * Mark a prediction as resolved by setting resolved=1, resolved_at, and outcome.
   * No-op if no matching prediction_id exists (define-errors-out-of-existence).
   */
  resolvePrediction(input: ResolvePredictionInput): void {
    this.stmtResolvePrediction.run(input);
  }

  /**
   * Fetch a single prediction by prediction_id.
   * Returns undefined when not found (define-errors-out-of-existence).
   */
  getPredictionById(predictionId: string): PredictionRow | undefined {
    return this.stmtGetPredictionById.get(predictionId) as PredictionRow | undefined;
  }

  /**
   * Return resolved predictions (resolved=1, outcome IS NOT NULL).
   *
   * Without filter: returns all resolved predictions ordered by resolved_at DESC, LIMIT 500.
   * With filter: iterates principleIds, queries each via json_each(), deduplicates by prediction_id.
   * Empty principleIds array returns [] immediately (define-errors-out-of-existence / validate-at-trust-boundaries).
   *
   * @param principleIds - optional list of principle IDs to filter by; omit for all resolved predictions
   */
  getResolvedPredictions(principleIds?: string[]): PredictionRow[] {
    // validate-at-trust-boundaries: empty array means "no filter requested" — but since
    // an empty filter cannot match anything, return early rather than silently returning all.
    if (principleIds !== undefined && principleIds.length === 0) return [];

    if (principleIds === undefined) {
      return this.stmtGetResolvedAll.all() as PredictionRow[];
    }

    // Filter by principle IDs: iterate and deduplicate by prediction_id
    const seen = new Set<string>();
    const results: PredictionRow[] = [];
    for (const principleId of principleIds) {
      const rows = this.stmtGetResolvedByPrinciple.all(principleId) as PredictionRow[];
      for (const row of rows) {
        if (!seen.has(row.prediction_id)) {
          seen.add(row.prediction_id);
          results.push(row);
        }
      }
    }
    return results;
  }
}
