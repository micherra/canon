/**
 * Column-mapping and UPDATE execution helpers for ExecutionStore.
 *
 * Split from execution-store.ts to keep that file under the 600-line limit.
 * Callers are methods on ExecutionStore — these helpers operate on the bare
 * primitives (db handle and pre-collected statements).
 */

import type Database from "better-sqlite3";
import type { ExecutionRow, UpdateExecutionFields } from "./execution-store-types.ts";
import { ALLOWED_UPDATE_EXECUTION_COLUMNS } from "./execution-store-types.ts";

type AddColumn = (col: string, value: unknown) => void;

/** Map UpdateExecutionFields JSON-serialized columns. */
function collectJsonColumns(fields: UpdateExecutionFields, addColumn: AddColumn): void {
  if ("blocked" in fields) {
    const val =
      fields.blocked !== null && fields.blocked !== undefined
        ? JSON.stringify(fields.blocked)
        : null;
    addColumn("blocked", val);
  }
  if (fields.concerns !== undefined) addColumn("concerns", JSON.stringify(fields.concerns));
  if (fields.skipped !== undefined) addColumn("skipped", JSON.stringify(fields.skipped));
  if (fields.metadata !== undefined) {
    addColumn("metadata", fields.metadata !== null ? JSON.stringify(fields.metadata) : null);
  }
}

/** Map UpdateExecutionFields scalar columns. */
function collectScalarColumns(fields: UpdateExecutionFields, addColumn: AddColumn): void {
  if (fields.current_state !== undefined) addColumn("current_state", fields.current_state);
  if (fields.status !== undefined) addColumn("status", fields.status);
  if (fields.completed_at !== undefined) addColumn("completed_at", fields.completed_at);
  if (fields.rolled_back_at !== undefined) addColumn("rolled_back_at", fields.rolled_back_at);
  if (fields.rolled_back_to !== undefined) addColumn("rolled_back_to", fields.rolled_back_to);
  if ("worktree_path" in fields) addColumn("worktree_path", fields.worktree_path ?? null);
  if ("worktree_branch" in fields) addColumn("worktree_branch", fields.worktree_branch ?? null);
  if (fields.version !== undefined) addColumn("version", fields.version);
}

/** Build the `SET` clause parts and params object from an UpdateExecutionFields shape. */
function buildUpdateParts(fields: UpdateExecutionFields): {
  parts: string[];
  params: Record<string, unknown>;
} {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  const addColumn: AddColumn = (col, value) => {
    if (!ALLOWED_UPDATE_EXECUTION_COLUMNS.has(col)) {
      throw new Error(`updateExecution: column '${col}' is not in the allowed list`);
    }
    parts.push(`${col} = @${col}`);
    params[col] = value;
  };

  collectJsonColumns(fields, addColumn);
  collectScalarColumns(fields, addColumn);

  // Always update last_updated
  const now = fields.last_updated ?? new Date().toISOString();
  addColumn("last_updated", now);

  return { params, parts };
}

/** Non-versioned UPDATE of execution-level fields. */
export function updateExecution(db: Database.Database, fields: UpdateExecutionFields): void {
  const { parts, params } = buildUpdateParts(fields);
  // parts always contains at least `last_updated`, so the UPDATE always has a SET clause.
  const sql = `UPDATE execution SET ${parts.join(", ")} WHERE id = 1`;
  db.prepare(sql).run(params);
}

export type VersionedUpdateResult =
  | { updated: true; newVersion: number }
  | { updated: false; currentVersion: number };

/**
 * Optimistic-locking UPDATE for execution-level fields.
 * Increments the version column atomically; returns a discriminated union.
 * errors-are-values: never throws for version conflicts.
 */
export function updateExecutionVersioned(
  db: Database.Database,
  stmtGetExecution: Database.Statement,
  fields: UpdateExecutionFields,
  expectedVersion: number,
): VersionedUpdateResult {
  const { parts, params } = buildUpdateParts(fields);

  // Always increment version
  const newVersion = expectedVersion + 1;
  parts.push("version = @version");
  params.version = newVersion;

  const sql = `UPDATE execution SET ${parts.join(", ")} WHERE id = 1 AND version = @expected_version`;
  params.expected_version = expectedVersion;

  const result = db.prepare(sql).run(params);
  if (result.changes === 0) {
    // Version mismatch — read current version for diagnostics
    const row = stmtGetExecution.get() as ExecutionRow | undefined;
    return { currentVersion: row?.version ?? -1, updated: false };
  }
  return { newVersion, updated: true };
}
