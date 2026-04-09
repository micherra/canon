import { EDGE_DEFAULT, NODE_CHANGED, NODE_DEFAULT, NODE_VIOLATION } from "@shared/lib/constants";
import type { GraphData, GraphNode } from "@shared/lib/types";
import type Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";

// ── Internal node attribute shape ─────────────────────────────────────────────

export type NodeAttrs = {
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  // Canon fields
  layer: string;
  changed: boolean;
  violation_count: number;
  dead_code_count: number;
  community: number;
  // Rendering state
  hidden: boolean;
};

export type EdgeAttrs = {
  color: string;
  size: number;
  hidden: boolean;
  confidence: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export const nodeSize = (node: GraphNode): number =>
  Math.max(2, Math.sqrt(node.entity_count || 1) * 1.5);

export const edgeSize = (confidence?: number): number => {
  if (!confidence || confidence >= 1) return 0.4;
  if (confidence >= 0.7) return 0.25;
  return 0.15;
};

/** Sanitize a node id so it can be used as a graphology key (must be a string). */
export const safeKey = (id: string): string => id;

// ── Graph construction helpers ─────────────────────────────────────────────────

export const initialNodeColor = (node: GraphNode): string => {
  if ((node.violation_count ?? 0) > 0) return NODE_VIOLATION;
  if (node.changed) return NODE_CHANGED;
  return NODE_DEFAULT;
};

export const buildNodeAttrs = (node: GraphNode): NodeAttrs => ({
  changed: node.changed || false,
  color: initialNodeColor(node),
  community: node.community ?? -1,
  dead_code_count: node.dead_code_count || 0,
  hidden: false,
  label: node.id.split("/").pop() || node.id,
  layer: node.layer || "unknown",
  size: nodeSize(node),
  violation_count: node.violation_count || 0,
  x: Math.random() * 1000,
  y: Math.random() * 1000,
});

export const populateNodes = (graph: Graph, nodes: GraphNode[]): void => {
  for (const node of nodes) {
    graph.addNode(safeKey(node.id), buildNodeAttrs(node));
  }
};

export const resolveEdgeEndpoint = (endpoint: string | { id: string }): string =>
  typeof endpoint === "string" ? endpoint : endpoint.id;

export const tryAddEdge = (graph: Graph, s: string, t: string, confidence?: number): void => {
  try {
    graph.addEdge(safeKey(s), safeKey(t), {
      color: EDGE_DEFAULT,
      confidence: confidence ?? 1,
      hidden: false,
      size: edgeSize(confidence),
    } satisfies EdgeAttrs);
  } catch (_err) {
    // ignore rare duplicate-edge errors in multi: false mode
  }
};

export const populateEdges = (graph: Graph, edges: GraphData["edges"]): void => {
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    const s = resolveEdgeEndpoint(edge.source);
    const t = resolveEdgeEndpoint(edge.target);
    if (!graph.hasNode(s) || !graph.hasNode(t)) continue;
    const key = `${s}-->${t}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    tryAddEdge(graph, s, t, edge.confidence);
  }
};

export const applyGraphLayout = (graph: Graph, iterations: number): void => {
  try {
    forceAtlas2.assign(graph, {
      iterations,
      settings: { barnesHutOptimize: true, gravity: 0.5, scalingRatio: 5, slowDown: 2 },
    });
  } catch (_err) {
    // If FA2 fails (e.g. disconnected graph), positions stay random — still renderable
  }
};

export const applyCommunityDetection = (graph: Graph): void => {
  try {
    louvain.assign(graph as Parameters<typeof louvain.assign>[0], {
      nodeCommunityAttribute: "community",
    });
  } catch (_err) {
    // Community detection is optional — non-fatal
  }
};
