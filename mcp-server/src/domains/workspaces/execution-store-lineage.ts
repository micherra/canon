/**
 * Flow lineage tracking — records completed flows per branch for cross-flow context passing.
 * Added by cfcp-03 (migration v10).
 */

import type Database from "better-sqlite3";

export type FlowLineageEntry = {
  workspace_path: string;
  flow_name: string;
  branch: string;
  status: string;
  completed_at: string;
  task?: string;
  slug?: string;
};

type LineageRow = {
  workspace_path: string;
  flow_name: string;
  branch: string;
  status: string;
  completed_at: string;
  task: string | null;
  slug: string | null;
};

export type LineageStatements = {
  stmtRecordLineage: Database.Statement;
  stmtGetLineage: Database.Statement;
  stmtGetLatestLineage: Database.Statement;
};

export function prepareLineageStatements(db: Database.Database): LineageStatements {
  return {
    stmtGetLatestLineage: db.prepare(`
      SELECT workspace_path, flow_name, branch, status, completed_at, task, slug
      FROM flow_lineage
      WHERE branch = ?
      ORDER BY completed_at DESC
      LIMIT 1
    `),
    stmtGetLineage: db.prepare(`
      SELECT workspace_path, flow_name, branch, status, completed_at, task, slug
      FROM flow_lineage
      WHERE branch = ?
      ORDER BY completed_at DESC
    `),
    stmtRecordLineage: db.prepare(`
      INSERT INTO flow_lineage (workspace_path, flow_name, branch, status, completed_at, task, slug)
      VALUES (@workspace_path, @flow_name, @branch, @status, @completed_at, @task, @slug)
    `),
  };
}

function rowToEntry(r: LineageRow): FlowLineageEntry {
  return {
    branch: r.branch,
    completed_at: r.completed_at,
    flow_name: r.flow_name,
    ...(r.slug !== null ? { slug: r.slug } : {}),
    status: r.status,
    ...(r.task !== null ? { task: r.task } : {}),
    workspace_path: r.workspace_path,
  };
}

/**
 * Record a completed flow run. Wraps INSERT in try/catch — lineage write
 * errors never abort the caller.
 */
export function recordFlowLineage(stmts: LineageStatements, entry: FlowLineageEntry): void {
  try {
    stmts.stmtRecordLineage.run({
      branch: entry.branch,
      completed_at: entry.completed_at,
      flow_name: entry.flow_name,
      slug: entry.slug ?? null,
      status: entry.status,
      task: entry.task ?? null,
      workspace_path: entry.workspace_path,
    });
  } catch (err) {
    console.warn("[canon] recordFlowLineage: failed to insert lineage entry:", err);
  }
}

/** Retrieve all flow lineage entries for a branch, ordered by completed_at DESC. */
export function getFlowLineage(stmts: LineageStatements, branch: string): FlowLineageEntry[] {
  const rows = stmts.stmtGetLineage.all(branch) as LineageRow[];
  return rows.map(rowToEntry);
}

/** Retrieve the most recent flow lineage entry for a branch. */
export function getLatestFlowForBranch(
  stmts: LineageStatements,
  branch: string,
): FlowLineageEntry | null {
  const row = stmts.stmtGetLatestLineage.get(branch) as LineageRow | undefined;
  return row ? rowToEntry(row) : null;
}
