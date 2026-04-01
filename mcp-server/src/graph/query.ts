/**
 * Graph query utility — loads and caches graph-data.json, exposes typed metric accessors.
 * Gracefully returns null when graph data doesn't exist.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CANON_DIR, CANON_FILES, LAYER_CENTRALITY } from "../constants.ts";
import { isNotFound } from "../utils/errors.ts";
import { buildDegreeMaps } from "./degree.ts";
import type { CodebaseInsights } from "./insights.ts";

// --- Types ---

export interface GraphMetrics {
  in_degree: number;
  out_degree: number;
  is_hub: boolean;
  in_cycle: boolean;
  cycle_peers: string[];
  layer: string;
  layer_violation_count: number;
  layer_violations: Array<{ target: string; source_layer: string; target_layer: string }>;
  impact_score: number;
}

interface GraphNode {
  id: string;
  layer: string;
  violation_count: number;
  changed: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface RawGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  insights: CodebaseInsights;
  generated_at: string;
}

/** Opaque handle for graph data. Use query functions to access metrics. */
export type GraphHandle = ParsedGraph;

/** Pre-computed lookup maps for O(1) queries. */
interface ParsedGraph {
  raw: RawGraphData;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
  nodeLayer: Map<string, string>;
  nodeChanged: Map<string, boolean>;
  nodeViolations: Map<string, number>;
  hubSet: Set<string>;
  cycleMembers: Map<string, string[]>; // node → peers in cycle
  layerViolationsBySource: Map<string, Array<{ target: string; source_layer: string; target_layer: string }>>;
  reverseIndex: Map<string, string[]>; // target → sources (from edges)
  generatedAt: string;
}

// LAYER_CENTRALITY imported from constants.ts

// --- Cache ---

let cachedGraph: ParsedGraph | null = null;
let cachedMtime: number = 0;
let cachedProjectDir: string = "";

/**
 * Load and cache graph-data.json. Returns null if file doesn't exist.
 * Uses mtime-based invalidation so repeated calls within the same process are cheap.
 */
export async function loadCachedGraph(projectDir: string): Promise<GraphHandle | null> {
  const graphPath = join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);

  try {
    const st = await stat(graphPath);
    const mtime = st.mtimeMs;

    // Return cache if same project and file hasn't changed
    if (cachedGraph && cachedProjectDir === projectDir && cachedMtime === mtime) {
      return cachedGraph;
    }

    const raw = JSON.parse(await readFile(graphPath, "utf-8")) as RawGraphData;
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
      return null;
    }
    // Validate node shape at trust boundary — reject corrupted data
    if (raw.nodes.length > 0 && (typeof raw.nodes[0]?.id !== "string" || typeof raw.nodes[0]?.layer !== "string")) {
      return null;
    }

    cachedGraph = buildParsedGraph(raw);
    cachedMtime = mtime;
    cachedProjectDir = projectDir;
    return cachedGraph;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    // Parse errors, permission errors — return null, don't crash tools
    return null;
  }
}

/** Build node-level lookup maps from raw graph nodes. */
function buildNodeMaps(nodes: GraphNode[]): {
  nodeLayer: Map<string, string>;
  nodeChanged: Map<string, boolean>;
  nodeViolations: Map<string, number>;
} {
  const nodeLayer = new Map<string, string>();
  const nodeChanged = new Map<string, boolean>();
  const nodeViolations = new Map<string, number>();
  for (const node of nodes) {
    nodeLayer.set(node.id, node.layer || "unknown");
    nodeChanged.set(node.id, node.changed || false);
    nodeViolations.set(node.id, node.violation_count || 0);
  }
  return { nodeLayer, nodeChanged, nodeViolations };
}

/** Build reverse index from edges (target -> sources). */
function buildReverseIndex(edges: GraphEdge[]): Map<string, string[]> {
  const reverseIndex = new Map<string, string[]>();
  for (const edge of edges) {
    if (!reverseIndex.has(edge.target)) reverseIndex.set(edge.target, []);
    reverseIndex.get(edge.target)!.push(edge.source);
  }
  return reverseIndex;
}

/** Build hub set from most_connected insights. */
function buildHubSet(insights: CodebaseInsights | undefined): Set<string> {
  const hubSet = new Set<string>();
  if (!insights?.most_connected) return hubSet;
  for (const mc of insights.most_connected) hubSet.add(mc.path);
  return hubSet;
}

/** Build cycle membership map from circular dependency insights. */
function buildCycleMembers(insights: CodebaseInsights | undefined): Map<string, string[]> {
  const cycleMembers = new Map<string, string[]>();
  if (!insights?.circular_dependencies) return cycleMembers;
  for (const cycle of insights.circular_dependencies) {
    for (const node of cycle) {
      const existing = cycleMembers.get(node) || [];
      for (const p of cycle) {
        if (p !== node && !existing.includes(p)) existing.push(p);
      }
      cycleMembers.set(node, existing);
    }
  }
  return cycleMembers;
}

/** Build layer violations grouped by source file. */
function buildLayerViolationsBySource(
  insights: CodebaseInsights | undefined,
): Map<string, Array<{ target: string; source_layer: string; target_layer: string }>> {
  const map = new Map<string, Array<{ target: string; source_layer: string; target_layer: string }>>();
  if (!insights?.layer_violations) return map;
  for (const lv of insights.layer_violations) {
    if (!map.has(lv.source)) map.set(lv.source, []);
    map.get(lv.source)!.push({
      target: lv.target,
      source_layer: lv.source_layer,
      target_layer: lv.target_layer,
    });
  }
  return map;
}

function buildParsedGraph(raw: RawGraphData): ParsedGraph {
  const { nodeLayer, nodeChanged, nodeViolations } = buildNodeMaps(raw.nodes);
  const { inDegree, outDegree } = buildDegreeMaps(
    raw.nodes.map((n) => n.id),
    raw.edges,
  );

  return {
    raw,
    inDegree,
    outDegree,
    nodeLayer,
    nodeChanged,
    nodeViolations,
    hubSet: buildHubSet(raw.insights),
    cycleMembers: buildCycleMembers(raw.insights),
    layerViolationsBySource: buildLayerViolationsBySource(raw.insights),
    reverseIndex: buildReverseIndex(raw.edges),
    generatedAt: raw.generated_at || "",
  };
}

/** Get structural metrics for a single file. Returns null if file not in graph. */
export function getNodeMetrics(graph: GraphHandle, filePath: string): GraphMetrics | null {
  if (!graph.inDegree.has(filePath)) return null;

  const in_degree = graph.inDegree.get(filePath) || 0;
  const out_degree = graph.outDegree.get(filePath) || 0;
  const layer = graph.nodeLayer.get(filePath) || "unknown";
  const is_hub = graph.hubSet.has(filePath);
  const in_cycle = graph.cycleMembers.has(filePath);
  const cycle_peers = graph.cycleMembers.get(filePath) || [];
  const lvs = graph.layerViolationsBySource.get(filePath) || [];
  const isChanged = graph.nodeChanged.get(filePath) || false;
  const violationCount = graph.nodeViolations.get(filePath) || 0;

  return {
    in_degree,
    out_degree,
    is_hub,
    in_cycle,
    cycle_peers,
    layer,
    layer_violation_count: lvs.length,
    layer_violations: lvs,
    impact_score: computeImpactScore(in_degree, violationCount, isChanged, layer),
  };
}

/** Compute impact score for a file based on graph position. Higher = more impactful. */
export function computeImpactScore(
  inDegree: number,
  violationCount: number,
  isChanged: boolean,
  layer: string,
): number {
  const centrality = LAYER_CENTRALITY[layer] ?? 0;
  const score = inDegree * 3 + violationCount * 2 + (isChanged ? 1 : 0) + centrality;
  return Math.round(score * 100) / 100;
}

/**
 * Get files transitively affected by changes to a given file (BFS through reverse deps).
 * Capped at `maxHops` to keep output bounded.
 */
export function getDownstreamAffected(graph: GraphHandle, filePath: string, maxHops = 2): string[] {
  const visited = new Set<string>([filePath]);
  let frontier = [filePath];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const dependent of graph.reverseIndex.get(node) || []) {
        if (!visited.has(dependent)) {
          visited.add(dependent);
          next.push(dependent);
        }
      }
    }
    frontier = next;
  }

  visited.delete(filePath); // exclude the file itself
  return [...visited];
}
