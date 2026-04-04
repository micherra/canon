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

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { CANON_DIR } from "../shared/constants.ts";
import type { ReviewEntry, ReviewViolation } from "../shared/schema.ts";
import type { FlowAnalytics, FlowRunEntry } from "./drift-analytics-types.ts";
import { initDriftDb } from "./drift-schema.ts";

// Re-export WeeklyTrendPoint so callers can import from drift-db

export type WeeklyTrendPoint = {
  week: string; // ISO week: "2026-W12"
  pass_rate: number; // 0-1
  violations: number;
  reviews: number;
};

// Internal row types

type ReviewRow = {
  id: number;
  review_id: string;
  timestamp: string;
  files: string;
  honored: string;
  score: string;
  verdict: string;
  pr_number: number | null;
  branch: string | null;
  last_reviewed_sha: string | null;
  file_priorities: string | null;
  recommendations: string | null;
};

type ViolationRow = {
  id: number;
  review_id: string;
  principle_id: string;
  severity: string;
  file_path: string | null;
  impact_score: number | null;
  message: string | null;
};

type FlowRunRow = {
  id: number;
  run_id: string;
  flow: string;
  tier: string;
  task: string;
  started: string;
  completed: string;
  total_duration_ms: number;
  state_durations: string;
  state_iterations: string;
  skipped_states: string;
  total_spawns: number;
  gate_pass_rate: number | null;
  postcondition_pass_rate: number | null;
  total_violations: number | null;
  total_test_results: string | null;
  total_files_changed: number | null;
};

/**
 * Convert an ISO timestamp to ISO week string (e.g., "2026-W12").
 * Uses Thursday-based ISO 8601 week numbering.
 */
export function toISOWeek(timestamp: string): string {
  const date = new Date(timestamp);
  // ISO week: Thursday determines the year.
  // Algorithm: shift to Thursday of the current week using UTC dates to avoid
  // timezone-induced day-of-week drift for UTC midnight timestamps.
  const thursday = new Date(date);
  // Day of week (UTC): 0=Sun, 1=Mon, ..., 4=Thu, ..., 6=Sat
  const dayOfWeek = date.getUTCDay();
  // Shift to Thursday: Mon(1)->+3, Tue(2)->+2, Wed(3)->+1, Thu(4)->0, Fri(5)->-1, Sat(6)->-2, Sun(0)->-3
  // Sunday belongs to the previous ISO week, so shift back 3 days to the preceding Thursday.
  const daysToThursday = dayOfWeek === 0 ? -3 : 4 - dayOfWeek;
  thursday.setUTCDate(date.getUTCDate() + daysToThursday);

  const year = thursday.getUTCFullYear();

  // Jan 4 is always in W01 (ISO rule: W01 contains the year's first Thursday)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayOfWeek = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  // Monday of W01
  const w1Monday = new Date(jan4);
  w1Monday.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));

  // Days from W01 Monday to Thursday
  const diffMs = thursday.getTime() - w1Monday.getTime();
  const diffDays = Math.round(diffMs / 86400000);
  const weekNum = Math.floor(diffDays / 7) + 1;

  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

/** Deserialize a ReviewRow + ViolationRow[] into a ReviewEntry. */
function rowToReviewEntry(row: ReviewRow, violations: ViolationRow[]): ReviewEntry {
  const entry: ReviewEntry = {
    files: JSON.parse(row.files) as string[],
    honored: JSON.parse(row.honored) as string[],
    review_id: row.review_id,
    score: JSON.parse(row.score) as ReviewEntry["score"],
    timestamp: row.timestamp,
    verdict: row.verdict as ReviewEntry["verdict"],
    violations: violations.map((v) => {
      const violation: ReviewViolation = {
        principle_id: v.principle_id,
        severity: v.severity,
      };
      if (v.file_path !== null) violation.file_path = v.file_path;
      if (v.impact_score !== null) violation.impact_score = v.impact_score;
      if (v.message !== null) violation.message = v.message;
      return violation;
    }),
  };
  if (row.pr_number !== null) entry.pr_number = row.pr_number;
  if (row.branch !== null) entry.branch = row.branch;
  if (row.last_reviewed_sha !== null) entry.last_reviewed_sha = row.last_reviewed_sha;
  if (row.file_priorities !== null)
    entry.file_priorities = JSON.parse(row.file_priorities) as ReviewEntry["file_priorities"];
  if (row.recommendations !== null)
    entry.recommendations = JSON.parse(row.recommendations) as ReviewEntry["recommendations"];
  return entry;
}

/** Deserialize a FlowRunRow into a FlowRunEntry. */
function _rowToFlowRunEntry(row: FlowRunRow): FlowRunEntry {
  const entry: FlowRunEntry = {
    completed: row.completed,
    flow: row.flow,
    run_id: row.run_id,
    skipped_states: JSON.parse(row.skipped_states) as string[],
    started: row.started,
    state_durations: JSON.parse(row.state_durations) as Record<string, number>,
    state_iterations: JSON.parse(row.state_iterations) as Record<string, number>,
    task: row.task,
    tier: row.tier,
    total_duration_ms: row.total_duration_ms,
    total_spawns: row.total_spawns,
  };
  if (row.gate_pass_rate !== null) entry.gate_pass_rate = row.gate_pass_rate;
  if (row.postcondition_pass_rate !== null)
    entry.postcondition_pass_rate = row.postcondition_pass_rate;
  if (row.total_violations !== null) entry.total_violations = row.total_violations;
  if (row.total_test_results !== null)
    entry.total_test_results = JSON.parse(
      row.total_test_results,
    ) as FlowRunEntry["total_test_results"];
  if (row.total_files_changed !== null) entry.total_files_changed = row.total_files_changed;
  return entry;
}

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
      SELECT * FROM violations WHERE review_id = ?
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
        total_test_results, total_files_changed
      ) VALUES (
        @run_id, @flow, @tier, @task, @started, @completed, @total_duration_ms,
        @state_durations, @state_iterations, @skipped_states, @total_spawns,
        @gate_pass_rate, @postcondition_pass_rate, @total_violations,
        @total_test_results, @total_files_changed
      )
    `);

    this.stmtGetAllFlowRuns = db.prepare(`
      SELECT * FROM flow_runs ORDER BY started ASC
    `);
  }

  // Reviews

  /**
   * INSERT a ReviewEntry into the reviews table and its violations into
   * the violations table, all inside a single transaction.
   */
  appendReview(entry: ReviewEntry): void {
    const insertReviewAndViolations = this.db.transaction(() => {
      this.stmtInsertReview.run(this.buildReviewParams(entry));
      this.insertViolations(entry.review_id, entry.violations ?? []);
    });

    insertReviewAndViolations();
  }

  /** Build the parameter object for stmtInsertReview. */
  private buildReviewParams(entry: ReviewEntry): Record<string, unknown> {
    return {
      branch: entry.branch ?? null,
      file_priorities: entry.file_priorities != null ? JSON.stringify(entry.file_priorities) : null,
      files: JSON.stringify(entry.files),
      honored: JSON.stringify(entry.honored),
      last_reviewed_sha: entry.last_reviewed_sha ?? null,
      pr_number: entry.pr_number ?? null,
      recommendations: entry.recommendations != null ? JSON.stringify(entry.recommendations) : null,
      review_id: entry.review_id,
      score: JSON.stringify(entry.score),
      timestamp: entry.timestamp,
      verdict: entry.verdict,
    };
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
  getComplianceTrend(principleId: string, weeks?: number): WeeklyTrendPoint[] {
    // Build set of review_ids that have a violation for this principle
    const violationReviewIds = new Set(
      (this.stmtGetReviewIdsByPrinciple.all(principleId) as Array<{ review_id: string }>).map(
        (r) => r.review_id,
      ),
    );

    // Fetch all reviews, then filter in JS to those that either:
    // (a) have a violation for the principle, or
    // (b) have the principle in their honored JSON array
    const allRows = this.stmtGetAllReviews.all() as ReviewRow[];

    const relevant = allRows.filter((row) => {
      if (violationReviewIds.has(row.review_id)) return true;
      try {
        const honored = JSON.parse(row.honored) as string[];
        return honored.includes(principleId);
      } catch {
        return false;
      }
    });

    if (relevant.length === 0) return [];

    const weekBuckets = new Map<string, { violations: number; passes: number }>();

    for (const row of relevant) {
      const week = toISOWeek(row.timestamp);
      const bucket = weekBuckets.get(week) ?? { passes: 0, violations: 0 };

      if (violationReviewIds.has(row.review_id)) bucket.violations++;

      // A review "passes" if it honored the principle (not violated)
      try {
        const honored = JSON.parse(row.honored) as string[];
        if (honored.includes(principleId)) bucket.passes++;
      } catch {
        // ignore malformed JSON
      }

      weekBuckets.set(week, bucket);
    }

    const sorted = Array.from(weekBuckets.entries()).sort(([a], [b]) => a.localeCompare(b));
    const limited = weeks !== undefined ? sorted.slice(-weeks) : sorted;

    return limited.map(([week, data]) => {
      const total = data.violations + data.passes;
      return {
        pass_rate: total > 0 ? Math.round((data.passes / total) * 100) / 100 : 0,
        reviews: total,
        violations: data.violations,
        week,
      };
    });
  }

  // Flow runs

  /**
   * INSERT a FlowRunEntry into the flow_runs table.
   */
  appendFlowRun(entry: FlowRunEntry): void {
    this.stmtInsertFlowRun.run({
      completed: entry.completed,
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
    if (rows.length === 0) {
      return { avg_duration_ms: 0, total_runs: 0 };
    }

    let totalDuration = 0;
    let gateSum = 0;
    let gateCount = 0;
    let postconditionSum = 0;
    let postconditionCount = 0;

    for (const row of rows) {
      totalDuration += row.total_duration_ms;
      if (row.gate_pass_rate !== null) {
        gateSum += row.gate_pass_rate;
        gateCount++;
      }
      if (row.postcondition_pass_rate !== null) {
        postconditionSum += row.postcondition_pass_rate;
        postconditionCount++;
      }
    }

    const result: FlowAnalytics = {
      avg_duration_ms: totalDuration / rows.length,
      total_runs: rows.length,
    };

    if (gateCount > 0) result.avg_gate_pass_rate = gateSum / gateCount;
    if (postconditionCount > 0)
      result.avg_postcondition_pass_rate = postconditionSum / postconditionCount;

    return result;
  }

  // Lifecycle

  close(): void {
    this.db.close();
  }
}

// getDriftDb — lazy-init cache, project-scoped singleton

const cache = new Map<string, DriftDb>();

/**
 * Return a cached DriftDb for the given projectDir, opening `.canon/drift.db`
 * on first access. Thread-safe within a single Node.js process since
 * better-sqlite3 is synchronous.
 */
export function getDriftDb(projectDir: string): DriftDb {
  const key = resolve(projectDir);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const canonDir = join(key, CANON_DIR);
  mkdirSync(canonDir, { recursive: true });

  const dbPath = join(canonDir, "drift.db");
  const db = initDriftDb(dbPath);
  const store = new DriftDb(db);
  cache.set(key, store);
  return store;
}
