import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import louvain from "graphology-communities-louvain";
import {
  getLayerColor,
  NODE_DEFAULT,
  NODE_CHANGED,
  NODE_UNFOCUSED,
  NODE_DIM,
  NODE_HIGHLY_DIM,
  EDGE_DEFAULT,
  EDGE_HIGHLIGHTED,
  EDGE_SEMI_DIM,
  EDGE_DIM,
  EDGE_VERY_DIM,
  EDGE_ADJACENT_FOCUS,
} from "./constants";
import { escapeHtml } from "./escapeHtml";
import type { GraphData, GraphNode } from "../stores/graphData";

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

// ── Tooltip DOM helper ─────────────────────────────────────────────────────────

function makeTooltip(container: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "graph-tooltip";
  el.id = "sigma-graph-tooltip";
  el.style.display = "none"; // position, pointer-events, z-index handled by .graph-tooltip CSS
  container.style.position = "relative";
  container.appendChild(el);
  return el;
}

function showTooltip(
  tooltip: HTMLElement,
  container: HTMLElement,
  x: number,
  y: number,
  html: string,
): void {
  tooltip.innerHTML = html;
  tooltip.style.display = "block";
  const rect = container.getBoundingClientRect();
  const tw = tooltip.offsetWidth || 200;
  const th = tooltip.offsetHeight || 60;
  let left = x - rect.left + 14;
  let top = y - rect.top - 10;
  if (left + tw > rect.width) left = Math.max(0, rect.width - tw - 8);
  if (top + th > rect.height) top = Math.max(0, top - th - 20);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip(tooltip: HTMLElement): void {
  tooltip.style.display = "none";
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
    fa2Iterations?: number;  // default 100; SubGraph passes 60 for smaller graphs
  },
): SigmaGraphApi {
  // ── 1. Build Graphology graph ────────────────────────────────────────────

  const graph = new Graph({ type: "directed", multi: false });

  // Index nodes for quick look-up
  const nodeIndex = new Map<string, GraphNode>();
  for (const node of data.nodes) {
    nodeIndex.set(node.id, node);
  }

  // Add nodes with random initial positions; ForceAtlas2 will move them
  for (const node of data.nodes) {
    const color = getLayerColor(node.layer, opts.layerColors);
    graph.addNode(safeKey(node.id), {
      label: node.id.split("/").pop() || node.id,
      x: Math.random() * 1000,
      y: Math.random() * 1000,
      size: nodeSize(node),
      color: node.changed ? NODE_CHANGED : color,
      layer: node.layer || "unknown",
      changed: node.changed || false,
      violation_count: node.violation_count || 0,
      dead_code_count: node.dead_code_count || 0,
      community: node.community ?? -1,
      hidden: false,
    } satisfies NodeAttrs);
  }

  // Add edges — skip duplicates (multi: false, but keep graceful)
  const seenEdges = new Set<string>();
  for (const edge of data.edges) {
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
    } catch {
      // ignore rare duplicate-edge errors in multi: false mode
    }
  }

  // ── 2. ForceAtlas2 layout (synchronous — no web workers in webview) ──────

  try {
    forceAtlas2.assign(graph, {
      iterations: opts.fa2Iterations ?? 100,
      settings: {
        gravity: 0.5,
        scalingRatio: 5,
        barnesHutOptimize: true,
        slowDown: 2,
      },
    });
  } catch {
    // If FA2 fails (e.g. disconnected graph), positions stay random — still renderable
  }

  // ── 3. Louvain community detection ───────────────────────────────────────

  try {
    // Only run on undirected copy because Louvain expects undirected
    // or it handles directed graphs internally — assign directly
    louvain.assign(graph as any, { nodeCommunityAttribute: "community" });
  } catch {
    // Community detection is optional — non-fatal
  }

  // ── Rendering state (closure-scoped) ─────────────────────────────────────

  let currentFilters: FilterOptions | null = null;
  let focusedNodeId: string | null = null;
  let focusedConnected: Set<string> | null = null; // pre-computed neighbor set
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
    const hasPrFilter = f.prReviewFiles !== null;
    if (hasPrFilter && !f.prReviewFiles!.has(nodeId)) return false;
    const hasInsightFilter = f.insightFilter !== null;
    if (hasInsightFilter && !f.insightFilter!.has(nodeId)) return false;
    const parsed = f.parsedSearch;
    const q = (parsed.textQuery || "").toLowerCase();
    const hasSearch =
      q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
    if (hasSearch && !matchesSearch(gn, parsed, q)) return false;
    return true;
  }

  // ── nodeReducer — computes visual props from rendering state ─────────────

  function nodeReducer(nodeId: string, data: NodeAttrs): Partial<NodeAttrs> {
    const gn = nodeIndex.get(nodeId);
    if (!gn) return data;

    // CASCADE mode — highest precedence
    if (cascadeRoot && cascadeFiles) {
      if (nodeId === cascadeRoot) return { ...data, color: "#60a5fa", highlighted: true };
      if (cascadeFiles.has(nodeId)) return { ...data, color: "#fbbf24", highlighted: true };
      return { ...data, color: NODE_UNFOCUSED, highlighted: false };
    }

    // FOCUS mode
    if (focusedNodeId && focusedConnected) {
      if (nodeId === focusedNodeId) return { ...data, color: "#6c8cff", size: nodeSize(gn) + 3 };
      if (focusedConnected.has(nodeId))
        return { ...data, color: getLayerColor(gn.layer, opts.layerColors), size: nodeSize(gn) };
      return { ...data, color: NODE_UNFOCUSED, size: nodeSize(gn) };
    }

    // FILTER mode
    if (currentFilters) {
      const f = currentFilters;
      if (!f.activeLayers.has(gn.layer)) return { ...data, hidden: true };

      const parsed = f.parsedSearch;
      const q = (parsed.textQuery || "").toLowerCase();
      const hasSearch =
        q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
      const hasPrFilter = f.prReviewFiles !== null;
      const hasInsightFilter = f.insightFilter !== null;

      const layerColor = getLayerColor(gn.layer, opts.layerColors);
      const isSearchMatch = hasSearch && matchesSearch(gn, parsed, q);
      const isPrMatch = hasPrFilter && f.prReviewFiles!.has(nodeId);
      const isInsightMatch = hasInsightFilter && f.insightFilter!.has(nodeId);

      if (isInsightMatch || isPrMatch || isSearchMatch) {
        return { ...data, hidden: false, color: layerColor, size: nodeSize(gn) + 2 };
      } else if (f.showChangedOnly && !gn.changed) {
        return { ...data, hidden: false, color: NODE_HIGHLY_DIM, size: nodeSize(gn) };
      } else if (
        (hasPrFilter && !isPrMatch) ||
        (hasInsightFilter && !isInsightMatch) ||
        (hasSearch && !isSearchMatch)
      ) {
        return { ...data, hidden: false, color: NODE_DIM, size: nodeSize(gn) };
      } else {
        return {
          ...data,
          hidden: false,
          color: gn.changed ? NODE_CHANGED : layerColor,
          size: nodeSize(gn) + (gn.changed ? 1 : 0),
        };
      }
    }

    // DEFAULT — return data as-is (initial graph attributes applied)
    return data;
  }

  // ── edgeReducer — computes visual props from rendering state ─────────────

  function edgeReducer(edgeId: string, data: EdgeAttrs): Partial<EdgeAttrs> {
    const [s, t] = graph.extremities(edgeId);

    // CASCADE mode — highest precedence
    if (cascadeRoot && cascadeFiles) {
      const bothIn = cascadeFiles.has(s) && cascadeFiles.has(t);
      return { ...data, color: bothIn ? EDGE_HIGHLIGHTED : EDGE_VERY_DIM };
    }

    // FOCUS mode
    if (focusedNodeId) {
      const adjacent = s === focusedNodeId || t === focusedNodeId;
      return { ...data, color: adjacent ? EDGE_ADJACENT_FOCUS : EDGE_DIM, size: adjacent ? 0.8 : 0.2 };
    }

    // FILTER mode
    if (currentFilters) {
      const f = currentFilters;
      const sVisible = nodeVisible(s, f);
      const tVisible = nodeVisible(t, f);
      if (!sVisible && !tVisible) return { ...data, hidden: true };

      const hasPrFilter = f.prReviewFiles !== null;
      const hasInsightFilter = f.insightFilter !== null;
      const parsed = f.parsedSearch;
      const q = (parsed.textQuery || "").toLowerCase();
      const hasSearch =
        q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;

      let color: string;
      if (hasPrFilter) {
        const sIn = f.prReviewFiles!.has(s);
        const tIn = f.prReviewFiles!.has(t);
        color = sIn && tIn ? EDGE_HIGHLIGHTED : sIn || tIn ? EDGE_SEMI_DIM : EDGE_DIM;
      } else if (hasInsightFilter) {
        const sIn = f.insightFilter!.has(s);
        const tIn = f.insightFilter!.has(t);
        color = sIn && tIn ? EDGE_HIGHLIGHTED : sIn || tIn ? EDGE_SEMI_DIM : EDGE_DIM;
      } else if (hasSearch) {
        const sGn = nodeIndex.get(s);
        const tGn = nodeIndex.get(t);
        const sMatch = sGn ? matchesSearch(sGn, parsed, q) : false;
        const tMatch = tGn ? matchesSearch(tGn, parsed, q) : false;
        color = sMatch || tMatch ? EDGE_HIGHLIGHTED : EDGE_DIM;
      } else {
        color = EDGE_DEFAULT;
      }
      return { ...data, hidden: false, color };
    }

    // DEFAULT
    return data;
  }

  // ── 4. Create Sigma renderer with reducers ────────────────────────────────

  const sigma = new Sigma(graph as any, container, {
    renderEdgeLabels: false,
    defaultEdgeColor: EDGE_DEFAULT,
    labelRenderedSizeThreshold: 14,
    labelFont: "'Inter', sans-serif",
    labelSize: 11,
    labelColor: { color: "#9ca3af" },
    defaultNodeColor: NODE_DEFAULT,
    nodeReducer: nodeReducer as any,
    edgeReducer: edgeReducer as any,
  });

  // ── 5. Drag support ────────────────────────────────────────────────────

  let draggedNode: string | null = null;
  let isDragging = false;

  sigma.on("downNode", ({ node, event }: { node: string; event: MouseEvent }) => {
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

  // ── 6. Tooltip ────────────────────────────────────────────────────────────

  const tooltip = makeTooltip(container);

  sigma.on("enterNode", ({ node, event }: { node: string; event: MouseEvent }) => {
    const gn = nodeIndex.get(node);
    if (!gn) return;
    const color = getLayerColor(gn.layer, opts.layerColors);
    let meta = `<span style="color:${color}">${escapeHtml(gn.layer)}</span>`;
    if (gn.violation_count) {
      meta += ` · <span style="color:var(--danger,#ef4444)">${gn.violation_count} violations</span>`;
    }
    if (gn.changed) {
      meta += ' · <span style="color:var(--info,#6c8cff)">changed</span>';
    }
    if (gn.dead_code_count) {
      meta += ` · <span style="color:#888">${gn.dead_code_count} dead</span>`;
    }
    showTooltip(
      tooltip,
      container,
      event.clientX,
      event.clientY,
      `<strong>${escapeHtml(gn.id)}</strong><div class="tt-meta">${meta}</div>`,
    );
  });

  sigma.on("leaveNode", () => hideTooltip(tooltip));
  sigma.on("leaveStage", () => hideTooltip(tooltip));

  // ── 7. Event handlers ────────────────────────────────────────────────────

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
      sigma.getCamera().animate(
        { x: nodeDisplayData.x, y: nodeDisplayData.y, ratio: 0.4 },
        { duration: 400 },
      );
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
    sigma.getCamera().animate(
      { x: nodeDisplayData.x, y: nodeDisplayData.y, ratio: 0.2 },
      { duration: 500 },
    );
    return gn;
  }

  function highlightCascade(nodeId: string, files: Set<string>): void {
    // Copy the caller's set and add the root — never mutate caller's data
    cascadeRoot = nodeId;
    cascadeFiles = new Set(files);
    cascadeFiles.add(nodeId);
    sigma.refresh();
  }

  function clearHighlight(): void {
    cascadeRoot = null;
    cascadeFiles = null;
    sigma.refresh();
  }

  function destroy(): void {
    hideTooltip(tooltip);
    tooltip.remove();
    sigma.kill();
    graph.clear();
  }

  return {
    applyFilters,
    focusNode,
    unfocusNode,
    zoomToNode,
    highlightCascade,
    clearHighlight,
    destroy,
  };
}
