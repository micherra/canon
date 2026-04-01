/** Codebase graph structural analysis — core logic is pure; optional KG enrichment uses I/O */

import { existsSync } from "node:fs";
import path from "node:path";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { buildDegreeMaps } from "./degree.ts";
import { detectDeadCode } from "./kg-dead-code.ts";
import { initDatabase } from "./kg-schema.ts";
import { KgStore } from "./kg-store.ts";

export interface CodebaseInsights {
  overview: {
    total_files: number;
    total_edges: number;
    avg_dependencies_per_file: number;
    layers: Array<{ name: string; file_count: number }>;
  };
  most_connected: Array<{
    path: string;
    in_degree: number;
    out_degree: number;
    total: number;
  }>;
  orphan_files: string[];
  circular_dependencies: string[][];
  layer_violations: Array<{
    source: string;
    target: string;
    source_layer: string;
    target_layer: string;
  }>;
  /** Present only when the knowledge graph DB exists. */
  entity_overview?: {
    total_entities: number;
    by_kind: Record<string, number>;
    total_edges: number;
    by_edge_type: Record<string, number>;
  };
  /** Present only when the knowledge graph DB exists. */
  dead_code_summary?: {
    total_dead: number;
    by_kind: Record<string, number>;
    top_files: Array<{ path: string; count: number }>;
  };
  /** Present only when the knowledge graph DB exists. */
  blast_radius_hotspots?: Array<{
    entity_name: string;
    file_path: string;
    affected_count: number;
  }>;
}

interface NodeLike {
  id: string;
  layer: string;
}

interface EdgeLike {
  source: string;
  target: string;
}

function isTestFile(path: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)test\/|(?:^|\/)tests\/|(?:^|\/)[^.]+\.(?:test|spec)\.[^.]+$/i.test(path);
}

function getParentCandidates(testPath: string): string[] {
  const candidates = new Set<string>();

  // foo.test.ts -> foo.ts
  candidates.add(testPath.replace(/\.(test|spec)\.([^.]+)$/i, ".$2"));

  // __tests__/foo.ts -> foo.ts
  candidates.add(testPath.replace(/\/__tests__\//i, "/"));

  // tests/foo.ts or test/foo.ts -> foo.ts
  candidates.add(testPath.replace(/\/tests?\//i, "/"));

  return Array.from(candidates);
}

function hasMatchedParentTestConnection(path: string, nodeSet: Set<string>): boolean {
  if (isTestFile(path)) {
    const parents = getParentCandidates(path);
    return parents.some((candidate) => nodeSet.has(candidate));
  }

  // Also clear a source file from orphan list if it has colocated tests.
  const testCandidates = [path.replace(/\.([^.]+)$/i, ".test.$1"), path.replace(/\.([^.]+)$/i, ".spec.$1")];
  if (path.includes("/")) {
    testCandidates.push(
      path.replace(/\/([^/]+)$/i, "/__tests__/$1"),
      path.replace(/\/([^/]+)$/i, "/tests/$1"),
      path.replace(/\/([^/]+)$/i, "/test/$1"),
    );
  }

  return testCandidates.some((candidate) => nodeSet.has(candidate));
}

// Default clean-architecture layer rules: layer → allowed dependency targets
const DEFAULT_LAYER_RULES: Record<string, string[]> = {
  api: ["domain", "shared", "data"],
  ui: ["domain", "shared"],
  domain: ["data", "shared"],
  data: ["infra", "shared"],
  infra: ["shared"],
  shared: [],
};

export function generateInsights(
  nodes: NodeLike[],
  edges: EdgeLike[],
  layerRules?: Record<string, string[]>,
  projectDir?: string,
): CodebaseInsights {
  const rules = layerRules || DEFAULT_LAYER_RULES;

  // Degree maps
  const { inDegree, outDegree } = buildDegreeMaps(
    nodes.map((n) => n.id),
    edges,
  );

  // Overview
  const layerCounts = new Map<string, number>();
  for (const node of nodes) {
    const layer = node.layer || "unknown";
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
  }

  const overview = {
    total_files: nodes.length,
    total_edges: edges.length,
    avg_dependencies_per_file: nodes.length > 0 ? Math.round((edges.length / nodes.length) * 100) / 100 : 0,
    layers: Array.from(layerCounts.entries())
      .map(([name, file_count]) => ({ name, file_count }))
      .sort((a, b) => b.file_count - a.file_count),
  };

  // Most connected (top 10 by total degree)
  const most_connected = nodes
    .map((n) => ({
      path: n.id,
      in_degree: inDegree.get(n.id) || 0,
      out_degree: outDegree.get(n.id) || 0,
      total: (inDegree.get(n.id) || 0) + (outDegree.get(n.id) || 0),
    }))
    .filter((n) => n.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Orphan files (zero connections)
  const rawOrphans = nodes
    .filter((n) => (inDegree.get(n.id) || 0) === 0 && (outDegree.get(n.id) || 0) === 0)
    .map((n) => n.id);
  const nodeSet = new Set(nodes.map((n) => n.id));
  const orphan_files = rawOrphans.filter((path) => !hasMatchedParentTestConnection(path, nodeSet)).sort();

  // Circular dependencies (DFS cycle detection, max cycle length 5)
  const circular_dependencies = detectCycles(nodes, edges);

  // Layer violations
  const nodeLayerMap = new Map<string, string>();
  for (const node of nodes) {
    nodeLayerMap.set(node.id, node.layer || "unknown");
  }

  const layer_violations: CodebaseInsights["layer_violations"] = [];
  for (const edge of edges) {
    const sourceLayer = nodeLayerMap.get(edge.source) || "unknown";
    const targetLayer = nodeLayerMap.get(edge.target) || "unknown";

    if (sourceLayer === targetLayer || sourceLayer === "unknown" || targetLayer === "unknown") {
      continue;
    }

    const allowed = rules[sourceLayer];
    if (allowed && !allowed.includes(targetLayer)) {
      layer_violations.push({
        source: edge.source,
        target: edge.target,
        source_layer: sourceLayer,
        target_layer: targetLayer,
      });
    }
  }

  const base: CodebaseInsights = {
    overview,
    most_connected,
    orphan_files,
    circular_dependencies,
    layer_violations,
  };

  return enrichWithKgInsights(base, projectDir);
}

/**
 * Attempt to enrich the base insights with entity-level metrics from the
 * knowledge graph SQLite database.  All KG logic is wrapped in a try/catch so
 * that any failure (missing DB, schema mismatch, query error) leaves the base
 * insights untouched.
 */
function enrichWithKgInsights(base: CodebaseInsights, projectDir?: string): CodebaseInsights {
  const root = projectDir ?? (process.env["CANON_PROJECT_DIR"] || process.cwd());
  const dbPath = path.join(root, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

  if (!existsSync(dbPath)) {
    return base;
  }

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const store = new KgStore(db);

    // ------------------------------------------------------------------ //
    // 1. Entity overview — totals and by-kind / by-edge-type breakdowns   //
    // ------------------------------------------------------------------ //

    const byKindRows = db.prepare(`SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind`).all() as Array<{
      kind: string;
      n: number;
    }>;
    const by_kind = Object.fromEntries(byKindRows.map((r) => [r.kind, r.n]));

    const byEdgeTypeRows = db.prepare(`SELECT edge_type, COUNT(*) AS n FROM edges GROUP BY edge_type`).all() as Array<{
      edge_type: string;
      n: number;
    }>;
    const by_edge_type = Object.fromEntries(byEdgeTypeRows.map((r) => [r.edge_type, r.n]));

    const stats = store.getStats();
    const entity_overview: CodebaseInsights["entity_overview"] = {
      total_entities: stats.entities,
      by_kind,
      total_edges: stats.edges,
      by_edge_type,
    };

    // ------------------------------------------------------------------ //
    // 2. Dead code summary                                                 //
    // ------------------------------------------------------------------ //

    const deadReport = detectDeadCode(db);
    const top_files = deadReport.by_file
      .slice(0, 5)
      .map(({ path: filePath, entities }) => ({ path: filePath, count: entities.length }));

    const dead_code_summary: CodebaseInsights["dead_code_summary"] = {
      total_dead: deadReport.total_dead,
      by_kind: deadReport.by_kind,
      top_files,
    };

    // ------------------------------------------------------------------ //
    // 3. Blast-radius hotspots — entities with the most callers           //
    //    (counts incoming entity edges: calls, type-references, extends,  //
    //    implements). This measures "how many things depend on this        //
    //    entity" — i.e. reverse direction, not forward blast radius.      //
    // ------------------------------------------------------------------ //

    const hotspotRows = db
      .prepare(
        `SELECT e.name, f.path AS file_path, COUNT(ed.edge_id) AS incoming
         FROM entities e
         JOIN files f ON f.file_id = e.file_id
         JOIN edges ed ON ed.target_entity_id = e.entity_id
         WHERE ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
         GROUP BY e.entity_id
         ORDER BY incoming DESC
         LIMIT 10`,
      )
      .all() as Array<{ name: string; file_path: string; incoming: number }>;

    const blast_radius_hotspots: CodebaseInsights["blast_radius_hotspots"] = hotspotRows.map((row) => ({
      entity_name: row.name,
      file_path: row.file_path,
      affected_count: row.incoming,
    }));

    return {
      ...base,
      entity_overview,
      dead_code_summary,
      blast_radius_hotspots,
    };
  } catch {
    // KG enrichment is best-effort — failures must never break base insights.
    return base;
  } finally {
    // Always close the DB handle to avoid resource leaks.
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

/** Build adjacency list from nodes and edges. */
function buildAdjacencyList(nodes: NodeLike[], edges: EdgeLike[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    const list = adj.get(edge.source);
    if (list) list.push(edge.target);
  }
  return adj;
}

/** Try to record a cycle from the current DFS path. */
function tryRecordCycle(
  neighbor: string,
  path: string[],
  maxLen: number,
  cycleSet: Set<string>,
  cycles: string[][],
): void {
  const cycleStart = path.indexOf(neighbor);
  if (cycleStart < 0) return;

  const cycle = path.slice(cycleStart);
  if (cycle.length > maxLen) return;

  const normalized = normalizeCycle(cycle);
  const key = normalized.join(" -> ");
  if (cycleSet.has(key)) return;

  cycleSet.add(key);
  cycles.push(normalized);
}

/** Process one DFS component starting from startNode. */
function dfsComponent(
  startNodeId: string,
  adj: Map<string, string[]>,
  visited: Set<string>,
  maxCycleLen: number,
  cycleSet: Set<string>,
  cycles: string[][],
  maxCycles: number,
): void {
  type Frame = { node: string; neighborIdx: number };

  const inStack = new Set<string>();
  const path: string[] = [];

  const callStack: Frame[] = [{ node: startNodeId, neighborIdx: 0 }];
  visited.add(startNodeId);
  inStack.add(startNodeId);
  path.push(startNodeId);

  while (callStack.length > 0 && cycles.length < maxCycles) {
    const frame = callStack[callStack.length - 1];
    const neighbors = adj.get(frame.node) || [];

    if (frame.neighborIdx >= neighbors.length) {
      callStack.pop();
      path.pop();
      inStack.delete(frame.node);
      continue;
    }

    const neighbor = neighbors[frame.neighborIdx];
    frame.neighborIdx++;

    if (inStack.has(neighbor)) {
      tryRecordCycle(neighbor, path, maxCycleLen, cycleSet, cycles);
    } else if (!visited.has(neighbor)) {
      visited.add(neighbor);
      inStack.add(neighbor);
      path.push(neighbor);
      callStack.push({ node: neighbor, neighborIdx: 0 });
    }
  }

  // Clean up if we exited early (cycle cap reached)
  for (const node of path) inStack.delete(node);
}

/** Detect cycles using iterative DFS. Returns unique cycles up to length 5. */
function detectCycles(nodes: NodeLike[], edges: EdgeLike[]): string[][] {
  const adj = buildAdjacencyList(nodes, edges);
  const MAX_CYCLE_LEN = 5;
  const MAX_CYCLES = 20;
  const cycles: string[][] = [];
  const cycleSet = new Set<string>();
  const visited = new Set<string>();

  for (const startNode of nodes) {
    if (visited.has(startNode.id) || cycles.length >= MAX_CYCLES) continue;
    dfsComponent(startNode.id, adj, visited, MAX_CYCLE_LEN, cycleSet, cycles, MAX_CYCLES);
  }

  return cycles;
}

/** Normalize a cycle by rotating so the lexicographically smallest element is first */
function normalizeCycle(cycle: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}
