/**
 * AreaMemoryDao — short-term area memory storage
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v8 migration table: area_observations.
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the DriftDbSignals pattern: constructor prepares statements,
 * synchronous methods, callers never see SQL.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty inputs return empty arrays
 * - simplicity-first: no new abstractions beyond the established DAO pattern
 * - errors-are-values: typed return values; no thrown errors for expected conditions
 */

import type Database from "better-sqlite3";

// ---- Types ----

/**
 * A row from the area_observations table.
 * Tracks short-term observations from engineers and reviewers about a subsystem.
 */
export type AreaObservationRow = {
  id: number;
  subsystem_key: string;
  content: string;
  source: string;
  workflow_slug: string | null;
  created_at: string;
  injected_count: number;
  last_injected_at: string | null;
};

/**
 * Input for inserting a new area observation.
 */
export type InsertAreaObservationInput = {
  subsystem_key: string;
  content: string;
  source: string;
  workflow_slug?: string;
};

// ---- deriveSubsystemKey ----

/**
 * Derive a subsystem key from a file path.
 *
 * Rules (applied in order):
 * 1. Strip `mcp-server/src/` prefix if present
 * 2. Strip `__tests__/` and implementation leaf directories (`tools/`, `services/`)
 *    to map files up to their parent subsystem
 * 3. Take the directory path (all remaining parts except the filename)
 * 4. If the result is empty or just a filename (no slash), return "root"
 *
 * Examples:
 * - `mcp-server/src/features/orchestration/tools/write-review.ts` → `features/orchestration`
 * - `mcp-server/src/platform/storage/drift/drift-db.ts` → `platform/storage/drift`
 * - `hooks/canon-hook-lib.sh` → `hooks`
 * - `mcp-server/src/features/orchestration/__tests__/foo.test.ts` → `features/orchestration`
 * - `CLAUDE.md` → `root`
 */
export function deriveSubsystemKey(filePath: string): string {
  // Normalize path separators
  let path = filePath.replace(/\\/g, "/");

  // Strip mcp-server/src/ prefix
  const MCP_PREFIX = "mcp-server/src/";
  if (path.startsWith(MCP_PREFIX)) {
    path = path.slice(MCP_PREFIX.length);
  }

  // Strip leaf subdirectories that are implementation details, not subsystem boundaries.
  // These directories exist within a subsystem but don't define it:
  // - __tests__/ : test files map to their parent subsystem
  // - tools/     : tool handlers within a feature
  // - services/  : service implementations within a feature
  path = path.replace(/__tests__\//g, "");
  path = path.replace(/\btools\//g, "");
  path = path.replace(/\bservices\//g, "");

  // Split into parts (remove empty parts from leading/trailing slashes)
  const parts = path.split("/").filter((p) => p.length > 0);

  // Take all parts except the filename (last element)
  const dirParts = parts.slice(0, -1);

  if (dirParts.length === 0) {
    return "root";
  }

  const key = dirParts.join("/");
  return key.length > 0 ? key : "root";
}

// ---- DAO Class ----

/**
 * DAO for the area_observations table added in drift schema v8.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getAreaMemory() in production code.
 */
export class AreaMemoryDao {
  private readonly stmtInsertObservation: Database.Statement;
  private readonly stmtGetObservationsForSubsystem: Database.Statement;
  private readonly stmtMarkInjected: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsertObservation = db.prepare(`
      INSERT INTO area_observations (subsystem_key, content, source, workflow_slug, created_at)
      VALUES (@subsystem_key, @content, @source, @workflow_slug, @created_at)
    `);

    // Note: SQLite does not support IN with prepared statement arrays (bind params),
    // so we iterate subsystem keys individually (same pattern as DriftDbSignals.getFileViolationHistory).
    // This prepared statement queries for one subsystem key at a time.
    this.stmtGetObservationsForSubsystem = db.prepare(`
      SELECT id, subsystem_key, content, source, workflow_slug, created_at,
             injected_count, last_injected_at
      FROM area_observations
      WHERE subsystem_key = ?
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // markInjected: similarly iterate IDs one at a time
    this.stmtMarkInjected = db.prepare(`
      UPDATE area_observations
      SET injected_count = injected_count + 1,
          last_injected_at = ?
      WHERE id = ?
    `);
  }

  /**
   * Insert a new area observation.
   * Sets created_at to the current ISO-8601 timestamp.
   */
  insertObservation(input: InsertAreaObservationInput): void {
    this.stmtInsertObservation.run({
      content: input.content,
      created_at: new Date().toISOString(),
      source: input.source,
      subsystem_key: input.subsystem_key,
      workflow_slug: input.workflow_slug ?? null,
    });
  }

  /**
   * Get observations for a list of subsystem keys.
   * Filters to observations created within the last 7 days.
   * Returns up to 10 observations per subsystem key, ordered by created_at DESC.
   * Returns empty array for empty input (define-errors-out-of-existence).
   */
  getObservationsForSubsystems(subsystemKeys: string[]): AreaObservationRow[] {
    if (subsystemKeys.length === 0) return [];
    const results: AreaObservationRow[] = [];
    for (const key of subsystemKeys) {
      const rows = this.stmtGetObservationsForSubsystem.all(key) as AreaObservationRow[];
      results.push(...rows);
    }
    return results;
  }

  /**
   * Increment injected_count and set last_injected_at for the given observation IDs.
   * Called by the enrichment service after observations are included in a spawn prompt.
   * Enables the learner to track observation effectiveness.
   * No-op for empty ids array (define-errors-out-of-existence).
   */
  markInjected(ids: number[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    for (const id of ids) {
      this.stmtMarkInjected.run(now, id);
    }
  }
}
