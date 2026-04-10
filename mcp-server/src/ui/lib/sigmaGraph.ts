import { EDGE_DEFAULT, NODE_CHANGED, NODE_DEFAULT, NODE_VIOLATION } from "@shared/lib/constants";
import type { GraphData, GraphNode } from "@shared/lib/types";
import Graph from "graphology";
import Sigma from "sigma";
import {
  applyCommunityDetection,
  applyGraphLayout,
  type EdgeAttrs,
  type NodeAttrs,
  populateEdges,
  populateNodes,
} from "./sigma-builders";
import {
  type FilterOptions,
  isNodeVisible,
  matchesSearchFilter,
  reduceEdgeCascade,
  reduceEdgeFilter,
  reduceEdgeFocus,
  reduceNodeCascade,
  reduceNodeFilter,
  reduceNodeFocus,
} from "./sigma-reducers";

// Re-export FilterOptions so existing importers keep working
export type { FilterOptions };

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
