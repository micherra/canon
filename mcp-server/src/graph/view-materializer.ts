/**
 * View Materializer — SQLite Knowledge Graph → graph-data.json
 *
 * Reads from the better-sqlite3 knowledge graph database and produces the
 * `graph-data.json` file consumed by the Canon Dashboard extension. The
 * output is backward-compatible with the existing GraphNode/GraphEdge shape
 * from codebase-graph.ts, with new optional enrichment fields added.
 *
 * Uses a synchronous atomic write (write to .tmp then rename) to prevent
 * corruption on concurrent access. All DB operations are synchronous
 * (better-sqlite3 is sync), so the module exports synchronous functions.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import type { CodebaseGraphOutput, GraphEdge, GraphNode } from "../tools/codebase-graph.ts";
import { KgQuery } from "./kg-query.ts";

// ---------------------------------------------------------------------------
// GraphData — the shape written to graph-data.json
// ---------------------------------------------------------------------------

/**
 * Extended GraphNode with optional KG-derived enrichment fields.
 * Backward-compatible with the existing GraphNode interface.
 */
export interface KgGraphNode extends GraphNode {
  entity_count?: number;
  export_count?: number;
  dead_code_count?: number;
}

/**
 * Minimal output shape written by the materializer.
 * Reuses CodebaseGraphOutput but nodes carry KgGraphNode.
 */
export type GraphData = Omit<CodebaseGraphOutput, "nodes"> & {
  nodes: KgGraphNode[];
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map a DB edge_type string to the GraphEdge union type. */
function mapEdgeType(edgeType: string): GraphEdge["type"] {
  if (edgeType === "imports") return "import";
  if (edgeType === "re-exports") return "re-export";
  if (edgeType === "composition") return "composition";
  // All other entity-level edge types fall back to import for compatibility
  return "import";
}

/**
 * Infer a coarse `kind` label from a file path.
 * Mirrors the logic in classifyMdNode / layer inference but for SQLite-sourced files.
 */
function inferKind(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.includes("__tests__") || lower.includes(".test.") || lower.includes(".spec.")) {
    return "test";
  }
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".toml")) {
    return "config";
  }
  if (lower.endsWith(".md")) {
    return "doc";
  }
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) {
    return "script";
  }
  return "source";
}

/** Synchronous atomic write — writes to a tmp file then renames. */
function atomicWriteFileSync(filePath: string, data: string): void {
  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  try {
    writeFileSync(tmpPath, data, "utf-8");
    try {
      renameSync(tmpPath, filePath);
    } catch (renameErr: unknown) {
      // On Windows, rename can fail when dest exists — remove and retry
      const renameCode = (renameErr as NodeJS.ErrnoException).code;
      if (renameCode === "EPERM" || renameCode === "EEXIST" || renameCode === "EACCES") {
        try {
          unlinkSync(filePath);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        renameSync(tmpPath, filePath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    // Clean up temp file on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core materializer
// ---------------------------------------------------------------------------

/**
 * Query the SQLite knowledge graph and return a GraphData object.
 *
 * - Nodes are derived from the `files` table, enriched with entity/export/
 *   dead-code counts from `KgQuery`.
 * - Edges are derived from the `file_edges` table.
 * - `violation_count` and `changed` default to 0/false — these are
 *   populated by the compliance overlay and git-diff overlay respectively.
 * - `layers`, `principles`, and `insights` default to empty structures;
 *   the existing `codebaseGraph` tool populates those on a full scan.
 */
export function materialize(db: Database.Database, _projectDir: string): GraphData {
  const query = new KgQuery(db);

  // ------------------------------------------------------------------
  // 1. Load all files with entity_count and export_count in one query
  // ------------------------------------------------------------------
  const filesWithStats = query.getAllFilesWithStats();

  // ------------------------------------------------------------------
  // 2. Build a file_id → path lookup for edge resolution
  // ------------------------------------------------------------------
  const fileIdToPath = new Map<number, string>();
  for (const file of filesWithStats) {
    if (file.file_id !== undefined) {
      fileIdToPath.set(file.file_id, file.path);
    }
  }

  // ------------------------------------------------------------------
  // 3. Build nodes
  // ------------------------------------------------------------------
  const nodes: KgGraphNode[] = [];

  for (const file of filesWithStats) {
    if (file.file_id === undefined) continue;

    // dead_code_count requires per-file query (not in getAllFilesWithStats)
    const { deadCodeCount } = query.getFileStats(file.file_id);

    const node: KgGraphNode = {
      id: file.path,
      layer: file.layer || "unknown",
      // color is populated by the layer-color overlay; default to neutral
      color: "#BDC3C7",
      extension: path.extname(file.path).replace(".", "") || "",
      violation_count: 0,
      top_violations: [],
      last_verdict: null,
      compliance_score: null,
      changed: false,
      kind: inferKind(file.path),
      // KG enrichment fields
      entity_count: file.entity_count,
      export_count: file.export_count,
      dead_code_count: deadCodeCount,
    };

    nodes.push(node);
  }

  // ------------------------------------------------------------------
  // 4. Build edges from file_edges table
  // ------------------------------------------------------------------
  const edges: GraphEdge[] = [];

  // Query all file_edges joined with source/target paths
  const fileEdgeRows = (db as Database.Database)
    .prepare(`
    SELECT fe.edge_type, fe.confidence, fe.evidence, fe.relation,
           src.path AS source_path, tgt.path AS target_path
    FROM file_edges fe
    JOIN files src ON src.file_id = fe.source_file_id
    JOIN files tgt ON tgt.file_id = fe.target_file_id
  `)
    .all() as Array<{
    edge_type: string;
    confidence: number;
    evidence: string | null;
    relation: string | null;
    source_path: string;
    target_path: string;
  }>;

  for (const row of fileEdgeRows) {
    const edge: GraphEdge = {
      source: row.source_path,
      target: row.target_path,
      type: mapEdgeType(row.edge_type),
      confidence: row.confidence,
      relation: row.relation ?? undefined,
    };
    edges.push(edge);
  }

  // ------------------------------------------------------------------
  // 5. Assemble output — layers/principles/insights left empty for
  //    the full codebaseGraph tool to populate on a complete scan.
  // ------------------------------------------------------------------
  const graphData: GraphData = {
    nodes,
    edges,
    layers: [],
    principles: {},
    insights: {
      overview: {
        total_files: nodes.length,
        total_edges: edges.length,
        avg_dependencies_per_file: nodes.length > 0 ? edges.length / nodes.length : 0,
        layers: [],
      },
      most_connected: [],
      orphan_files: [],
      circular_dependencies: [],
      layer_violations: [],
    },
    generated_at: new Date().toISOString(),
  };

  return graphData;
}

/**
 * Materialize the knowledge graph to `.canon/graph-data.json`.
 * Uses an atomic write to prevent partial reads during concurrent access.
 */
export function materializeToFile(db: Database.Database, projectDir: string): void {
  const graphData = materialize(db, projectDir);

  const canonDir = path.join(projectDir, CANON_DIR);
  mkdirSync(canonDir, { recursive: true });

  const outPath = path.join(canonDir, CANON_FILES.GRAPH_DATA);
  atomicWriteFileSync(outPath, JSON.stringify(graphData, null, 2));
}
