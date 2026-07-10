/**
 * kg-context-store.ts
 *
 * ContextGraphStore — wraps all CRUD for the context-graph tables:
 *   context_nodes, context_edges.
 *
 * Decisions and ADRs are promoted into the KG as a dedicated node/edge
 * table-pair, separate from `files`/`entities` (a decision has no `file_id`;
 * see ADR-0046 / DEC-M2-01).
 *
 * Write strategy: `replaceAll` deletes both tables and bulk-reinserts inside
 * ONE transaction — the context subgraph is small and fully rebuilt on every
 * ingest pass, so delete-reinsert is simpler and dup-free by construction
 * (DEC-M2-03), unlike `kg-doc-store.ts`'s upsert+prune.
 *
 * This class throws on errors — it is internal infrastructure, not an MCP
 * tool handler. Callers that need graceful degradation should catch errors.
 * The read helpers themselves return `[]` for absent data (errors-are-values).
 */

import type Database from "better-sqlite3";

export type ContextRecordKind = "decision" | "adr" | "build";

export type ContextEdgeType =
  | "decision_touches_file"
  | "decision_cites_principle"
  | "supersedes"
  | "build_produced";

export type ContextNode = {
  node_id: string;
  record_kind: ContextRecordKind;
  title: string | null;
  ref_slug: string | null;
  source_event_id: number | null;
  adr_number: string | null;
  status: string | null;
  body_excerpt: string | null;
  updated_at: string;
};

export type ContextEdge = {
  src: string;
  dst: string;
  edge_type: ContextEdgeType;
  evidence: string | null;
};

export class ContextGraphStore {
  private readonly db: Database.Database;

  private readonly stmtInsertNode: Database.Statement;
  private readonly stmtInsertEdge: Database.Statement;
  private readonly stmtGetNodesForFile: Database.Statement;
  private readonly stmtGetSupersedesTargets: Database.Statement;
  private readonly stmtGetAllNodes: Database.Statement;
  private readonly stmtGetAllEdges: Database.Statement;
  private readonly stmtGetNodeById: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsertNode = db.prepare(`
      INSERT INTO context_nodes
        (node_id, record_kind, title, ref_slug, source_event_id, adr_number,
         status, body_excerpt, updated_at)
      VALUES
        (@node_id, @record_kind, @title, @ref_slug, @source_event_id, @adr_number,
         @status, @body_excerpt, @updated_at)
    `);

    this.stmtInsertEdge = db.prepare(`
      INSERT INTO context_edges (src, dst, edge_type, evidence)
      VALUES (@src, @dst, @edge_type, @evidence)
    `);

    this.stmtGetNodesForFile = db.prepare(`
      SELECT cn.*
      FROM context_edges ce
      JOIN context_nodes cn ON cn.node_id = ce.src
      WHERE ce.edge_type = 'decision_touches_file' AND ce.dst = ?
    `);

    this.stmtGetSupersedesTargets = db.prepare(`
      SELECT dst FROM context_edges WHERE edge_type = 'supersedes' AND src = ?
    `);

    this.stmtGetNodeById = db.prepare(`SELECT * FROM context_nodes WHERE node_id = ?`);
    this.stmtGetAllNodes = db.prepare(`SELECT * FROM context_nodes`);
    this.stmtGetAllEdges = db.prepare(`SELECT * FROM context_edges`);
  }

  /**
   * Replace the entire context subgraph in one transaction: delete both
   * tables, then bulk-insert all nodes then all edges. Delete-then-reinsert
   * is dup-free by construction — no ON CONFLICT needed (DEC-M2-03).
   */
  replaceAll(nodes: ContextNode[], edges: ContextEdge[]): void {
    const run = this.db.transaction(() => {
      this.db.exec(`DELETE FROM context_edges`);
      this.db.exec(`DELETE FROM context_nodes`);
      for (const node of nodes) {
        this.stmtInsertNode.run(node);
      }
      for (const edge of edges) {
        this.stmtInsertEdge.run(edge);
      }
    });
    run();
  }

  /**
   * Return context nodes (decisions/ADRs) linked to `path` via a
   * `decision_touches_file` edge. Returns `[]` when nothing links to it.
   */
  getNodesForFile(path: string): ContextNode[] {
    return this.stmtGetNodesForFile.all(path) as ContextNode[];
  }

  /**
   * Transitively walk `supersedes` edges from `adrId`, returning the ordered
   * chain of superseded nodes. Cycle-guarded via a visited set — a malformed
   * `A supersedes B supersedes A` terminates, returning each node once.
   */
  getSupersedesChain(adrId: string): ContextNode[] {
    const chain: ContextNode[] = [];
    const visited = new Set<string>([adrId]);
    let current = adrId;

    for (;;) {
      const targets = this.stmtGetSupersedesTargets.all(current) as Array<{ dst: string }>;
      if (targets.length === 0) break;
      const next = targets[0].dst;
      if (visited.has(next)) break;
      visited.add(next);

      const node = this.stmtGetNodeById.get(next) as ContextNode | undefined;
      if (!node) break;
      chain.push(node);
      current = next;
    }

    return chain;
  }

  /** Return all context nodes. Used by ingest tests. */
  getAllNodes(): ContextNode[] {
    return this.stmtGetAllNodes.all() as ContextNode[];
  }

  /** Return all context edges. Used by ingest tests. */
  getAllEdges(): ContextEdge[] {
    return this.stmtGetAllEdges.all() as ContextEdge[];
  }
}
