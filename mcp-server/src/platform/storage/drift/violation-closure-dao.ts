/**
 * ViolationClosureDao — owns all closure SQL for the violations table.
 *
 * Extracted from drift-db.ts into a dedicated file because drift-db.ts is at
 * 576/600 lines (forced split per refactoring-integrity / line-budget principle).
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync, no Promises).
 *
 * Obtain via DriftDb.getClosures() in production code.
 * In tests: construct directly with an initDriftDb(":memory:") handle.
 *
 * Canon principles applied:
 * - simplicity-first: one column set, one DAO file; statements prepared once
 * - define-errors-out-of-existence: empty inputs → zero counts, never errors
 * - errors-are-values: methods return counts/rows, never throw for expected conditions
 */

import type Database from "better-sqlite3";
import type { ViolationRow } from "./drift-db-rows.ts";

// ---- Types ----

/**
 * A (file_path, principle_id) pair identifying a stale violation to resolve.
 * file_path: null indicates a process-level (non-file) violation.
 */
export type StaleViolationSpec = {
  file_path: string | null;
  principle_id: string;
};

/**
 * Options for supersedeOpenViolations.
 * Grouped into an options object so the function stays within the 4-param limit.
 */
export type SupersedeOptions = {
  reviewId: string;
  files: string[];
  honored: string[];
  recordedViolations: ReadonlyArray<{ principle_id: string; file_path?: string | null }>;
  timestamp: string;
};

/** Resolution counts returned by resolveViolationsByPairs. */
export type ResolutionCounts = {
  resolved_count: number;
  already_resolved_count: number;
};

/**
 * Candidate open violation row fetched for superseding logic.
 * Only the columns needed for the JS-side resolution predicate.
 */
type OpenViolationCandidate = {
  id: number;
  principle_id: string;
  file_path: string | null;
};

// ---- DAO Class ----

/**
 * DAO for violation lifecycle operations (status transitions).
 *
 * Resolution is always UPDATE-based — never DELETE.
 * Resolved rows are retained for history/audit queries.
 */
export class ViolationClosureDao {
  // Prepared statements
  private readonly stmtGetOpenCandidates: Database.Statement;
  private readonly stmtResolveById: Database.Statement;
  private readonly stmtGetOpenBySpec: Database.Statement;
  private readonly stmtGetResolvedBySpec: Database.Statement;
  private readonly stmtGetOpenBySpecNullFile: Database.Statement;
  private readonly stmtGetResolvedBySpecNullFile: Database.Statement;
  private readonly stmtGetViolationsOpen: Database.Statement;
  private readonly stmtGetViolationsAll: Database.Statement;
  private readonly stmtCountOpen: Database.Statement;
  private readonly stmtGetOpenReviewIdsByPrinciple: Database.Statement;

  // Transactions — wrapped at construction time
  private readonly txResolveByIds: (
    ids: number[],
    reviewId: string,
    timestamp: string,
    reason: string,
  ) => number;
  private readonly txResolveByPairs: (
    specs: ReadonlyArray<StaleViolationSpec>,
    reason: string,
    timestamp: string,
  ) => ResolutionCounts;

  constructor(db: Database.Database) {
    this.stmtGetOpenCandidates = db.prepare(`
      SELECT id, principle_id, file_path
      FROM violations
      WHERE status = 'open'
    `);
    this.stmtResolveById = db.prepare(`
      UPDATE violations
      SET status = 'resolved', resolved_at = @ts, resolved_by_review_id = @rid, resolution_reason = @reason
      WHERE id = @id AND status = 'open'
    `);
    this.stmtGetOpenBySpec = db.prepare(`
      SELECT id FROM violations
      WHERE status = 'open' AND principle_id = @principle_id AND file_path = @file_path
    `);
    this.stmtGetResolvedBySpec = db.prepare(`
      SELECT id FROM violations
      WHERE status = 'resolved' AND principle_id = @principle_id AND file_path = @file_path
    `);
    this.stmtGetOpenBySpecNullFile = db.prepare(`
      SELECT id FROM violations
      WHERE status = 'open' AND principle_id = @principle_id AND file_path IS NULL
    `);
    this.stmtGetResolvedBySpecNullFile = db.prepare(`
      SELECT id FROM violations
      WHERE status = 'resolved' AND principle_id = @principle_id AND file_path IS NULL
    `);
    this.stmtGetViolationsOpen = db.prepare(`
      SELECT id, review_id, principle_id, severity, file_path, impact_score, message,
             status, resolved_at, resolved_by_review_id, resolution_reason
      FROM violations WHERE review_id = ? AND status = 'open'
    `);
    this.stmtGetViolationsAll = db.prepare(`
      SELECT id, review_id, principle_id, severity, file_path, impact_score, message,
             status, resolved_at, resolved_by_review_id, resolution_reason
      FROM violations WHERE review_id = ?
    `);
    this.stmtCountOpen = db.prepare(`SELECT COUNT(*) AS c FROM violations WHERE status = 'open'`);
    this.stmtGetOpenReviewIdsByPrinciple = db.prepare(
      `SELECT DISTINCT review_id FROM violations WHERE principle_id = ? AND status = 'open'`,
    );

    this.txResolveByIds = this.buildTxResolveByIds(db);
    this.txResolveByPairs = this.buildTxResolveByPairs(db);
  }

  // ---- Private transaction builders ----

  private buildTxResolveByIds(
    db: Database.Database,
  ): (ids: number[], reviewId: string, timestamp: string, reason: string) => number {
    const stmt = this.stmtResolveById;
    return db.transaction((ids: number[], reviewId: string, timestamp: string, reason: string) => {
      let count = 0;
      for (const id of ids) {
        const result = stmt.run({ id, reason, rid: reviewId, ts: timestamp });
        count += result.changes;
      }
      return count;
    });
  }

  private buildTxResolveByPairs(
    db: Database.Database,
  ): (
    specs: ReadonlyArray<StaleViolationSpec>,
    reason: string,
    timestamp: string,
  ) => ResolutionCounts {
    const stmtOpenFile = this.stmtGetOpenBySpec;
    const stmtOpenNull = this.stmtGetOpenBySpecNullFile;
    const stmtResolvedFile = this.stmtGetResolvedBySpec;
    const stmtResolvedNull = this.stmtGetResolvedBySpecNullFile;
    const stmtResolve = this.stmtResolveById;
    return db.transaction(
      (
        specs: ReadonlyArray<StaleViolationSpec>,
        reason: string,
        timestamp: string,
      ): ResolutionCounts => {
        let resolved_count = 0;
        let already_resolved_count = 0;
        for (const spec of specs) {
          const counts = resolveSpec(spec, {
            reason,
            stmtOpenFile,
            stmtOpenNull,
            stmtResolve,
            stmtResolvedFile,
            stmtResolvedNull,
            timestamp,
          });
          resolved_count += counts.resolved_count;
          already_resolved_count += counts.already_resolved_count;
        }
        return { already_resolved_count, resolved_count };
      },
    );
  }

  // ---- Public methods ----

  /**
   * Resolve OPEN violations superseded by a clean review result.
   *
   * A violation (file_path, principle_id) is superseded when:
   * - File violations: file_path ∈ files AND principle_id ∈ honored AND the new review
   *   did NOT record a violation for the same (file_path, principle_id).
   * - Process violations (file_path=null): principle_id ∈ honored AND the new review
   *   did NOT record any violation for that principle_id.
   *
   * Only touches rows with status='open' (idempotent). Returns transition count.
   * define-errors-out-of-existence: empty honored → 0, never an error.
   */
  supersedeOpenViolations(opts: SupersedeOptions): number {
    const { reviewId, files, honored, recordedViolations, timestamp } = opts;
    if (honored.length === 0) return 0;

    const lookup = buildSupersedeLookups(files, honored, recordedViolations);
    const candidates = this.stmtGetOpenCandidates.all() as OpenViolationCandidate[];
    const toResolveIds = filterCandidates(candidates, lookup);

    if (toResolveIds.length === 0) return 0;
    return this.txResolveByIds(toResolveIds, reviewId, timestamp, "superseded-by-clean-review");
  }

  /**
   * Resolve OPEN violations matching a set of (file_path, principle_id) specs.
   *
   * Used for idempotent backfill of known-stale violations (closure-03).
   * Empty specs → { resolved_count: 0, already_resolved_count: 0 } (no error).
   * Idempotent: a second call on already-resolved pairs returns resolved_count=0.
   */
  resolveViolationsByPairs(
    specs: ReadonlyArray<StaleViolationSpec>,
    reason: string,
    timestamp: string,
  ): ResolutionCounts {
    if (specs.length === 0) return { already_resolved_count: 0, resolved_count: 0 };
    return this.txResolveByPairs(specs, reason, timestamp);
  }

  /**
   * Status-aware read of violations for a specific review.
   *
   * Default (includeResolved falsy): returns only open violations.
   * includeResolved: true: returns all violations regardless of status.
   * Returns empty array for unknown reviewId (define-errors-out-of-existence).
   */
  getViolationsByReviewId(reviewId: string, opts?: { includeResolved?: boolean }): ViolationRow[] {
    if (opts?.includeResolved) {
      return this.stmtGetViolationsAll.all(reviewId) as ViolationRow[];
    }
    return this.stmtGetViolationsOpen.all(reviewId) as ViolationRow[];
  }

  /**
   * Count of all open violations (status='open').
   * Convenience method for tests and audit scripts.
   */
  countOpenViolations(): number {
    const row = this.stmtCountOpen.get() as { c: number };
    return row.c;
  }

  /**
   * Return review IDs that have at least one OPEN violation for a principle.
   *
   * Used by getComplianceTrend to build the violation set for the weekly
   * trend metric. Excludes resolved violations so that a resolved principle
   * does not continue to depress the trend (consistency with getCompliance's
   * open-only violation count — closure-02 / Codex P2 fix).
   *
   * Returns a Set for O(1) membership tests in the trend computation loop.
   */
  getOpenReviewIdsByPrinciple(principleId: string): Set<string> {
    const rows = this.stmtGetOpenReviewIdsByPrinciple.all(principleId) as Array<{
      review_id: string;
    }>;
    return new Set(rows.map((r) => r.review_id));
  }
}

// ---- Module-level pure helpers (reduce method complexity) ----

/** Lookups pre-built for the superseding predicate check. */
type SupersedeLookups = {
  honoredSet: Set<string>;
  filesSet: Set<string>;
  recordedByPrincipleFile: Set<string>;
  recordedByPrincipleOnly: Set<string>;
};

function buildSupersedeLookups(
  files: string[],
  honored: string[],
  recordedViolations: ReadonlyArray<{ principle_id: string; file_path?: string | null }>,
): SupersedeLookups {
  const honoredSet = new Set(honored);
  const filesSet = new Set(files);
  const recordedByPrincipleFile = new Set<string>();
  const recordedByPrincipleOnly = new Set<string>();
  for (const rv of recordedViolations) {
    const fp = rv.file_path ?? null;
    recordedByPrincipleFile.add(`${rv.principle_id}\0${fp}`);
    recordedByPrincipleOnly.add(rv.principle_id);
  }
  return { filesSet, honoredSet, recordedByPrincipleFile, recordedByPrincipleOnly };
}

/** Returns true when the candidate meets the superseding predicate. */
function shouldSupersede(candidate: OpenViolationCandidate, lookup: SupersedeLookups): boolean {
  const { filesSet, honoredSet, recordedByPrincipleFile, recordedByPrincipleOnly } = lookup;
  const { file_path, principle_id } = candidate;
  if (!honoredSet.has(principle_id)) return false;
  if (file_path === null) {
    return !recordedByPrincipleOnly.has(principle_id);
  }
  if (!filesSet.has(file_path)) return false;
  return (
    !recordedByPrincipleFile.has(`${principle_id}\0${file_path}`) &&
    !recordedByPrincipleFile.has(`${principle_id}\0null`)
  );
}

function filterCandidates(
  candidates: OpenViolationCandidate[],
  lookup: SupersedeLookups,
): number[] {
  const toResolveIds: number[] = [];
  for (const candidate of candidates) {
    if (shouldSupersede(candidate, lookup)) toResolveIds.push(candidate.id);
  }
  return toResolveIds;
}

/** Context passed into resolveSpec for one spec in the txResolveByPairs transaction. */
type ResolveSpecCtx = {
  stmtOpenFile: Database.Statement;
  stmtOpenNull: Database.Statement;
  stmtResolvedFile: Database.Statement;
  stmtResolvedNull: Database.Statement;
  stmtResolve: Database.Statement;
  reason: string;
  timestamp: string;
};

function resolveSpec(spec: StaleViolationSpec, ctx: ResolveSpecCtx): ResolutionCounts {
  const {
    stmtOpenFile,
    stmtOpenNull,
    stmtResolvedFile,
    stmtResolvedNull,
    stmtResolve,
    reason,
    timestamp,
  } = ctx;
  let resolved_count = 0;
  let already_resolved_count = 0;

  if (spec.file_path === null) {
    const openRows = stmtOpenNull.all({ principle_id: spec.principle_id }) as Array<{ id: number }>;
    const resolvedRows = stmtResolvedNull.all({ principle_id: spec.principle_id }) as Array<{
      id: number;
    }>;
    already_resolved_count += resolvedRows.length;
    for (const row of openRows) {
      resolved_count += stmtResolve.run({ id: row.id, reason, rid: null, ts: timestamp }).changes;
    }
  } else {
    const params = { file_path: spec.file_path, principle_id: spec.principle_id };
    const openRows = stmtOpenFile.all(params) as Array<{ id: number }>;
    const resolvedRows = stmtResolvedFile.all(params) as Array<{ id: number }>;
    already_resolved_count += resolvedRows.length;
    for (const row of openRows) {
      resolved_count += stmtResolve.run({ id: row.id, reason, rid: null, ts: timestamp }).changes;
    }
  }

  return { already_resolved_count, resolved_count };
}
