/**
 * Drift DB DAO — project-scoped CRUD for reviews and flow runs
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the KgStore pattern: constructor prepares statements, synchronous
 * methods, transaction wrapper. Callers never see SQL.
 */

import type { ReviewEntry } from "@shared/schema.ts";
import type Database from "better-sqlite3";
import { AreaMemoryDao } from "./area-memory-dao.ts";
import { CraftProfileDao } from "./craft-profile-dao.ts";
import type {
  ArchiveManifestEntry,
  ArchiveManifestFilter,
  DecisionEntry,
  FlowAnalytics,
  FlowRunEntry,
} from "./drift-analytics-types.ts";
import {
  computeComplianceTrend,
  computeFlowAnalytics,
  rowToFlowRunEntry,
} from "./drift-db-queries.ts";
import type {
  ArchiveRow,
  DecisionRow,
  FlowRunRow,
  ReviewRow,
  ViolationRow,
} from "./drift-db-rows.ts";
import {
  buildReviewParams,
  rowToArchiveManifestEntry,
  rowToDecisionEntry,
  rowToReviewEntry,
} from "./drift-db-rows.ts";
import { DriftDbSignals } from "./drift-db-signals.ts";
import { ViolationClosureDao } from "./violation-closure-dao.ts";

// Re-export WeeklyTrendPoint so callers can import from drift-db
export type { WeeklyTrendPoint } from "./drift-db-queries.ts";

// DriftDb

export class DriftDb {
  private readonly db: Database.Database;

  // ---- Review statements ----
  private readonly stmtInsertReview: Database.Statement;
  private readonly stmtInsertViolation: Database.Statement;
  private readonly stmtGetAllReviews: Database.Statement;
  private readonly stmtGetReviewsByBranch: Database.Statement;
  private readonly stmtGetReviewsByPr: Database.Statement;
  private readonly stmtGetReviewsByBranchAndPr: Database.Statement;
  private readonly stmtGetViolationsByReviewId: Database.Statement;
  private readonly stmtGetReviewIdsByPrinciple: Database.Statement;
  private readonly stmtGetLastReviewForPr: Database.Statement;
  private readonly stmtGetLastReviewForBranch: Database.Statement;

  // ---- Flow run statements ----
  private readonly stmtInsertFlowRun: Database.Statement;
  private readonly stmtGetAllFlowRuns: Database.Statement;
  private readonly stmtCountFlowRunsSince: Database.Statement;
  private readonly stmtGetLastFlowRunCompletedAt: Database.Statement;

  // ---- Decision statements ----
  private readonly stmtInsertDecision: Database.Statement;
  private readonly stmtGetDecisionsByRun: Database.Statement;
  private readonly stmtGetRecentDecisions: Database.Statement;

  // ---- Archive manifest statements ----
  private readonly stmtInsertArchive: Database.Statement;
  private readonly stmtGetArchiveById: Database.Statement;
  private readonly stmtCountArchives: Database.Statement;

  // ---- Signal DAO (lazy) ----
  private _signals: DriftDbSignals | null = null;

  // ---- Area Memory DAO (lazy) ----
  private _areaMemory: AreaMemoryDao | null = null;

  // ---- Craft Profiles DAO (lazy) ----
  private _craftProfiles: CraftProfileDao | null = null;

  // ---- Violation Closure DAO (lazy) ----
  private _closures: ViolationClosureDao | null = null;

  constructor(db: Database.Database) {
    this.db = db;

    // Reviews
    this.stmtInsertReview = db.prepare(`
      INSERT INTO reviews (
        review_id, timestamp, files, honored, score, verdict,
        pr_number, branch, last_reviewed_sha, file_priorities, recommendations
      ) VALUES (
        @review_id, @timestamp, @files, @honored, @score, @verdict,
        @pr_number, @branch, @last_reviewed_sha, @file_priorities, @recommendations
      )
    `);

    this.stmtInsertViolation = db.prepare(`
      INSERT INTO violations (review_id, principle_id, severity, file_path, impact_score, message)
      VALUES (@review_id, @principle_id, @severity, @file_path, @impact_score, @message)
    `);

    this.stmtGetAllReviews = db.prepare(`
      SELECT * FROM reviews ORDER BY timestamp ASC
    `);

    this.stmtGetReviewsByBranch = db.prepare(`
      SELECT * FROM reviews WHERE branch = ? ORDER BY timestamp ASC
    `);

    this.stmtGetReviewsByPr = db.prepare(`
      SELECT * FROM reviews WHERE pr_number = ? ORDER BY timestamp ASC
    `);

    this.stmtGetReviewsByBranchAndPr = db.prepare(`
      SELECT * FROM reviews WHERE branch = ? AND pr_number = ? ORDER BY timestamp ASC
    `);

    this.stmtGetViolationsByReviewId = db.prepare(`
      SELECT * FROM violations WHERE review_id = ? AND status = 'open'
    `);

    // For principleId filtering: get review_ids that have a matching violation
    // OR have the principle in their honored JSON array.
    // We handle the JSON honored-array filter in JS after fetching candidate rows.
    this.stmtGetReviewIdsByPrinciple = db.prepare(`
      SELECT DISTINCT review_id FROM violations WHERE principle_id = ?
    `);

    this.stmtGetLastReviewForPr = db.prepare(`
      SELECT * FROM reviews WHERE pr_number = ? ORDER BY timestamp DESC LIMIT 1
    `);

    this.stmtGetLastReviewForBranch = db.prepare(`
      SELECT * FROM reviews WHERE branch = ? ORDER BY timestamp DESC LIMIT 1
    `);

    // Flow runs
    this.stmtInsertFlowRun = db.prepare(`
      INSERT INTO flow_runs (
        run_id, flow, tier, task, started, completed, total_duration_ms,
        state_durations, state_iterations, skipped_states, total_spawns,
        gate_pass_rate, postcondition_pass_rate, total_violations,
        total_test_results, total_files_changed, commits, diff_stat
      ) VALUES (
        @run_id, @flow, @tier, @task, @started, @completed, @total_duration_ms,
        @state_durations, @state_iterations, @skipped_states, @total_spawns,
        @gate_pass_rate, @postcondition_pass_rate, @total_violations,
        @total_test_results, @total_files_changed, @commits, @diff_stat
      )
    `);

    this.stmtGetAllFlowRuns = db.prepare(`
      SELECT * FROM flow_runs ORDER BY started ASC
    `);

    this.stmtCountFlowRunsSince = db.prepare(`
      SELECT COUNT(*) as count FROM flow_runs WHERE completed > ?
    `);

    this.stmtGetLastFlowRunCompletedAt = db.prepare(`
      SELECT completed FROM flow_runs ORDER BY completed DESC LIMIT 1
    `);

    // Decisions
    this.stmtInsertDecision = db.prepare(`
      INSERT OR IGNORE INTO decisions (
        decision_id, run_id, flow, task, title, content, file_path, timestamp
      ) VALUES (
        @decision_id, @run_id, @flow, @task, @title, @content, @file_path, @timestamp
      )
    `);

    this.stmtGetDecisionsByRun = db.prepare(
      `SELECT * FROM decisions WHERE run_id = ? ORDER BY timestamp ASC`,
    );

    this.stmtGetRecentDecisions = db.prepare(
      `SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?`,
    );

    // Archive manifests
    this.stmtInsertArchive = db.prepare(`
      INSERT INTO build_archives (
        archive_id, branch, sanitized_branch, slug, flow, tier, task,
        archived_at, archive_path, artifact_types, has_run_summary, source_run_id
      ) VALUES (
        @archive_id, @branch, @sanitized_branch, @slug, @flow, @tier, @task,
        @archived_at, @archive_path, @artifact_types, @has_run_summary, @source_run_id
      )
    `);

    this.stmtGetArchiveById = db.prepare(`SELECT * FROM build_archives WHERE archive_id = ?`);

    this.stmtCountArchives = db.prepare(`SELECT COUNT(*) as count FROM build_archives`);
  }

  // Reviews

  /**
   * INSERT a ReviewEntry into the reviews table and its violations into
   * the violations table, all inside a single transaction.
   */
  appendReview(entry: ReviewEntry): void {
    const closures = this.getClosures();
    const insertReviewAndViolations = this.db.transaction(() => {
      this.stmtInsertReview.run(buildReviewParams(entry));
      this.insertViolations(entry.review_id, entry.violations ?? []);
      closures.supersedeOpenViolations({
        files: entry.files,
        honored: entry.honored ?? [],
        recordedViolations: entry.violations ?? [],
        reviewId: entry.review_id,
        timestamp: entry.timestamp,
      });
    });
    insertReviewAndViolations();
  }

  /** Insert violation rows for a review. */
  private insertViolations(reviewId: string, violations: ReviewEntry["violations"]): void {
    for (const v of violations ?? []) {
      this.stmtInsertViolation.run({
        file_path: v.file_path ?? null,
        impact_score: v.impact_score ?? null,
        message: v.message ?? null,
        principle_id: v.principle_id,
        review_id: reviewId,
        severity: v.severity,
      });
    }
  }

  /**
   * Fetch reviews with optional AND-filters: principleId, branch, prNumber.
   * Returns ReviewEntry[] with violations reconstituted from violations table.
   * Returns empty array when no reviews exist (define-errors-out-of-existence).
   */
  getReviews(options?: {
    principleId?: string;
    branch?: string;
    prNumber?: number;
  }): ReviewEntry[] {
    const { principleId, branch, prNumber } = options ?? {};

    let rows: ReviewRow[];

    if (branch !== undefined && prNumber !== undefined) {
      rows = this.stmtGetReviewsByBranchAndPr.all(branch, prNumber) as ReviewRow[];
    } else if (branch !== undefined) {
      rows = this.stmtGetReviewsByBranch.all(branch) as ReviewRow[];
    } else if (prNumber !== undefined) {
      rows = this.stmtGetReviewsByPr.all(prNumber) as ReviewRow[];
    } else {
      rows = this.stmtGetAllReviews.all() as ReviewRow[];
    }

    // Apply principleId filter: keep rows that either have a matching violation
    // or have the principle in their honored JSON array.
    if (principleId !== undefined) {
      rows = this.filterByPrincipleId(rows, principleId);
    }

    // Reconstitute violations for each review row
    return rows.map((row) => {
      const violations = this.stmtGetViolationsByReviewId.all(row.review_id) as ViolationRow[];
      return rowToReviewEntry(row, violations);
    });
  }

  /** Filter review rows to those matching a principle ID (via violation or honored list). */
  private filterByPrincipleId(rows: ReviewRow[], principleId: string): ReviewRow[] {
    const violationReviewIds = new Set(
      (this.stmtGetReviewIdsByPrinciple.all(principleId) as Array<{ review_id: string }>).map(
        (r) => r.review_id,
      ),
    );
    return rows.filter((row) => {
      if (violationReviewIds.has(row.review_id)) return true;
      try {
        const honored = JSON.parse(row.honored) as string[];
        return honored.includes(principleId);
      } catch {
        // Malformed JSON in honored column — exclude row from results
        return false;
      }
    });
  }

  /**
   * Returns reviews whose `files` array contains at least one of the specified
   * file paths. Uses client-side filtering because the reviews table is small
   * (typically <100 rows) and the files column is stored as a JSON array string.
   *
   * Returns empty array for empty input (define-errors-out-of-existence).
   */
  getReviewsByFiles(filePaths: string[]): ReviewEntry[] {
    if (filePaths.length === 0) {
      return [];
    }

    const allRows = this.stmtGetAllReviews.all() as ReviewRow[];
    const fileSet = new Set(filePaths);
    const matching: ReviewEntry[] = [];

    for (const row of allRows) {
      try {
        const reviewFiles = JSON.parse(row.files) as string[];
        if (reviewFiles.some((f) => fileSet.has(f))) {
          const violations = this.stmtGetViolationsByReviewId.all(row.review_id) as ViolationRow[];
          matching.push(rowToReviewEntry(row, violations));
        }
      } catch {
        // Skip reviews with malformed files JSON
      }
    }

    return matching;
  }

  /**
   * Returns the most recent review for a given PR number, or null if none exists.
   */
  getLastReviewForPr(prNumber: number): ReviewEntry | null {
    const row = this.stmtGetLastReviewForPr.get(prNumber) as ReviewRow | undefined;
    if (!row) return null;
    const violations = this.stmtGetViolationsByReviewId.all(row.review_id) as ViolationRow[];
    return rowToReviewEntry(row, violations);
  }

  /**
   * Returns the most recent review for a given branch, or null if none exists.
   */
  getLastReviewForBranch(branch: string): ReviewEntry | null {
    const row = this.stmtGetLastReviewForBranch.get(branch) as ReviewRow | undefined;
    if (!row) return null;
    const violations = this.stmtGetViolationsByReviewId.all(row.review_id) as ViolationRow[];
    return rowToReviewEntry(row, violations);
  }

  /**
   * Compute weekly compliance trend for a principle.
   * Groups reviews by ISO week and computes pass rate per bucket.
   * Optionally limits results to the most recent N weeks.
   */
  getComplianceTrend(
    principleId: string,
    weeks?: number,
  ): import("./drift-db-queries.ts").WeeklyTrendPoint[] {
    const violationReviewIds = new Set(
      (this.stmtGetReviewIdsByPrinciple.all(principleId) as Array<{ review_id: string }>).map(
        (r) => r.review_id,
      ),
    );
    const allRows = this.stmtGetAllReviews.all() as ReviewRow[];
    return computeComplianceTrend(allRows, violationReviewIds, principleId, weeks);
  }

  // Flow runs

  /**
   * INSERT a FlowRunEntry into the flow_runs table.
   */
  appendFlowRun(entry: FlowRunEntry): void {
    this.stmtInsertFlowRun.run({
      commits: entry.commits != null ? JSON.stringify(entry.commits) : null,
      completed: entry.completed,
      diff_stat: entry.diff_stat ?? null,
      flow: entry.flow,
      gate_pass_rate: entry.gate_pass_rate ?? null,
      postcondition_pass_rate: entry.postcondition_pass_rate ?? null,
      run_id: entry.run_id,
      skipped_states: JSON.stringify(entry.skipped_states),
      started: entry.started,
      state_durations: JSON.stringify(entry.state_durations),
      state_iterations: JSON.stringify(entry.state_iterations),
      task: entry.task,
      tier: entry.tier,
      total_duration_ms: entry.total_duration_ms,
      total_files_changed: entry.total_files_changed ?? null,
      total_spawns: entry.total_spawns,
      total_test_results:
        entry.total_test_results != null ? JSON.stringify(entry.total_test_results) : null,
      total_violations: entry.total_violations ?? null,
    });
  }

  /**
   * Aggregate analytics across all flow runs.
   * Returns { total_runs: 0, avg_duration_ms: 0 } for empty DB
   * (define-errors-out-of-existence).
   */
  computeAnalytics(): FlowAnalytics {
    const rows = this.stmtGetAllFlowRuns.all() as FlowRunRow[];
    return computeFlowAnalytics(rows);
  }

  /**
   * Count flow runs completed after the given ISO timestamp.
   * Returns 0 for empty DB (define-errors-out-of-existence).
   */
  countFlowRunsSince(sinceIso: string): number {
    const row = this.stmtCountFlowRunsSince.get(sinceIso) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Return the ISO timestamp of the most recently completed flow run, or null if none.
   */
  getLastFlowRunCompletedAt(): string | null {
    const row = this.stmtGetLastFlowRunCompletedAt.get() as { completed: string } | undefined;
    return row?.completed ?? null;
  }

  // Decisions

  /**
   * INSERT a DecisionEntry into the decisions table.
   * Uses INSERT OR IGNORE — duplicate decision_id is a no-op (idempotent).
   * (no-silent-failures: the duplicate is intentional, not an error)
   */
  appendDecision(entry: DecisionEntry): void {
    this.stmtInsertDecision.run({
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
  getDecisionsByRun(runId: string): DecisionEntry[] {
    const rows = this.stmtGetDecisionsByRun.all(runId) as DecisionRow[];
    return rows.map(rowToDecisionEntry);
  }

  /**
   * Fetch the most recent N decisions across all runs, ordered by timestamp DESC.
   * Returns empty array when no decisions exist (define-errors-out-of-existence).
   */
  getRecentDecisions(limit: number): DecisionEntry[] {
    const rows = this.stmtGetRecentDecisions.all(limit) as DecisionRow[];
    return rows.map(rowToDecisionEntry);
  }

  /**
   * Return all flow runs (no filter, ascending start order from SQL).
   * Used by get_history for full-table queries before in-memory sort/filter.
   * Returns empty array when DB is empty (define-errors-out-of-existence).
   */
  getAllFlowRuns(): FlowRunEntry[] {
    const rows = this.stmtGetAllFlowRuns.all() as FlowRunRow[];
    return rows.map(rowToFlowRunEntry);
  }

  // Archive manifests

  /**
   * INSERT an ArchiveManifestEntry into the build_archives table.
   * Throws on duplicate archive_id (UNIQUE constraint violation).
   */
  appendArchiveManifest(entry: ArchiveManifestEntry): void {
    this.stmtInsertArchive.run({
      archive_id: entry.archive_id,
      archive_path: entry.archive_path,
      archived_at: entry.archived_at,
      artifact_types: JSON.stringify(entry.artifact_types),
      branch: entry.branch,
      flow: entry.flow,
      has_run_summary: entry.has_run_summary ? 1 : 0,
      sanitized_branch: entry.sanitized_branch,
      slug: entry.slug,
      source_run_id: entry.source_run_id ?? null,
      task: entry.task,
      tier: entry.tier,
    });
  }

  /**
   * Fetch archive manifests with optional filters: branch, flow, limit.
   * Results are ordered by archived_at DESC.
   * Returns empty array when no archives exist (define-errors-out-of-existence).
   */
  getArchiveManifests(filter?: ArchiveManifestFilter): ArchiveManifestEntry[] {
    const { branch, flow, limit } = filter ?? {};

    // Build the query dynamically based on provided filters
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (branch !== undefined) {
      conditions.push("branch = ?");
      params.push(branch);
    }
    if (flow !== undefined) {
      conditions.push("flow = ?");
      params.push(flow);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = limit !== undefined ? `LIMIT ${Math.max(0, limit)}` : "";
    const sql =
      `SELECT * FROM build_archives ${where} ORDER BY archived_at DESC ${limitClause}`.trim();

    const rows = this.db.prepare(sql).all(...params) as ArchiveRow[];
    return rows.map(rowToArchiveManifestEntry);
  }

  /**
   * Fetch a single archive by archive_id.
   * Returns null when not found (define-errors-out-of-existence).
   */
  getArchiveById(archiveId: string): ArchiveManifestEntry | null {
    const row = this.stmtGetArchiveById.get(archiveId) as ArchiveRow | undefined;
    if (!row) return null;
    return rowToArchiveManifestEntry(row);
  }

  /**
   * Count total archives in the build_archives table.
   * Returns 0 when empty (define-errors-out-of-existence).
   */
  countArchives(): number {
    const row = this.stmtCountArchives.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  // Signals

  /**
   * Lazy accessor for signal-related DAO methods.
   * The DriftDbSignals class operates on the same Database.Database handle.
   * Returns the same instance on repeated calls (lazy singleton).
   */
  getSignals(): DriftDbSignals {
    if (this._signals === null) {
      this._signals = new DriftDbSignals(this.db);
    }
    return this._signals;
  }

  /**
   * Lazy accessor for area memory DAO methods.
   * The AreaMemoryDao class operates on the same Database.Database handle.
   * Returns the same instance on repeated calls (lazy singleton).
   */
  getAreaMemory(): AreaMemoryDao {
    if (this._areaMemory === null) {
      this._areaMemory = new AreaMemoryDao(this.db);
    }
    return this._areaMemory;
  }

  /**
   * Lazy accessor for craft profile DAO methods.
   * The CraftProfileDao class operates on the same Database.Database handle.
   * Returns the same instance on repeated calls (lazy singleton).
   */
  getCraftProfiles(): CraftProfileDao {
    if (this._craftProfiles === null) {
      this._craftProfiles = new CraftProfileDao(this.db);
    }
    return this._craftProfiles;
  }

  /**
   * Lazy accessor for violation closure DAO methods.
   * The ViolationClosureDao class operates on the same Database.Database handle.
   * Returns the same instance on repeated calls (lazy singleton).
   */
  getClosures(): ViolationClosureDao {
    if (this._closures === null) {
      this._closures = new ViolationClosureDao(this.db);
    }
    return this._closures;
  }

  // Lifecycle

  close(): void {
    this.db.close();
  }
}
