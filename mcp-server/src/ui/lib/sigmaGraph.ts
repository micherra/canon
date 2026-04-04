import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import {
  EDGE_ADJACENT_FOCUS,
  EDGE_DEFAULT,
  EDGE_DIM,
  EDGE_HIGHLIGHTED,
  EDGE_SEMI_DIM,
  EDGE_VERY_DIM,
  NODE_CHANGED,
  NODE_DEFAULT,
  NODE_UNFOCUSED,
  NODE_VIOLATION,
} from "./constants";
import type { GraphData, GraphNode } from "./types";

// ── Filter options (mirrors GraphApi's FilterOptions) ────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

export type SigmaGraphApi = {
  applyFilters(opts: FilterOptions): void;
  /** Reset all filters and cascade state — returns graph to default view. */
  resetView(): void;
  focusNode(node: GraphNode): void;
  unfocusNode(): void;
  zoomToNode(nodeId: string): GraphNode | null;
  highlightCascade(nodeId: string, cascadeFiles: Set<string>): void;
  clearHighlight(): void;
  destroy(): void;
};

// ── Internal node attribute shape ─────────────────────────────────────────────

type NodeAttrs = {
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

type EdgeAttrs = {
  color: string;
  size: number;
  hidden: boolean;
  confidence: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const nodeSize = (node: GraphNode): number => Math.max(2, Math.sqrt(node.entity_count || 1) * 1.5);

const edgeSize = (confidence?: number): number => {
  if (!confidence || confidence >= 1) return 0.4;
  if (confidence >= 0.7) return 0.25;
  return 0.15;
};

/** Sanitize a node id so it can be used as a graphology key (must be a string). */
const safeKey = (id: string): string => id;

// ── Graph construction helpers ─────────────────────────────────────────────────

const initialNodeColor = (node: GraphNode): string => {
  if ((node.violation_count ?? 0) > 0) return NODE_VIOLATION;
  if (node.changed) return NODE_CHANGED;
  return NODE_DEFAULT;
};

const buildNodeAttrs = (node: GraphNode): NodeAttrs => ({
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

const populateNodes = (graph: Graph, nodes: GraphNode[]): void => {
  for (const node of nodes) {
    graph.addNode(safeKey(node.id), buildNodeAttrs(node));
  }
};

const resolveEdgeEndpoint = (endpoint: string | { id: string }): string =>
  typeof endpoint === "string" ? endpoint : endpoint.id;

const tryAddEdge = (graph: Graph, s: string, t: string, confidence?: number): void => {
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

const populateEdges = (graph: Graph, edges: GraphData["edges"]): void => {
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

const applyGraphLayout = (graph: Graph, iterations: number): void => {
  try {
    forceAtlas2.assign(graph, {
      iterations,
      settings: { barnesHutOptimize: true, gravity: 0.5, scalingRatio: 5, slowDown: 2 },
    });
  } catch (_err) {
    // If FA2 fails (e.g. disconnected graph), positions stay random — still renderable
  }
};

const applyCommunityDetection = (graph: Graph): void => {
  try {
    louvain.assign(graph as Parameters<typeof louvain.assign>[0], {
      nodeCommunityAttribute: "community",
    });
  } catch (_err) {
    // Community detection is optional — non-fatal
  }
};

// ── Filter logic (module-scope to avoid nesting penalty) ─────────────────────

const matchesSearchFilter = (
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

const isNodeVisible = (
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

const reduceNodeCascade = (
  nodeId: string,
  data: NodeAttrs,
  cascadeRoot: string,
  cascadeFiles: Set<string>,
): Partial<NodeAttrs> => {
  if (nodeId === cascadeRoot) return { ...data, color: "#60a5fa", hidden: false };
  if (cascadeFiles.has(nodeId)) return { ...data, color: "#fbbf24", hidden: false };
  return { ...data, color: NODE_UNFOCUSED, hidden: false };
};

type NodeFocusCtx = {
  nodeId: string;
  data: NodeAttrs;
  gn: GraphNode;
  focusedNodeId: string;
  focusedConnected: Set<string>;
  nodeBaseColor: (gn: GraphNode) => string;
};

const reduceNodeFocus = (ctx: NodeFocusCtx): Partial<NodeAttrs> => {
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

type NodeFilterCtx = {
  nodeId: string;
  data: NodeAttrs;
  gn: GraphNode;
  f: FilterOptions;
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean;
  nodeBaseColor: (gn: GraphNode) => string;
};

const reduceNodeFilter = (ctx: NodeFilterCtx): Partial<NodeAttrs> => {
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

const reduceEdgeCascade = (
  s: string,
  t: string,
  data: EdgeAttrs,
  cascadeFiles: Set<string>,
): Partial<EdgeAttrs> => {
  const bothIn = cascadeFiles.has(s) && cascadeFiles.has(t);
  return { ...data, color: bothIn ? EDGE_HIGHLIGHTED : EDGE_VERY_DIM };
};

const reduceEdgeFocus = (
  s: string,
  t: string,
  data: EdgeAttrs,
  focusedNodeId: string,
): Partial<EdgeAttrs> => {
  const adjacent = s === focusedNodeId || t === focusedNodeId;
  return { ...data, color: adjacent ? EDGE_ADJACENT_FOCUS : EDGE_DIM, size: adjacent ? 0.8 : 0.2 };
};

/** Classify a pair of endpoints as both-in, one-in, or neither for a set filter. */
const setFilterColor = (sIn: boolean, tIn: boolean): string => {
  if (sIn && tIn) return EDGE_HIGHLIGHTED;
  if (sIn || tIn) return EDGE_SEMI_DIM;
  return EDGE_DEFAULT;
};

type EdgeFilterColorCtx = {
  s: string;
  t: string;
  f: FilterOptions;
  nodeIndex: Map<string, GraphNode>;
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean;
};

const resolveEdgeFilterColor = (ctx: EdgeFilterColorCtx): string => {
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

type EdgeFilterCtx = {
  s: string;
  t: string;
  data: EdgeAttrs;
  f: FilterOptions;
  nodeVisible: (nodeId: string, f: FilterOptions) => boolean;
  nodeIndex: Map<string, GraphNode>;
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean;
};

const reduceEdgeFilter = (ctx: EdgeFilterCtx): Partial<EdgeAttrs> => {
  const { s, t, data, f, nodeVisible, nodeIndex, matchesSearch } = ctx;
  if (!nodeVisible(s, f) || !nodeVisible(t, f)) return { ...data, hidden: true };
  const color = resolveEdgeFilterColor({ f, matchesSearch, nodeIndex, s, t });
  return { ...data, color, hidden: false };
};

// ── Drag support wiring ───────────────────────────────────────────────────────

const wireDragHandlers = (sigma: Sigma, graph: Graph): { isDragging: () => boolean } => {
  let draggedNode: string | null = null;
  let dragging = false;

  sigma.on("downNode", ({ node, event: _event }: { node: string; event: MouseEvent }) => {
    draggedNode = node;
    dragging = false;
    sigma.getCamera().disable();
  });

  sigma.getMouseCaptor().on("mousemovebody", (event: { original: MouseEvent }) => {
    if (!draggedNode) return;
    dragging = true;
    const pos = sigma.viewportToGraph({ x: event.original.offsetX, y: event.original.offsetY });
    graph.setNodeAttribute(draggedNode, "x", pos.x);
    graph.setNodeAttribute(draggedNode, "y", pos.y);
  });

  sigma.getMouseCaptor().on("mouseup", () => {
    if (draggedNode) {
      sigma.getCamera().enable();
      draggedNode = null;
    }
  });

  return { isDragging: () => dragging };
};

// ── Click event wiring ────────────────────────────────────────────────────────

type ClickHandlerCtx = {
  sigma: Sigma;
  nodeIndex: Map<string, GraphNode>;
  isDragging: () => boolean;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
};

const wireClickHandlers = (ctx: ClickHandlerCtx): void => {
  const { sigma, nodeIndex, isDragging, onNodeClick, onBackgroundClick } = ctx;
  sigma.on("clickNode", ({ node }: { node: string }) => {
    if (isDragging()) return;
    const gn = nodeIndex.get(node);
    if (gn) onNodeClick(gn);
  });

  sigma.on("clickStage", () => {
    onBackgroundClick();
  });
};

// ── Rendering state container ─────────────────────────────────────────────────

type RenderState = {
  currentFilters: FilterOptions | null;
  focusedNodeId: string | null;
  focusedConnected: Set<string> | null;
  cascadeRoot: string | null;
  cascadeFiles: Set<string> | null;
};

// ── API method factory ────────────────────────────────────────────────────────

type BuildApiCtx = {
  sigma: Sigma;
  graph: Graph;
  nodeIndex: Map<string, GraphNode>;
  state: RenderState;
  edges: { edgeIn: Map<string, string[]>; edgeOut: Map<string, string[]> };
};

const clearRenderState = (state: RenderState): void => {
  state.currentFilters = null;
  state.focusedNodeId = null;
  state.focusedConnected = null;
  state.cascadeRoot = null;
  state.cascadeFiles = null;
};

const animateCamera = (sigma: Sigma, nodeId: string, ratio: number, duration: number): void => {
  const display = sigma.getNodeDisplayData(nodeId);
  if (display) {
    sigma.getCamera().animate({ ratio, x: display.x, y: display.y }, { duration });
  }
};

const buildApi = (ctx: BuildApiCtx): SigmaGraphApi => {
  const { sigma, graph, nodeIndex, state, edges: opts } = ctx;

  return {
    applyFilters: (f: FilterOptions) => {
      state.currentFilters = f;
      state.cascadeRoot = null;
      state.cascadeFiles = null;
      state.focusedNodeId = null;
      state.focusedConnected = null;
      sigma.refresh();
    },
    clearHighlight: () => {
      state.cascadeRoot = null;
      state.cascadeFiles = null;
      sigma.refresh();
    },
    destroy: () => {
      sigma.kill();
      graph.clear();
    },
    focusNode: (node: GraphNode) => {
      state.focusedNodeId = node.id;
      state.focusedConnected = new Set([node.id]);
      for (const f of opts.edgeOut.get(node.id) || []) state.focusedConnected.add(f);
      for (const f of opts.edgeIn.get(node.id) || []) state.focusedConnected.add(f);
      sigma.refresh();
      animateCamera(sigma, node.id, 0.4, 400);
    },
    highlightCascade: (nodeId: string, files: Set<string>) => {
      state.cascadeRoot = nodeId;
      state.cascadeFiles = new Set(files);
      state.cascadeFiles.add(nodeId);
      sigma.refresh();
    },
    resetView: () => {
      clearRenderState(state);
      sigma.refresh();
    },
    unfocusNode: () => {
      state.focusedNodeId = null;
      state.focusedConnected = null;
      sigma.refresh();
    },
    zoomToNode: (nodeId: string) => {
      const gn = nodeIndex.get(nodeId);
      if (!gn || !graph.hasNode(nodeId)) return null;
      animateCamera(sigma, nodeId, 0.2, 500);
      return gn;
    },
  };
};

// ── Main builder ───────────────────────────────────────────────────────────────

type ReducerDeps = {
  graph: Graph;
  nodeIndex: Map<string, GraphNode>;
  state: RenderState;
};

const createNodeReducer = ({ nodeIndex, state }: ReducerDeps) => {
  const nodeBaseColor = (gn: GraphNode): string => {
    if ((gn.violation_count ?? 0) > 0) return NODE_VIOLATION;
    if (gn.changed) return NODE_CHANGED;
    return NODE_DEFAULT;
  };
  const matchesSearch = (
    gn: GraphNode,
    parsed: FilterOptions["parsedSearch"],
    q: string,
  ): boolean => matchesSearchFilter(gn, parsed, q);

  return (nodeId: string, data: NodeAttrs): Partial<NodeAttrs> => {
    const gn = nodeIndex.get(nodeId);
    if (!gn) return data;
    if (state.cascadeRoot && state.cascadeFiles) {
      return reduceNodeCascade(nodeId, data, state.cascadeRoot, state.cascadeFiles);
    }
    if (state.focusedNodeId && state.focusedConnected) {
      return reduceNodeFocus({
        data,
        focusedConnected: state.focusedConnected,
        focusedNodeId: state.focusedNodeId,
        gn,
        nodeBaseColor,
        nodeId,
      });
    }
    if (state.currentFilters) {
      return reduceNodeFilter({
        data,
        f: state.currentFilters,
        gn,
        matchesSearch,
        nodeBaseColor,
        nodeId,
      });
    }
    return { ...data, color: nodeBaseColor(gn), hidden: false };
  };
};

const createEdgeReducer = ({ graph, nodeIndex, state }: ReducerDeps) => {
  const matchesSearch = (
    gn: GraphNode,
    parsed: FilterOptions["parsedSearch"],
    q: string,
  ): boolean => matchesSearchFilter(gn, parsed, q);
  const nodeVisible = (nodeId: string, f: FilterOptions): boolean =>
    isNodeVisible(nodeId, f, nodeIndex);

  return (edgeId: string, data: EdgeAttrs): Partial<EdgeAttrs> => {
    const [s, t] = graph.extremities(edgeId);
    if (state.cascadeRoot && state.cascadeFiles) {
      return reduceEdgeCascade(s, t, data, state.cascadeFiles);
    }
    if (state.focusedNodeId) {
      return reduceEdgeFocus(s, t, data, state.focusedNodeId);
    }
    if (state.currentFilters) {
      return reduceEdgeFilter({
        data,
        f: state.currentFilters,
        matchesSearch,
        nodeIndex,
        nodeVisible,
        s,
        t,
      });
    }
    return data;
  };
};

const createSigmaRenderer = (
  graph: Graph,
  container: HTMLElement,
  nodeReducer: (nodeId: string, data: NodeAttrs) => Partial<NodeAttrs>,
  edgeReducer: (edgeId: string, data: EdgeAttrs) => Partial<EdgeAttrs>,
): Sigma =>
  new Sigma(graph as unknown as import("graphology").default, container, {
    defaultEdgeColor: EDGE_DEFAULT,
    defaultNodeColor: NODE_DEFAULT,
    edgeReducer: edgeReducer as unknown as (
      edge: string,
      data: Record<string, unknown>,
    ) => Record<string, unknown>,
    labelColor: { color: "#9ca3af" },
    labelFont: "'Inter', sans-serif",
    labelSize: 11,
    nodeReducer: nodeReducer as unknown as (
      node: string,
      data: Record<string, unknown>,
    ) => Record<string, unknown>,
    renderEdgeLabels: false,
    renderLabels: false,
  });

export type BuildSigmaGraphOpts = {
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  edgeIn: Map<string, string[]>;
  edgeOut: Map<string, string[]>;
  layerColors: Record<string, string>;
  fa2Iterations?: number; // default 100; SubGraph passes 60 for smaller graphs
};

export const buildSigmaGraph = (
  container: HTMLElement,
  data: GraphData,
  opts: BuildSigmaGraphOpts,
): SigmaGraphApi => {
  const graph = new Graph({ multi: false, type: "directed" });
  const nodeIndex = new Map<string, GraphNode>();
  for (const node of data.nodes) nodeIndex.set(node.id, node);

  populateNodes(graph, data.nodes);
  populateEdges(graph, data.edges);
  applyGraphLayout(graph, opts.fa2Iterations ?? 100);
  applyCommunityDetection(graph);

  const state: RenderState = {
    cascadeFiles: null,
    cascadeRoot: null,
    currentFilters: null,
    focusedConnected: null,
    focusedNodeId: null,
  };

  const deps: ReducerDeps = { graph, nodeIndex, state };
  const sigma = createSigmaRenderer(
    graph,
    container,
    createNodeReducer(deps),
    createEdgeReducer(deps),
  );

  const { isDragging } = wireDragHandlers(sigma, graph);
  wireClickHandlers({
    isDragging,
    nodeIndex,
    onBackgroundClick: opts.onBackgroundClick,
    onNodeClick: opts.onNodeClick,
    sigma,
  });

  const api = buildApi({ edges: opts, graph, nodeIndex, sigma, state });

  // Expose graph internals on window for Playwright integration tests.
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__SIGMA_GRAPH__ = {
      api,
      graph,
      nodeIndex,
      sigma,
    };
  }

  return api;
};
