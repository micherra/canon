/**
 * AppliedEvolutionsDao — durable apply-provenance store (drift schema v12)
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v12 migration table: applied_evolutions.
 *
 * One row per applied evolution-candidate, keyed UNIQUE(proposal_id). The row
 * ties proposal_id ↔ target_path ↔ before/after content hash ↔ holdout scores ↔
 * applied_at (the cohort-split anchor) ↔ apply_base_commit. `applying_commit` is
 * nullable — the apply command does not commit, so it is back-filled later from
 * the Canon-Evolution: trailer (ADR-0034).
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the CliffEventsDao pattern: constructor prepares statements,
 * synchronous methods, callers never see SQL.
 *
 * Canon principles:
 * - errors-are-values: methods are total; getByProposalId returns null (not throw)
 *   for an absent row; listAppliedSince returns [] for no matches.
 * - simplicity-first: copies the established cliff_events DAO pattern; no new abstraction.
 * - no-dead-abstractions: only columns written this build — no quarantine field (Inc-4).
 */

import type Database from "better-sqlite3";

// ---- Public types ----

/**
 * A row from the applied_evolutions table.
 * Represents one durable apply-provenance record for an evolution-candidate.
 * `principle_id`, `apply_base_commit`, and `applying_commit` are nullable.
 */
export type AppliedEvolutionRow = {
  id: number;
  proposal_id: string;
  target_path: string;
  artifact_class: string;
  principle_id: string | null;
  before_hash: string;
  after_hash: string;
  holdout_baseline: number;
  holdout_candidate: number;
  apply_base_commit: string | null;
  applying_commit: string | null;
  applied_at: string; // ISO-8601 — the cohort split anchor
};

/**
 * Input for recording (upserting) an applied evolution.
 * `principle_id`, `apply_base_commit`, and `applying_commit` are optional/nullable.
 */
export type RecordAppliedEvolutionInput = {
  proposal_id: string;
  target_path: string;
  artifact_class: string;
  principle_id?: string | null;
  before_hash: string;
  after_hash: string;
  holdout_baseline: number;
  holdout_candidate: number;
  apply_base_commit?: string | null;
  applying_commit?: string | null;
  applied_at: string;
};

/**
 * One trailer-derived (proposal_id, commit sha) pair to back-fill into
 * `applied_evolutions.applying_commit` (Inc-3). Sourced from parsed
 * `Canon-Evolution: {proposal_id}` git trailers.
 */
export type BackfillPair = {
  proposal_id: string;
  applying_commit: string;
};

// ---- Raw DB row type ----

type AppliedEvolutionDbRow = {
  id: number;
  proposal_id: string;
  target_path: string;
  artifact_class: string;
  principle_id: string | null;
  before_hash: string;
  after_hash: string;
  holdout_baseline: number;
  holdout_candidate: number;
  apply_base_commit: string | null;
  applying_commit: string | null;
  applied_at: string;
};

// ---- Row deserializer ----

/** Convert a raw SQLite row to an AppliedEvolutionRow (identity mapping — no coercion). */
function rowToAppliedEvolutionRow(row: AppliedEvolutionDbRow): AppliedEvolutionRow {
  return {
    after_hash: row.after_hash,
    applied_at: row.applied_at,
    apply_base_commit: row.apply_base_commit,
    applying_commit: row.applying_commit,
    artifact_class: row.artifact_class,
    before_hash: row.before_hash,
    holdout_baseline: row.holdout_baseline,
    holdout_candidate: row.holdout_candidate,
    id: row.id,
    principle_id: row.principle_id,
    proposal_id: row.proposal_id,
    target_path: row.target_path,
  };
}

// ---- DAO Class ----

/**
 * DAO for the applied_evolutions table added in drift schema v12.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getAppliedEvolutions() in production code.
 */
export class AppliedEvolutionsDao {
  private readonly stmtRecord: Database.Statement;
  private readonly stmtGetByProposalId: Database.Statement;
  private readonly stmtListSince: Database.Statement;
  private readonly stmtBackfill: Database.Statement;
  private readonly txBackfill: (pairs: ReadonlyArray<BackfillPair>) => number;

  constructor(db: Database.Database) {
    // Upsert on (proposal_id): re-applying the same proposal UPDATEs in place.
    // apply_base_commit / applying_commit use COALESCE so a later back-fill of
    // applying_commit is never clobbered by a null re-record, and an
    // apply_base_commit is not lost if a later record omits it.
    this.stmtRecord = db.prepare(`
      INSERT INTO applied_evolutions (
        proposal_id, target_path, artifact_class, principle_id,
        before_hash, after_hash, holdout_baseline, holdout_candidate,
        apply_base_commit, applying_commit, applied_at
      ) VALUES (
        @proposal_id, @target_path, @artifact_class, @principle_id,
        @before_hash, @after_hash, @holdout_baseline, @holdout_candidate,
        @apply_base_commit, @applying_commit, @applied_at
      )
      ON CONFLICT(proposal_id) DO UPDATE SET
        target_path       = excluded.target_path,
        artifact_class    = excluded.artifact_class,
        principle_id      = excluded.principle_id,
        before_hash       = excluded.before_hash,
        after_hash        = excluded.after_hash,
        holdout_baseline  = excluded.holdout_baseline,
        holdout_candidate = excluded.holdout_candidate,
        apply_base_commit = COALESCE(excluded.apply_base_commit, applied_evolutions.apply_base_commit),
        applying_commit   = COALESCE(excluded.applying_commit, applied_evolutions.applying_commit),
        applied_at        = excluded.applied_at
    `);

    this.stmtGetByProposalId = db.prepare(`
      SELECT id, proposal_id, target_path, artifact_class, principle_id,
             before_hash, after_hash, holdout_baseline, holdout_candidate,
             apply_base_commit, applying_commit, applied_at
      FROM applied_evolutions
      WHERE proposal_id = ?
    `);

    this.stmtListSince = db.prepare(`
      SELECT id, proposal_id, target_path, artifact_class, principle_id,
             before_hash, after_hash, holdout_baseline, holdout_candidate,
             apply_base_commit, applying_commit, applied_at
      FROM applied_evolutions
      WHERE applied_at >= ?
      ORDER BY applied_at ASC
    `);

    // Null-only guard: `AND applying_commit IS NULL` makes this UPDATE idempotent
    // and COALESCE-safe by construction — a re-run, or a row already carrying a
    // non-null applying_commit, changes 0 rows and is never clobbered.
    this.stmtBackfill = db.prepare(`
      UPDATE applied_evolutions
         SET applying_commit = @applying_commit
       WHERE proposal_id = @proposal_id
         AND applying_commit IS NULL
    `);
    const stmtBackfill = this.stmtBackfill;
    this.txBackfill = db.transaction((pairs: ReadonlyArray<BackfillPair>) => {
      let count = 0;
      for (const pair of pairs) {
        count += stmtBackfill.run(pair).changes;
      }
      return count;
    });
  }

  /**
   * Insert or update an applied-evolution record on (proposal_id).
   * Idempotent upsert: re-recording the same proposal_id UPDATEs in place
   * (never a duplicate). `apply_base_commit` / `applying_commit` are preserved
   * via COALESCE when a re-record passes null for them.
   */
  record(input: RecordAppliedEvolutionInput): void {
    this.stmtRecord.run({
      after_hash: input.after_hash,
      applied_at: input.applied_at,
      apply_base_commit: input.apply_base_commit ?? null,
      applying_commit: input.applying_commit ?? null,
      artifact_class: input.artifact_class,
      before_hash: input.before_hash,
      holdout_baseline: input.holdout_baseline,
      holdout_candidate: input.holdout_candidate,
      principle_id: input.principle_id ?? null,
      proposal_id: input.proposal_id,
      target_path: input.target_path,
    });
  }

  /**
   * Fetch the applied-evolution row for a proposal_id.
   * Returns null when no row exists (errors-are-values).
   */
  getByProposalId(proposalId: string): AppliedEvolutionRow | null {
    const row = this.stmtGetByProposalId.get(proposalId) as AppliedEvolutionDbRow | undefined;
    if (!row) return null;
    return rowToAppliedEvolutionRow(row);
  }

  /**
   * List applied evolutions whose `applied_at` is at or after the given ISO
   * timestamp, ordered by `applied_at` ASC. Used by the Inc-3 observe seam and
   * by confound detection (overlapping post-apply windows on the same signal).
   * Returns [] when nothing matches (errors-are-values).
   */
  listAppliedSince(iso: string): AppliedEvolutionRow[] {
    const rows = this.stmtListSince.all(iso) as AppliedEvolutionDbRow[];
    return rows.map(rowToAppliedEvolutionRow);
  }

  /**
   * Back-fill applying_commit from Canon-Evolution: trailers for rows still null.
   * Null-only (never clobbers a non-null value) and idempotent (re-run updates 0).
   * Wrapped in a single transaction; returns the total number of rows updated.
   */
  backfillApplyingCommit(pairs: BackfillPair[]): number {
    if (pairs.length === 0) return 0;
    return this.txBackfill(pairs);
  }
}
