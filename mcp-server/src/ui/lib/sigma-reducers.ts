import {
  EDGE_ADJACENT_FOCUS,
  EDGE_DEFAULT,
  EDGE_DIM,
  EDGE_HIGHLIGHTED,
  EDGE_SEMI_DIM,
  EDGE_VERY_DIM,
  NODE_UNFOCUSED,
} from "@shared/lib/constants";
import type { GraphNode } from "@shared/lib/types";
import type { EdgeAttrs, NodeAttrs } from "./sigma-builders";
import { nodeSize } from "./sigma-builders";

// ── Filter options type (shared between sigmaGraph and reducers) ──────────────

export type FilterOptions = {
  activeLayers: Set<string>;
  searchQuery: string;
  parsedSearch: {
    textQuery: string;
    filterLayer: string | null;
    filterChanged: boolean;
    filterViolation: boolean;
  };
  prReviewFiles: Set<string> | null;
  insightFilter: Set<string> | null;
  showChangedOnly: boolean;
};

// ── Filter logic (module-scope to avoid nesting penalty) ─────────────────────

export const matchesSearchFilter = (
  gn: GraphNode,
  parsed: FilterOptions["parsedSearch"],
  q: string,
): boolean => {
  if (parsed.filterLayer && !gn.layer.toLowerCase().includes(parsed.filterLayer)) return false;
  if (parsed.filterChanged && !gn.changed) return false;
  if (parsed.filterViolation && !(gn.violation_count && gn.violation_count > 0)) return false;
  if (q.length >= 2 && !gn.id.toLowerCase().includes(q)) return false;
  return true;
};

export const isNodeVisible = (
  nodeId: string,
  f: FilterOptions,
  nodeIndex: Map<string, GraphNode>,
): boolean => {
  const gn = nodeIndex.get(nodeId);
  if (!gn) return false;
  if (!f.activeLayers.has(gn.layer)) return false;
  if (f.showChangedOnly && !gn.changed) return false;
  if (f.prReviewFiles !== null && !f.prReviewFiles.has(nodeId)) return false;
  if (f.insightFilter !== null && !f.insightFilter.has(nodeId)) return false;
  const parsed = f.parsedSearch;
  const q = (parsed.textQuery || "").toLowerCase();
  const hasSearch =
    q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
  if (hasSearch && !matchesSearchFilter(gn, parsed, q)) return false;
  return true;
};

// ── Reducer helpers ───────────────────────────────────────────────────────────

export const reduceNodeCascade = (
  nodeId: string,
  data: NodeAttrs,
  cascadeRoot: string,
  cascadeFiles: Set<string>,
): Partial<NodeAttrs> => {
  if (nodeId === cascadeRoot) return { ...data, color: "#60a5fa", hidden: false };
  if (cascadeFiles.has(nodeId)) return { ...data, color: "#fbbf24", hidden: false };
  return { ...data, color: NODE_UNFOCUSED, hidden: false };
};

export type NodeFocusCtx = {
  nodeId: string;
  data: NodeAttrs;
  gn: GraphNode;
  focusedNodeId: string;
  focusedConnected: Set<string>;
  nodeBaseColor: (gn: GraphNode) => string;
};

export const reduceNodeFocus = (ctx: NodeFocusCtx): Partial<NodeAttrs> => {
  const { nodeId, data, gn, focusedNodeId, focusedConnected, nodeBaseColor } = ctx;
  const baseColor = nodeBaseColor(gn);
  if (nodeId === focusedNodeId) {
    return { ...data, color: baseColor, hidden: false, size: nodeSize(gn) + 3 };
  }
  if (focusedConnected.has(nodeId)) {
    return { ...data, color: baseColor, hidden: false, size: nodeSize(gn) };
  }
  return {
    ...data,
    color: (gn.violation_count ?? 0) > 0 ? "rgba(255,107,107,0.25)" : NODE_UNFOCUSED,
    hidden: false,
    size: nodeSize(gn),
  };
};

export type NodeFilterCtx = {
  nodeId: string;
  data: NodeAttrs;
  gn: GraphNode;
  f: FilterOptions;
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean;
  nodeBaseColor: (gn: GraphNode) => string;
};

export const reduceNodeFilter = (ctx: NodeFilterCtx): Partial<NodeAttrs> => {
  const { nodeId, data, gn, f, matchesSearch, nodeBaseColor } = ctx;
  if (!f.activeLayers.has(gn.layer)) return { ...data, hidden: true };
  if (f.insightFilter !== null && !f.insightFilter.has(nodeId)) return { ...data, hidden: true };
  if (f.prReviewFiles !== null && !f.prReviewFiles.has(nodeId)) return { ...data, hidden: true };
  if (f.showChangedOnly && !gn.changed) return { ...data, hidden: true };

  const parsed = f.parsedSearch;
  const q = (parsed.textQuery || "").toLowerCase();
  const hasSearch =
    q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
  if (hasSearch && !matchesSearch(gn, parsed, q)) return { ...data, hidden: true };

  return { ...data, color: nodeBaseColor(gn), hidden: false, size: nodeSize(gn) };
};

export const reduceEdgeCascade = (
  s: string,
  t: string,
  data: EdgeAttrs,
  cascadeFiles: Set<string>,
): Partial<EdgeAttrs> => {
  const bothIn = cascadeFiles.has(s) && cascadeFiles.has(t);
  return { ...data, color: bothIn ? EDGE_HIGHLIGHTED : EDGE_VERY_DIM };
};

export const reduceEdgeFocus = (
  s: string,
  t: string,
  data: EdgeAttrs,
  focusedNodeId: string,
): Partial<EdgeAttrs> => {
  const adjacent = s === focusedNodeId || t === focusedNodeId;
  return {
    ...data,
    color: adjacent ? EDGE_ADJACENT_FOCUS : EDGE_DIM,
    size: adjacent ? 0.8 : 0.2,
  };
};

/** Classify a pair of endpoints as both-in, one-in, or neither for a set filter. */
export const setFilterColor = (sIn: boolean, tIn: boolean): string => {
  if (sIn && tIn) return EDGE_HIGHLIGHTED;
  if (sIn || tIn) return EDGE_SEMI_DIM;
  return EDGE_DEFAULT;
};

export type EdgeFilterColorCtx = {
  s: string;
  t: string;
  f: FilterOptions;
  nodeIndex: Map<string, GraphNode>;
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean;
};

export const resolveEdgeFilterColor = (ctx: EdgeFilterColorCtx): string => {
  const { s, t, f, nodeIndex, matchesSearch } = ctx;
  if (f.prReviewFiles !== null) {
    return setFilterColor(f.prReviewFiles.has(s), f.prReviewFiles.has(t));
  }
  if (f.insightFilter !== null) {
    return setFilterColor(f.insightFilter.has(s), f.insightFilter.has(t));
  }

  const parsed = f.parsedSearch;
  const q = (parsed.textQuery || "").toLowerCase();
  const hasSearch =
    q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
  if (!hasSearch) return EDGE_DEFAULT;

  const sGn = nodeIndex.get(s);
  const tGn = nodeIndex.get(t);
  const sMatch = sGn ? matchesSearch(sGn, parsed, q) : false;
  const tMatch = tGn ? matchesSearch(tGn, parsed, q) : false;
  return sMatch && tMatch ? EDGE_HIGHLIGHTED : EDGE_DEFAULT;
};

export type EdgeFilterCtx = {
  s: string;
  t: string;
  data: EdgeAttrs;
  f: FilterOptions;
  nodeVisible: (nodeId: string, f: FilterOptions) => boolean;
  nodeIndex: Map<string, GraphNode>;
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean;
};

export const reduceEdgeFilter = (ctx: EdgeFilterCtx): Partial<EdgeAttrs> => {
  const { s, t, data, f, nodeVisible, nodeIndex, matchesSearch } = ctx;
  if (!nodeVisible(s, f) || !nodeVisible(t, f)) return { ...data, hidden: true };
  const color = resolveEdgeFilterColor({ f, matchesSearch, nodeIndex, s, t });
  return { ...data, color, hidden: false };
};
