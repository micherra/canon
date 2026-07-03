/**
 * ActiveWorkspacesDao — project-level active-build discovery registry
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v12 migration table: active_workspaces.
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the CliffEventsDao pattern: constructor prepares statements,
 * synchronous methods, callers never see SQL.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty table → []; absent row → null; mark* on absent row → no-op
 * - reuse-before-rebuild: additive table in the existing project-level drift.db
 * - fail-closed-by-default: allowed-status enum is enforced here (DAO write layer),
 *   not by a SQLite CHECK — see decision registry-store-location-02.md decision 1
 */

import type Database from "better-sqlite3";

// ---- Status constant + derived union ----

export type ActiveWorkspaceStatus = "live" | "finalized_on_disk" | "reaped";

// ---- Public types ----

/** A row from the active_workspaces table. One row per workspace_path (the identity). */
export type ActiveWorkspaceRow = {
  workspace_path: string;
  slug: string;
  session_id: string | null;
  job_id: string | null;
  base_commit: string | null;
  status: ActiveWorkspaceStatus;
  started_at: string; // ISO-8601
  last_seen: string; // ISO-8601
  finalized_at: string | null; // ISO-8601
};

/** Input for registering (inserting or resume-touching) a workspace. */
export type RegisterInput = {
  workspace_path: string;
  slug: string;
  session_id?: string;
  job_id?: string;
  base_commit?: string;
};

// ---- Raw DB row type ----

type ActiveWorkspaceDbRow = {
  workspace_path: string;
  slug: string;
  session_id: string | null;
  job_id: string | null;
  base_commit: string | null;
  status: string;
  started_at: string;
  last_seen: string;
  finalized_at: string | null;
};

// ---- Row deserializer ----

/** Convert a raw SQLite row to an ActiveWorkspaceRow. */
function rowToActiveWorkspaceRow(row: ActiveWorkspaceDbRow): ActiveWorkspaceRow {
  return {
    base_commit: row.base_commit,
    finalized_at: row.finalized_at,
    job_id: row.job_id,
    last_seen: row.last_seen,
    session_id: row.session_id,
    slug: row.slug,
    started_at: row.started_at,
    status: row.status as ActiveWorkspaceStatus,
    workspace_path: row.workspace_path,
  };
}

// ---- DAO Class ----

/**
 * DAO for the active_workspaces table added in drift schema v12.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getActiveWorkspaces() in production code.
 */
export class ActiveWorkspacesDao {
  private readonly stmtRegister: Database.Statement;
  private readonly stmtMarkFinalized: Database.Statement;
  private readonly stmtMarkReaped: Database.Statement;
  private readonly stmtGetByPath: Database.Statement;
  private readonly stmtListAll: Database.Statement;
  private readonly stmtListByStatus: Database.Statement;

  constructor(db: Database.Database) {
    // Upsert on workspace_path (the identity):
    // - insert -> status='live', started_at=last_seen=@now
    // - conflict -> status='live', last_seen=@now, finalized_at=NULL (resume/re-register touch,
    //   clears any stale finalized_at from a prior finalize/reap so a reactivated row never
    //   carries contradictory lifecycle data — Codex P2, PR #450);
    //   started_at is preserved (never overwritten on conflict)
    this.stmtRegister = db.prepare(`
      INSERT INTO active_workspaces (
        workspace_path, slug, session_id, job_id, base_commit,
        status, started_at, last_seen, finalized_at
      ) VALUES (
        @workspace_path, @slug, @session_id, @job_id, @base_commit,
        'live', @now, @now, NULL
      )
      ON CONFLICT(workspace_path) DO UPDATE SET
        slug         = excluded.slug,
        session_id   = excluded.session_id,
        job_id       = excluded.job_id,
        base_commit  = excluded.base_commit,
        status       = 'live',
        last_seen    = excluded.last_seen,
        finalized_at = NULL
    `);

    this.stmtMarkFinalized = db.prepare(`
      UPDATE active_workspaces
      SET status = 'finalized_on_disk', finalized_at = @now
      WHERE workspace_path = @workspace_path
    `);

    this.stmtMarkReaped = db.prepare(`
      UPDATE active_workspaces
      SET status = 'reaped', last_seen = @now
      WHERE workspace_path = @workspace_path
    `);

    this.stmtGetByPath = db.prepare(`
      SELECT workspace_path, slug, session_id, job_id, base_commit,
             status, started_at, last_seen, finalized_at
      FROM active_workspaces
      WHERE workspace_path = ?
    `);

    this.stmtListAll = db.prepare(`
      SELECT workspace_path, slug, session_id, job_id, base_commit,
             status, started_at, last_seen, finalized_at
      FROM active_workspaces
      ORDER BY started_at DESC
    `);

    this.stmtListByStatus = db.prepare(`
      SELECT workspace_path, slug, session_id, job_id, base_commit,
             status, started_at, last_seen, finalized_at
      FROM active_workspaces
      WHERE status = ?
      ORDER BY started_at DESC
    `);
  }

  /**
   * Register a workspace as live: insert on first registration, or touch
   * last_seen (and flip status back to 'live') on re-registration/resume.
   * started_at is set once on insert and never overwritten on conflict.
   */
  register(input: RegisterInput): void {
    const now = new Date().toISOString();
    this.stmtRegister.run({
      base_commit: input.base_commit ?? null,
      job_id: input.job_id ?? null,
      now,
      session_id: input.session_id ?? null,
      slug: input.slug,
      workspace_path: input.workspace_path,
    });
  }

  /**
   * Transition a workspace to 'finalized_on_disk' and stamp finalized_at.
   * No-op when the row does not exist (define-errors-out-of-existence).
   */
  markFinalized(workspacePath: string): void {
    this.stmtMarkFinalized.run({ now: new Date().toISOString(), workspace_path: workspacePath });
  }

  /**
   * Transition a workspace to 'reaped' (tombstone kept, row not deleted).
   * No-op when the row does not exist (define-errors-out-of-existence).
   */
  markReaped(workspacePath: string): void {
    this.stmtMarkReaped.run({ now: new Date().toISOString(), workspace_path: workspacePath });
  }

  /**
   * Get a single workspace's registry row by its absolute path.
   * Returns null when absent (define-errors-out-of-existence).
   */
  getByPath(workspacePath: string): ActiveWorkspaceRow | null {
    const row = this.stmtGetByPath.get(workspacePath) as ActiveWorkspaceDbRow | undefined;
    return row ? rowToActiveWorkspaceRow(row) : null;
  }

  /**
   * List all registered workspaces, optionally filtered by status.
   * Ordered by started_at DESC (most recently started first).
   * Returns [] when no rows exist (define-errors-out-of-existence).
   */
  list(statusFilter?: ActiveWorkspaceStatus): ActiveWorkspaceRow[] {
    const rows = (
      statusFilter ? this.stmtListByStatus.all(statusFilter) : this.stmtListAll.all()
    ) as ActiveWorkspaceDbRow[];
    return rows.map(rowToActiveWorkspaceRow);
  }
}
