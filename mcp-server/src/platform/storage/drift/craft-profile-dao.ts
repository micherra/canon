/**
 * CraftProfileDao — area-keyed craft profile storage
 *
 * Wraps a better-sqlite3 Database instance initialized by initDriftDb().
 * Operates on the v9 migration table: craft_profiles.
 *
 * All statements are prepared once at construction time.
 * The API is fully synchronous (better-sqlite3 is sync).
 *
 * Follows the AreaMemoryDao pattern: constructor prepares statements,
 * synchronous methods, callers never see SQL.
 *
 * Canon principles:
 * - define-errors-out-of-existence: empty inputs return empty arrays; unknown keys → []
 * - prefer-constructor-injection: Database.Database handle passed via constructor
 * - backward-compatible-schema-changes: nullable columns; conditional-assign reads
 */

import type Database from "better-sqlite3";
import type { CraftDimensionRating } from "@shared/schema.ts";

// ---- Types ----

/**
 * A row from the craft_profiles table.
 * Tracks craft dimension rating snapshots from reviewers and audits.
 * flow / run_id / rollup are omitted (not set to null) when the source is 'audit'.
 */
export type CraftProfileRow = {
  id: number;
  subsystem_key: string;
  source: "review" | "audit";
  flow?: string;
  run_id?: string;
  ratings: CraftDimensionRating[];
  rollup?: number;
  created_at: string;
};

/**
 * Input for inserting a new craft profile.
 */
export type InsertCraftProfileInput = {
  subsystem_key: string;
  source: "review" | "audit";
  flow?: string;
  run_id?: string;
  ratings: CraftDimensionRating[];
  rollup?: number;
};

// ---- Raw DB row type ----

type CraftProfileDbRow = {
  id: number;
  subsystem_key: string;
  source: string;
  flow: string | null;
  run_id: string | null;
  ratings: string;
  rollup: number | null;
  created_at: string;
};

// ---- Row deserializer ----

/**
 * Convert a raw SQLite row to a CraftProfileRow.
 * Follows the rowToFlowRunEntry conditional-assign pattern:
 * nullable fields are set on the output object only when non-null.
 */
function rowToCraftProfileRow(row: CraftProfileDbRow): CraftProfileRow {
  const entry: CraftProfileRow = {
    id: row.id,
    subsystem_key: row.subsystem_key,
    source: row.source as "review" | "audit",
    ratings: JSON.parse(row.ratings) as CraftDimensionRating[],
    created_at: row.created_at,
  };
  if (row.flow !== null) entry.flow = row.flow;
  if (row.run_id !== null) entry.run_id = row.run_id;
  if (row.rollup !== null) entry.rollup = row.rollup;
  return entry;
}

// ---- DAO Class ----

/**
 * DAO for the craft_profiles table added in drift schema v9.
 *
 * Construct with the same Database.Database handle used by DriftDb.
 * All statements are prepared once in the constructor.
 * Obtain via DriftDb.getCraftProfiles() in production code.
 */
export class CraftProfileDao {
  private readonly stmtInsertProfile: Database.Statement;
  private readonly stmtGetProfilesForSubsystem: Database.Statement;
  private readonly stmtGetRecentProfiles: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsertProfile = db.prepare(`
      INSERT INTO craft_profiles (subsystem_key, source, flow, run_id, ratings, rollup, created_at)
      VALUES (@subsystem_key, @source, @flow, @run_id, @ratings, @rollup, @created_at)
    `);

    // Note: SQLite does not support IN with prepared statement arrays (bind params),
    // so we iterate subsystem keys individually (same pattern as AreaMemoryDao).
    // This prepared statement queries for one subsystem key at a time.
    this.stmtGetProfilesForSubsystem = db.prepare(`
      SELECT id, subsystem_key, source, flow, run_id, ratings, rollup, created_at
      FROM craft_profiles
      WHERE subsystem_key = ?
      ORDER BY created_at DESC
    `);

    this.stmtGetRecentProfiles = db.prepare(`
      SELECT id, subsystem_key, source, flow, run_id, ratings, rollup, created_at
      FROM craft_profiles
      ORDER BY created_at DESC
      LIMIT ?
    `);
  }

  /**
   * Insert a new craft profile.
   * Sets created_at to the current ISO-8601 timestamp.
   * flow / run_id / rollup default to null when not provided (review-only fields).
   */
  insertProfile(input: InsertCraftProfileInput): void {
    this.stmtInsertProfile.run({
      subsystem_key: input.subsystem_key,
      source: input.source,
      flow: input.flow ?? null,
      run_id: input.run_id ?? null,
      ratings: JSON.stringify(input.ratings),
      rollup: input.rollup ?? null,
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Get craft profiles for a list of subsystem keys.
   * Returns all stored profiles for those keys, ordered by created_at DESC per key.
   * Returns empty array for empty input (define-errors-out-of-existence).
   */
  getProfilesForSubsystems(subsystemKeys: string[]): CraftProfileRow[] {
    if (subsystemKeys.length === 0) return [];
    const results: CraftProfileRow[] = [];
    for (const key of subsystemKeys) {
      const rows = this.stmtGetProfilesForSubsystem.all(key) as CraftProfileDbRow[];
      results.push(...rows.map(rowToCraftProfileRow));
    }
    return results;
  }

  /**
   * Get the most recent craft profiles across all subsystems.
   * Ordered by created_at DESC. Respects limit.
   * Returns empty array when no profiles exist (define-errors-out-of-existence).
   */
  getRecentProfiles(limit: number): CraftProfileRow[] {
    const rows = this.stmtGetRecentProfiles.all(limit) as CraftProfileDbRow[];
    return rows.map(rowToCraftProfileRow);
  }
}
