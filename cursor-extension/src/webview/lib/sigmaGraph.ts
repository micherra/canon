import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import louvain from "graphology-communities-louvain";
import { getLayerColor, NODE_DEFAULT, NODE_CHANGED } from "./constants";
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
  highlighted: boolean;
  originalColor: string;
}

interface EdgeAttrs {
  color: string;
  size: number;
  hidden: boolean;
  originalColor: string;
  confidence: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function nodeSize(node: GraphNode): number {
  return Math.max(3, Math.sqrt(node.entity_count || 1) * 2);
}

function edgeSize(confidence?: number): number {
  if (!confidence || confidence >= 1) return 1.5;
  if (confidence >= 0.7) return 1;
  return 0.6;
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
  el.style.cssText =
    "position:absolute;pointer-events:none;display:none;z-index:100;";
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
      color: node.changed ? NODE_CHANGED : (node.color || color),
      layer: node.layer || "unknown",
      changed: node.changed || false,
      violation_count: node.violation_count || 0,
      dead_code_count: node.dead_code_count || 0,
      community: node.community ?? -1,
      hidden: false,
      highlighted: false,
      originalColor: node.changed ? NODE_CHANGED : (node.color || color),
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
        color: "#8899bb55",
        size: edgeSize(edge.confidence),
        hidden: false,
        originalColor: "#8899bb55",
        confidence: edge.confidence ?? 1,
      } satisfies EdgeAttrs);
    } catch {
      // ignore rare duplicate-edge errors in multi: false mode
    }
  }

  // ── 2. ForceAtlas2 layout (synchronous — no web workers in webview) ──────

  try {
    forceAtlas2.assign(graph, {
      iterations: 100,
      settings: {
        gravity: 1,
        scalingRatio: 2,
        barnesHutOptimize: true,
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

  // ── 4. Create Sigma renderer ─────────────────────────────────────────────

  const sigma = new Sigma(graph as any, container, {
    renderEdgeLabels: false,
    defaultEdgeColor: "#8899bb55",
    labelRenderedSizeThreshold: 8,
    labelFont: "'Inter', sans-serif",
    defaultNodeColor: NODE_DEFAULT,
  });

  // ── 5. Tooltip ───────────────────────────────────────────────────────────

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

  // ── 6. Event handlers ────────────────────────────────────────────────────

  sigma.on("clickNode", ({ node }: { node: string }) => {
    const gn = nodeIndex.get(node);
    if (gn) opts.onNodeClick(gn);
  });

  sigma.on("clickStage", () => {
    opts.onBackgroundClick();
  });

  // ── Internal state ───────────────────────────────────────────────────────

  let lastFilters: FilterOptions | null = null;

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

  // ── API methods ────────────────────────────────────────────────────────────

  function applyFilters(f: FilterOptions): void {
    lastFilters = f;
    const parsed = f.parsedSearch;
    const q = (parsed.textQuery || "").toLowerCase();
    const hasSearch =
      q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
    const hasPrFilter = f.prReviewFiles !== null;
    const hasInsightFilter = f.insightFilter !== null;

    graph.forEachNode((nodeId) => {
      const gn = nodeIndex.get(nodeId);
      if (!gn) return;
      const visible = f.activeLayers.has(gn.layer);

      if (!visible) {
        graph.setNodeAttribute(nodeId, "hidden", true);
        return;
      }

      graph.setNodeAttribute(nodeId, "hidden", false);

      // Determine highlight color for matched nodes
      const layerColor = getLayerColor(gn.layer, opts.layerColors);
      const isSearchMatch = hasSearch && matchesSearch(gn, parsed, q);
      const isPrMatch = hasPrFilter && f.prReviewFiles!.has(nodeId);
      const isInsightMatch = hasInsightFilter && f.insightFilter!.has(nodeId);

      let color: string;
      let size: number;

      if (isInsightMatch || isPrMatch || isSearchMatch) {
        color = layerColor;
        size = nodeSize(gn) + 2;
      } else if (f.showChangedOnly && !gn.changed) {
        color = NODE_DEFAULT + "22"; // highly dimmed
        size = nodeSize(gn);
      } else if ((hasPrFilter && !isPrMatch) || (hasInsightFilter && !isInsightMatch) || (hasSearch && !isSearchMatch)) {
        color = NODE_DEFAULT + "33"; // dimmed
        size = nodeSize(gn);
      } else {
        color = gn.changed ? NODE_CHANGED : (gn.color || getLayerColor(gn.layer, opts.layerColors));
        size = nodeSize(gn) + (gn.changed ? 1 : 0);
      }

      graph.setNodeAttribute(nodeId, "color", color);
      graph.setNodeAttribute(nodeId, "size", size);
    });

    graph.forEachEdge((edgeId) => {
      const [s, t] = graph.extremities(edgeId);
      const sVisible = nodeVisible(s, f);
      const tVisible = nodeVisible(t, f);
      graph.setEdgeAttribute(edgeId, "hidden", !sVisible && !tVisible);

      if (hasPrFilter) {
        const sIn = f.prReviewFiles!.has(s);
        const tIn = f.prReviewFiles!.has(t);
        graph.setEdgeAttribute(edgeId, "color", sIn && tIn ? "#8899bbcc" : sIn || tIn ? "#8899bb44" : "#8899bb11");
      } else if (hasInsightFilter) {
        const sIn = f.insightFilter!.has(s);
        const tIn = f.insightFilter!.has(t);
        graph.setEdgeAttribute(edgeId, "color", sIn && tIn ? "#8899bbcc" : sIn || tIn ? "#8899bb44" : "#8899bb11");
      } else if (hasSearch) {
        const sGn = nodeIndex.get(s);
        const tGn = nodeIndex.get(t);
        const sMatch = sGn ? matchesSearch(sGn, parsed, q) : false;
        const tMatch = tGn ? matchesSearch(tGn, parsed, q) : false;
        graph.setEdgeAttribute(edgeId, "color", sMatch || tMatch ? "#8899bbcc" : "#8899bb11");
      } else {
        graph.setEdgeAttribute(edgeId, "color", "#8899bb55");
      }
    });

    sigma.refresh();
  }

  function focusNode(node: GraphNode): void {
    const connected = new Set([node.id]);
    for (const f of opts.edgeOut.get(node.id) || []) connected.add(f);
    for (const f of opts.edgeIn.get(node.id) || []) connected.add(f);

    graph.forEachNode((nodeId) => {
      const isConnected = connected.has(nodeId);
      const gn = nodeIndex.get(nodeId);
      if (!gn) return;
      if (nodeId === node.id) {
        graph.setNodeAttribute(nodeId, "color", "#e8eaf0");
        graph.setNodeAttribute(nodeId, "size", nodeSize(gn) + 3);
      } else if (isConnected) {
        graph.setNodeAttribute(nodeId, "color", getLayerColor(gn.layer, opts.layerColors));
        graph.setNodeAttribute(nodeId, "size", nodeSize(gn));
      } else {
        graph.setNodeAttribute(nodeId, "color", NODE_DEFAULT + "11");
        graph.setNodeAttribute(nodeId, "size", nodeSize(gn));
      }
    });

    graph.forEachEdge((edgeId) => {
      const [s, t] = graph.extremities(edgeId);
      const adjacent = s === node.id || t === node.id;
      graph.setEdgeAttribute(edgeId, "color", adjacent ? "#ffffff66" : "#8899bb11");
      graph.setEdgeAttribute(edgeId, "size", adjacent ? 2 : 0.5);
    });

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
    if (lastFilters) {
      applyFilters(lastFilters);
    } else {
      // Reset to defaults
      graph.forEachNode((nodeId) => {
        const gn = nodeIndex.get(nodeId);
        if (!gn) return;
        const orig = graph.getNodeAttribute(nodeId, "originalColor") as string || NODE_DEFAULT;
        graph.setNodeAttribute(nodeId, "color", orig);
        graph.setNodeAttribute(nodeId, "size", nodeSize(gn));
      });
      graph.forEachEdge((edgeId) => {
        const orig = graph.getEdgeAttribute(edgeId, "originalColor") as string || "#8899bb55";
        graph.setEdgeAttribute(edgeId, "color", orig);
        graph.setEdgeAttribute(edgeId, "size", 1.5);
      });
      sigma.refresh();
    }
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

  function highlightCascade(nodeId: string, cascadeFiles: Set<string>): void {
    cascadeFiles.add(nodeId);

    graph.forEachNode((nId) => {
      const inCascade = cascadeFiles.has(nId);
      if (nId === nodeId) {
        graph.setNodeAttribute(nId, "color", "#60a5fa");
        graph.setNodeAttribute(nId, "highlighted", true);
      } else if (inCascade) {
        graph.setNodeAttribute(nId, "color", "#fbbf24");
        graph.setNodeAttribute(nId, "highlighted", true);
      } else {
        graph.setNodeAttribute(nId, "color", NODE_DEFAULT + "11");
        graph.setNodeAttribute(nId, "highlighted", false);
      }
    });

    graph.forEachEdge((edgeId) => {
      const [s, t] = graph.extremities(edgeId);
      const bothInCascade = cascadeFiles.has(s) && cascadeFiles.has(t);
      graph.setEdgeAttribute(edgeId, "color", bothInCascade ? "#8899bbcc" : "#8899bb0a");
    });

    sigma.refresh();
  }

  function clearHighlight(): void {
    graph.forEachNode((nodeId) => {
      graph.setNodeAttribute(nodeId, "highlighted", false);
    });
    if (lastFilters) {
      applyFilters(lastFilters);
    } else {
      graph.forEachNode((nodeId) => {
        const orig = graph.getNodeAttribute(nodeId, "originalColor") as string || NODE_DEFAULT;
        graph.setNodeAttribute(nodeId, "color", orig);
      });
      graph.forEachEdge((edgeId) => {
        const orig = graph.getEdgeAttribute(edgeId, "originalColor") as string || "#8899bb55";
        graph.setEdgeAttribute(edgeId, "color", orig);
      });
      sigma.refresh();
    }
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
