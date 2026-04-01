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

export interface FilterOptions {
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
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SigmaGraphApi {
  applyFilters(opts: FilterOptions): void;
  /** Reset all filters and cascade state — returns graph to default view. */
  resetView(): void;
  focusNode(node: GraphNode): void;
  unfocusNode(): void;
  zoomToNode(nodeId: string): GraphNode | null;
  highlightCascade(nodeId: string, cascadeFiles: Set<string>): void;
  clearHighlight(): void;
  destroy(): void;
}

// ── Internal node attribute shape ─────────────────────────────────────────────

interface NodeAttrs {
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
}

interface EdgeAttrs {
  color: string;
  size: number;
  hidden: boolean;
  confidence: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function nodeSize(node: GraphNode): number {
  return Math.max(2, Math.sqrt(node.entity_count || 1) * 1.5);
}

function edgeSize(confidence?: number): number {
  if (!confidence || confidence >= 1) return 0.4;
  if (confidence >= 0.7) return 0.25;
  return 0.15;
}

/** Sanitize a node id so it can be used as a graphology key (must be a string). */
function safeKey(id: string): string {
  return id;
}

// ── Graph construction helpers ─────────────────────────────────────────────────

function populateNodes(graph: Graph, nodes: GraphNode[]): void {
  for (const node of nodes) {
    graph.addNode(safeKey(node.id), {
      label: node.id.split("/").pop() || node.id,
      x: Math.random() * 1000,
      y: Math.random() * 1000,
      size: nodeSize(node),
      color: (node.violation_count ?? 0) > 0 ? NODE_VIOLATION : node.changed ? NODE_CHANGED : NODE_DEFAULT,
      layer: node.layer || "unknown",
      changed: node.changed || false,
      violation_count: node.violation_count || 0,
      dead_code_count: node.dead_code_count || 0,
      community: node.community ?? -1,
      hidden: false,
    } satisfies NodeAttrs);
  }
}

function populateEdges(graph: Graph, edges: GraphData["edges"]): void {
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    const s = typeof edge.source === "string" ? edge.source : edge.source.id;
    const t = typeof edge.target === "string" ? edge.target : edge.target.id;
    if (!graph.hasNode(s) || !graph.hasNode(t)) continue;
    const key = `${s}-->${t}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    try {
      graph.addEdge(safeKey(s), safeKey(t), {
        color: EDGE_DEFAULT,
        size: edgeSize(edge.confidence),
        hidden: false,
        confidence: edge.confidence ?? 1,
      } satisfies EdgeAttrs);
    } catch (_err) {
      // ignore rare duplicate-edge errors in multi: false mode
    }
  }
}

function applyLayout(graph: Graph, iterations: number): void {
  try {
    forceAtlas2.assign(graph, {
      iterations,
      settings: { gravity: 0.5, scalingRatio: 5, barnesHutOptimize: true, slowDown: 2 },
    });
  } catch (_err) {
    // If FA2 fails (e.g. disconnected graph), positions stay random — still renderable
  }
}

function applyCommunityDetection(graph: Graph): void {
  try {
    louvain.assign(graph as Parameters<typeof louvain.assign>[0], { nodeCommunityAttribute: "community" });
  } catch (_err) {
    // Community detection is optional — non-fatal
  }
}

// ── Reducer helpers ───────────────────────────────────────────────────────────

function reduceNodeCascade(
  nodeId: string,
  data: NodeAttrs,
  cascadeRoot: string,
  cascadeFiles: Set<string>,
): Partial<NodeAttrs> {
  if (nodeId === cascadeRoot) return { ...data, color: "#60a5fa", hidden: false };
  if (cascadeFiles.has(nodeId)) return { ...data, color: "#fbbf24", hidden: false };
  return { ...data, color: NODE_UNFOCUSED, hidden: false };
}

function reduceNodeFocus(
  nodeId: string,
  data: NodeAttrs,
  gn: GraphNode,
  focusedNodeId: string,
  focusedConnected: Set<string>,
  nodeBaseColor: (gn: GraphNode) => string,
): Partial<NodeAttrs> {
  const baseColor = nodeBaseColor(gn);
  if (nodeId === focusedNodeId) {
    return { ...data, color: baseColor, size: nodeSize(gn) + 3, hidden: false };
  }
  if (focusedConnected.has(nodeId)) {
    return { ...data, color: baseColor, size: nodeSize(gn), hidden: false };
  }
  return {
    ...data,
    color: (gn.violation_count ?? 0) > 0 ? "rgba(255,107,107,0.25)" : NODE_UNFOCUSED,
    size: nodeSize(gn),
    hidden: false,
  };
}

function reduceNodeFilter(
  nodeId: string,
  data: NodeAttrs,
  gn: GraphNode,
  f: FilterOptions,
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean,
  nodeBaseColor: (gn: GraphNode) => string,
): Partial<NodeAttrs> {
  if (!f.activeLayers.has(gn.layer)) return { ...data, hidden: true };
  if (f.insightFilter !== null && !f.insightFilter.has(nodeId)) return { ...data, hidden: true };
  if (f.prReviewFiles !== null && !f.prReviewFiles.has(nodeId)) return { ...data, hidden: true };
  if (f.showChangedOnly && !gn.changed) return { ...data, hidden: true };

  const parsed = f.parsedSearch;
  const q = (parsed.textQuery || "").toLowerCase();
  const hasSearch = q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
  if (hasSearch && !matchesSearch(gn, parsed, q)) return { ...data, hidden: true };

  return { ...data, hidden: false, color: nodeBaseColor(gn), size: nodeSize(gn) };
}

function reduceEdgeCascade(s: string, t: string, data: EdgeAttrs, cascadeFiles: Set<string>): Partial<EdgeAttrs> {
  const bothIn = cascadeFiles.has(s) && cascadeFiles.has(t);
  return { ...data, color: bothIn ? EDGE_HIGHLIGHTED : EDGE_VERY_DIM };
}

function reduceEdgeFocus(s: string, t: string, data: EdgeAttrs, focusedNodeId: string): Partial<EdgeAttrs> {
  const adjacent = s === focusedNodeId || t === focusedNodeId;
  return { ...data, color: adjacent ? EDGE_ADJACENT_FOCUS : EDGE_DIM, size: adjacent ? 0.8 : 0.2 };
}

/** Classify a pair of endpoints as both-in, one-in, or neither for a set filter. */
function setFilterColor(sIn: boolean, tIn: boolean): string {
  if (sIn && tIn) return EDGE_HIGHLIGHTED;
  if (sIn || tIn) return EDGE_SEMI_DIM;
  return EDGE_DEFAULT;
}

function resolveEdgeFilterColor(
  s: string,
  t: string,
  f: FilterOptions,
  nodeIndex: Map<string, GraphNode>,
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean,
): string {
  if (f.prReviewFiles !== null) {
    return setFilterColor(f.prReviewFiles.has(s), f.prReviewFiles.has(t));
  }
  if (f.insightFilter !== null) {
    return setFilterColor(f.insightFilter.has(s), f.insightFilter.has(t));
  }

  const parsed = f.parsedSearch;
  const q = (parsed.textQuery || "").toLowerCase();
  const hasSearch = q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
  if (!hasSearch) return EDGE_DEFAULT;

  const sGn = nodeIndex.get(s);
  const tGn = nodeIndex.get(t);
  const sMatch = sGn ? matchesSearch(sGn, parsed, q) : false;
  const tMatch = tGn ? matchesSearch(tGn, parsed, q) : false;
  return sMatch && tMatch ? EDGE_HIGHLIGHTED : EDGE_DEFAULT;
}

function reduceEdgeFilter(
  s: string,
  t: string,
  data: EdgeAttrs,
  f: FilterOptions,
  nodeVisible: (nodeId: string, f: FilterOptions) => boolean,
  nodeIndex: Map<string, GraphNode>,
  matchesSearch: (gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string) => boolean,
): Partial<EdgeAttrs> {
  if (!nodeVisible(s, f) || !nodeVisible(t, f)) return { ...data, hidden: true };
  const color = resolveEdgeFilterColor(s, t, f, nodeIndex, matchesSearch);
  return { ...data, hidden: false, color };
}

// ── Main builder ───────────────────────────────────────────────────────────────

export function buildSigmaGraph(
  container: HTMLElement,
  data: GraphData,
  opts: {
    onNodeClick: (node: GraphNode) => void;
    onBackgroundClick: () => void;
    edgeIn: Map<string, string[]>;
    edgeOut: Map<string, string[]>;
    layerColors: Record<string, string>;
    fa2Iterations?: number; // default 100; SubGraph passes 60 for smaller graphs
  },
): SigmaGraphApi {
  // ── 1. Build Graphology graph ────────────────────────────────────────────

  const graph = new Graph({ type: "directed", multi: false });

  const nodeIndex = new Map<string, GraphNode>();
  for (const node of data.nodes) {
    nodeIndex.set(node.id, node);
  }

  populateNodes(graph, data.nodes);
  populateEdges(graph, data.edges);
  applyLayout(graph, opts.fa2Iterations ?? 100);
  applyCommunityDetection(graph);

  // ── Rendering state (closure-scoped) ─────────────────────────────────────

  let currentFilters: FilterOptions | null = null;
  let focusedNodeId: string | null = null;
  let focusedConnected: Set<string> | null = null;
  let cascadeRoot: string | null = null;
  let cascadeFiles: Set<string> | null = null;

  // ── Helpers for filter logic ──────────────────────────────────────────────

  function matchesSearch(gn: GraphNode, parsed: FilterOptions["parsedSearch"], q: string): boolean {
    if (parsed.filterLayer && !gn.layer.toLowerCase().includes(parsed.filterLayer)) return false;
    if (parsed.filterChanged && !gn.changed) return false;
    if (parsed.filterViolation && !(gn.violation_count && gn.violation_count > 0)) return false;
    if (q.length >= 2 && !gn.id.toLowerCase().includes(q)) return false;
    return true;
  }

  function nodeVisible(nodeId: string, f: FilterOptions): boolean {
    const gn = nodeIndex.get(nodeId);
    if (!gn) return false;
    if (!f.activeLayers.has(gn.layer)) return false;
    if (f.showChangedOnly && !gn.changed) return false;
    if (f.prReviewFiles !== null && !f.prReviewFiles.has(nodeId)) return false;
    if (f.insightFilter !== null && !f.insightFilter.has(nodeId)) return false;
    const parsed = f.parsedSearch;
    const q = (parsed.textQuery || "").toLowerCase();
    const hasSearch = q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
    if (hasSearch && !matchesSearch(gn, parsed, q)) return false;
    return true;
  }

  function nodeBaseColor(gn: GraphNode): string {
    if ((gn.violation_count ?? 0) > 0) return NODE_VIOLATION;
    if (gn.changed) return NODE_CHANGED;
    return NODE_DEFAULT;
  }

  // ── nodeReducer — computes visual props from rendering state ─────────────

  function nodeReducer(nodeId: string, data: NodeAttrs): Partial<NodeAttrs> {
    const gn = nodeIndex.get(nodeId);
    if (!gn) return data;

    if (cascadeRoot && cascadeFiles) {
      return reduceNodeCascade(nodeId, data, cascadeRoot, cascadeFiles);
    }
    if (focusedNodeId && focusedConnected) {
      return reduceNodeFocus(nodeId, data, gn, focusedNodeId, focusedConnected, nodeBaseColor);
    }
    if (currentFilters) {
      return reduceNodeFilter(nodeId, data, gn, currentFilters, matchesSearch, nodeBaseColor);
    }
    return { ...data, hidden: false, color: nodeBaseColor(gn) };
  }

  // ── edgeReducer — computes visual props from rendering state ─────────────

  function edgeReducer(edgeId: string, data: EdgeAttrs): Partial<EdgeAttrs> {
    const [s, t] = graph.extremities(edgeId);

    if (cascadeRoot && cascadeFiles) {
      return reduceEdgeCascade(s, t, data, cascadeFiles);
    }
    if (focusedNodeId) {
      return reduceEdgeFocus(s, t, data, focusedNodeId);
    }
    if (currentFilters) {
      return reduceEdgeFilter(s, t, data, currentFilters, nodeVisible, nodeIndex, matchesSearch);
    }
    return data;
  }

  // ── 4. Create Sigma renderer with reducers ────────────────────────────────

  const sigma = new Sigma(graph as unknown as import("graphology").default, container, {
    renderEdgeLabels: false,
    renderLabels: false,
    defaultEdgeColor: EDGE_DEFAULT,
    labelFont: "'Inter', sans-serif",
    labelSize: 11,
    labelColor: { color: "#9ca3af" },
    defaultNodeColor: NODE_DEFAULT,
    nodeReducer: nodeReducer as unknown as (node: string, data: Record<string, unknown>) => Record<string, unknown>,
    edgeReducer: edgeReducer as unknown as (edge: string, data: Record<string, unknown>) => Record<string, unknown>,
  });

  // ── 5. Drag support ────────────────────────────────────────────────────

  let draggedNode: string | null = null;
  let isDragging = false;

  sigma.on("downNode", ({ node, event: _event }: { node: string; event: MouseEvent }) => {
    draggedNode = node;
    isDragging = false;
    sigma.getCamera().disable();
  });

  sigma.getMouseCaptor().on("mousemovebody", (event: { original: MouseEvent }) => {
    if (!draggedNode) return;
    isDragging = true;
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

  // ── 6. Event handlers ────────────────────────────────────────────────────

  sigma.on("clickNode", ({ node }: { node: string }) => {
    if (isDragging) return; // don't fire click after drag
    const gn = nodeIndex.get(node);
    if (gn) opts.onNodeClick(gn);
  });

  sigma.on("clickStage", () => {
    opts.onBackgroundClick();
  });

  // ── API methods ────────────────────────────────────────────────────────────

  function applyFilters(f: FilterOptions): void {
    currentFilters = f;
    // Clear cascade/focus so filter mode takes precedence
    cascadeRoot = null;
    cascadeFiles = null;
    focusedNodeId = null;
    focusedConnected = null;
    sigma.refresh();
  }

  function focusNode(node: GraphNode): void {
    focusedNodeId = node.id;
    focusedConnected = new Set([node.id]);
    for (const f of opts.edgeOut.get(node.id) || []) focusedConnected.add(f);
    for (const f of opts.edgeIn.get(node.id) || []) focusedConnected.add(f);

    sigma.refresh();

    // Animate camera to node
    const nodeDisplayData = sigma.getNodeDisplayData(node.id);
    if (nodeDisplayData) {
      sigma.getCamera().animate({ x: nodeDisplayData.x, y: nodeDisplayData.y, ratio: 0.4 }, { duration: 400 });
    }
  }

  function unfocusNode(): void {
    focusedNodeId = null;
    focusedConnected = null;
    sigma.refresh();
  }

  function zoomToNode(nodeId: string): GraphNode | null {
    const gn = nodeIndex.get(nodeId);
    if (!gn || !graph.hasNode(nodeId)) return null;
    const nodeDisplayData = sigma.getNodeDisplayData(nodeId);
    if (!nodeDisplayData) return null;
    sigma.getCamera().animate({ x: nodeDisplayData.x, y: nodeDisplayData.y, ratio: 0.2 }, { duration: 500 });
    return gn;
  }

  function highlightCascade(nodeId: string, files: Set<string>): void {
    // Copy the caller's set and add the root — never mutate caller's data
    cascadeRoot = nodeId;
    cascadeFiles = new Set(files);
    cascadeFiles.add(nodeId);
    sigma.refresh();
  }

  function resetView(): void {
    // Clear all rendering state — returns graph to the default (natural colors) view.
    currentFilters = null;
    focusedNodeId = null;
    focusedConnected = null;
    cascadeRoot = null;
    cascadeFiles = null;
    sigma.refresh();
  }

  function clearHighlight(): void {
    cascadeRoot = null;
    cascadeFiles = null;
    sigma.refresh();
  }

  function destroy(): void {
    sigma.kill();
    graph.clear();
  }

  const api: SigmaGraphApi = {
    applyFilters,
    resetView,
    focusNode,
    unfocusNode,
    zoomToNode,
    highlightCascade,
    clearHighlight,
    destroy,
  };

  // Expose graph internals on window for Playwright integration tests.
  // This allows tests to inspect node display data, colors, and hidden state
  // without trying to read WebGL pixel colors from the canvas.
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__SIGMA_GRAPH__ = { graph, sigma, api, nodeIndex };
  }

  return api;
}
