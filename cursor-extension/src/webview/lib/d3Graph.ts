import { LAYER_COLORS, NODE_DEFAULT, NODE_CHANGED, getLayerColor, truncate } from "./constants";
import { escapeHtml } from "./escapeHtml";
import type { GraphData, GraphNode, GraphEdge } from "../stores/graphData";
import { clusterGraph, expandCluster, CLUSTER_THRESHOLD, type ClusterNode, type ClusteredGraph } from "./cluster";

export interface GraphApi {
  applyFilters(opts: FilterOptions): void;
  focusNode(node: GraphNode): void;
  unfocusNode(): void;
  zoomToNode(nodeId: string): GraphNode | null;
  highlightCascade(nodeId: string, cascadeFiles: Set<string>): void;
  clearHighlight(): void;
  getGraphState(): GraphState | null;
  isClustered(): boolean;
  destroy(): void;
}

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

export interface GraphState {
  svg: any;
  zoom: any;
  nodesCopy: any[];
  nodesCopyMap: Map<string, any>;
  nodeSelection: any;
  linkSelection: any;
  labelSelection: any;
  ringSelection: any;
  width: number;
  height: number;
  currentZoomK: number;
}

function getEdgeIds(e: any): { sId: string; tId: string } {
  return {
    sId: e.source?.id || e.source,
    tId: e.target?.id || e.target,
  };
}

export function buildD3Graph(
  canvas: HTMLElement,
  data: GraphData,
  opts: {
    onNodeClick: (node: GraphNode) => void;
    onBackgroundClick: () => void;
    onClusterExpand?: (clusterKey: string) => void;
    edgeIn: Map<string, string[]>;
    edgeOut: Map<string, string[]>;
    summaries: Record<string, string>;
  },
): GraphApi {
  let graphState: GraphState | null = null;
  let focusedNodeId: string | null = null;
  let lastFilters: FilterOptions | null = null;

  if (typeof d3 === "undefined") {
    canvas.innerHTML = `
      <div style="padding:16px">
        <h3>Graph Data Summary</h3>
        <p>${data.nodes.length} files, ${data.edges.length} dependencies</p>
      </div>
    `;
    return createNoopApi();
  }

  canvas.innerHTML = '<div class="graph-tooltip" id="graph-tooltip"></div>';
  let width = canvas.clientWidth || 800;
  let height = canvas.clientHeight || 600;

  // Apply clustering for large graphs
  const clustered = clusterGraph(data.nodes, data.edges);
  const originalEdges = data.edges;

  const nodesCopy = clustered.nodes.map((n) => ({ ...n }));
  const edgesCopy = clustered.edges.map((e) => ({
    source: typeof e.source === "string" ? e.source : e.source.id,
    target: typeof e.target === "string" ? e.target : e.target.id,
  }));

  const svg = d3
    .select(canvas)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [0, 0, width, height]);

  // Arrow marker
  svg
    .append("defs")
    .append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -3 6 6")
    .attr("refX", 12)
    .attr("refY", 0)
    .attr("markerWidth", 5)
    .attr("markerHeight", 5)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-3L6,0L0,3")
    .attr("fill", "#8899bb")
    .attr("opacity", 0.5);

  const g = svg.append("g");
  let currentZoomK = 1;

  const zoom = d3.zoom().on("zoom", (event: any) => {
    g.attr("transform", event.transform);
    currentZoomK = event.transform.k;
    if (graphState) graphState.currentZoomK = currentZoomK;

    if (focusedNodeId) {
      const connected = new Set([focusedNodeId]);
      for (const f of opts.edgeOut.get(focusedNodeId) || []) connected.add(f);
      for (const f of opts.edgeIn.get(focusedNodeId) || []) connected.add(f);
      labelSelection.attr("opacity", (d: any) => (connected.has(d.id) && currentZoomK > 0.8 ? 0.9 : 0));
    } else {
      labelSelection.attr("opacity", () => (currentZoomK > 1.3 ? 0.8 : 0));
    }
  });

  svg.call(zoom as any);
  svg.on("click", (event: any) => {
    if (event.target.tagName === "svg" || event.target.tagName === "rect") {
      if (focusedNodeId) opts.onBackgroundClick();
    }
  });

  // Layer clustering positions
  const layerPos: Record<string, number> = { api: -1, ui: -0.5, domain: 0, data: 0.5, infra: 1, shared: 0 };

  const simulation = d3
    .forceSimulation(nodesCopy)
    .force("link", d3.forceLink(edgesCopy).id((d: any) => d.id).distance(80))
    .force("charge", d3.forceManyBody().strength(-120))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(20))
    .force("layerX", d3.forceX((d: any) => width / 2 + (layerPos[d.layer] || 0) * width * 0.15).strength(0.04))
    .force("layerY", d3.forceY(height / 2).strength(0.04));

  function nodeRadius(d: any): number {
    if (d.isCluster) return 14 + Math.sqrt(d.expandedFileCount || 4) * 3;
    return 6 + Math.min((d.violation_count || 0) * 2, 14);
  }

  // Curved edges with arrow markers
  const linkSelection = g
    .selectAll(".link")
    .data(edgesCopy)
    .join("path")
    .attr("fill", "none")
    .attr("stroke", "#8899bb")
    .attr("stroke-opacity", 0.35)
    .attr("stroke-width", 1.2)
    .attr("marker-end", "url(#arrow)");

  // Violation rings
  const hasViolation = (n: any) => (n.violation_count || 0) > 0;
  const ringSelection = g
    .selectAll(".violation-ring")
    .data(nodesCopy.filter(hasViolation))
    .join("circle")
    .attr("r", (d: any) => nodeRadius(d) + 4)
    .attr("fill", "none")
    .attr("stroke", "#ef4444")
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", "3,2")
    .attr("opacity", 0.5);

  // Nodes
  const nodeSelection = g
    .selectAll(".node")
    .data(nodesCopy)
    .join("circle")
    .attr("r", (d: any) => (d.isCluster ? nodeRadius(d) : d.changed ? nodeRadius(d) + 2 : nodeRadius(d)))
    .attr("fill", (d: any) => (d.isCluster ? getLayerColor(d.layer) : d.changed ? NODE_CHANGED : NODE_DEFAULT))
    .attr("stroke", (d: any) => (d.isCluster ? "rgba(255,255,255,0.25)" : d.changed ? "rgba(108,140,255,0.4)" : "rgba(255,255,255,0.08)"))
    .attr("stroke-width", (d: any) => (d.isCluster ? 2 : d.changed ? 2.5 : 1))
    .attr("stroke-dasharray", (d: any) => (d.isCluster ? "4,2" : null))
    .attr("opacity", (d: any) => (d.isCluster ? 0.7 : 1))
    .classed("pulse", (d: any) => d.changed && !d.isCluster)
    .style("cursor", "pointer")
    .call(
      d3
        .drag()
        .on("start", (event: any, d: any) => {
          d._dragStartX = event.x;
          d._dragStartY = event.y;
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event: any, d: any) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event: any, d: any) => {
          if (!event.active) simulation.alphaTarget(0);
          const dx = event.x - (d._dragStartX ?? event.x);
          const dy = event.y - (d._dragStartY ?? event.y);
          d.fx = null;
          d.fy = null;
          if (dx * dx + dy * dy < 25) {
            if (d.isCluster && opts.onClusterExpand) {
              opts.onClusterExpand(d.clusterKey);
            } else if (!d.isCluster) {
              opts.onNodeClick(d);
            }
          }
        }) as any,
    );

  // Labels
  const labelSelection = g
    .selectAll(".node-label")
    .data(nodesCopy)
    .join("text")
    .attr("font-size", (d: any) => (d.isCluster ? 10 : 9))
    .attr("fill", (d: any) => (d.isCluster ? "#c8d0e0" : "#8899bb"))
    .attr("font-weight", (d: any) => (d.isCluster ? "600" : "normal"))
    .attr("text-anchor", "middle")
    .attr("dy", (d: any) => nodeRadius(d) + 13)
    .attr("opacity", (d: any) => (d.isCluster ? 0.85 : 0))
    .attr("pointer-events", "none")
    .attr("font-family", "'Inter', sans-serif")
    .text((d: any) => d.isCluster ? `${d.clusterKey} (${d.expandedFileCount})` : d.id.split("/").pop());

  // Tooltip
  const tooltip = canvas.querySelector("#graph-tooltip") as HTMLElement;
  function positionTooltip(event: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const tw = tooltip.offsetWidth || 200;
    const th = tooltip.offsetHeight || 60;
    let left = event.clientX - rect.left + 14;
    let top = event.clientY - rect.top - 10;
    if (left + tw > rect.width) left = Math.max(0, rect.width - tw - 8);
    if (top + th > rect.height) top = Math.max(0, top - th - 20);
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  nodeSelection
    .on("mouseover", (event: MouseEvent, d: any) => {
      if (d.isCluster) {
        let meta = `<span style="color:${getLayerColor(d.layer)}">${escapeHtml(d.layer)}</span>`;
        if (d.violation_count) meta += ` \u00b7 <span style="color:var(--danger)">${d.violation_count} violations</span>`;
        if (d.changed) meta += ' \u00b7 <span style="color:var(--info)">has changes</span>';
        tooltip.innerHTML =
          `<strong>${escapeHtml(d.clusterKey)}/</strong><div class="tt-meta">${meta}</div>` +
          `<div class="tt-summary">${d.expandedFileCount} files — click to expand</div>`;
      } else {
        const summary = opts.summaries[d.id] || "";
        let meta = `<span style="color:${getLayerColor(d.layer)}">${escapeHtml(d.layer)}</span>`;
        if (d.violation_count) meta += ` \u00b7 <span style="color:var(--danger)">${d.violation_count} violations</span>`;
        if (d.changed) meta += ' \u00b7 <span style="color:var(--info)">changed</span>';
        const safeSummary = escapeHtml(summary);
        tooltip.innerHTML =
          `<strong>${escapeHtml(d.id)}</strong><div class="tt-meta">${meta}</div>` +
          (safeSummary ? `<div class="tt-summary">${truncate(safeSummary, 140)}</div>` : "");
      }
      tooltip.classList.add("visible");
      positionTooltip(event);
    })
    .on("mousemove", (event: MouseEvent) => positionTooltip(event))
    .on("mouseout", () => tooltip.classList.remove("visible"));

  // Simulation tick — throttled via requestAnimationFrame for ~60fps
  let tickScheduled = false;
  simulation.on("tick", () => {
    if (tickScheduled) return;
    tickScheduled = true;
    requestAnimationFrame(() => {
      tickScheduled = false;
      linkSelection.attr("d", (d: any) => {
        const dx = d.target.x - d.source.x;
        const dy = d.target.y - d.source.y;
        const dr = Math.sqrt(dx * dx + dy * dy) * 2;
        // Guard: degenerate arc when source and target overlap
        if (dr < 1) return `M${d.source.x},${d.source.y}L${d.target.x},${d.target.y}`;
        return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
      });
      nodeSelection.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
      ringSelection.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
      labelSelection.attr("x", (d: any) => d.x).attr("y", (d: any) => d.y);
    });
  });

  const nodesCopyMap = new Map<string, any>();
  for (const n of nodesCopy) nodesCopyMap.set(n.id, n);

  graphState = { svg, zoom, nodesCopy, nodesCopyMap, nodeSelection, linkSelection, labelSelection, ringSelection, width, height, currentZoomK };

  // Handle canvas resize — update SVG dimensions and simulation forces
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const newW = entry.contentRect.width;
      const newH = entry.contentRect.height;
      if (newW > 0 && newH > 0 && (Math.abs(newW - width) > 1 || Math.abs(newH - height) > 1)) {
        width = newW;
        height = newH;
        if (graphState) {
          graphState.width = width;
          graphState.height = height;
        }
        svg.attr("width", width).attr("height", height).attr("viewBox", [0, 0, width, height]);
        simulation.force("center", d3.forceCenter(width / 2, height / 2));
        simulation.force("layerX", d3.forceX((d: any) => width / 2 + (layerPos[d.layer] || 0) * width * 0.15).strength(0.04));
        simulation.force("layerY", d3.forceY(height / 2).strength(0.04));
        simulation.alpha(0.3).restart();
      }
    }
  });
  resizeObserver.observe(canvas);

  // ── API ──

  function applyFilters(f: FilterOptions) {
    if (!graphState) return;
    lastFilters = f;
    const activeLayerSet = f.activeLayers;
    const parsed = f.parsedSearch;
    const q = (parsed.textQuery || "").toLowerCase();
    const hasSearch = q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation;
    const hasPrFilter = f.prReviewFiles !== null;
    const hasInsightFilter = f.insightFilter !== null;

    function matchesSearch(d: any) {
      if (!hasSearch) return true;
      if (parsed.filterLayer && !d.layer.toLowerCase().includes(parsed.filterLayer)) return false;
      if (parsed.filterChanged && !d.changed) return false;
      if (parsed.filterViolation && !(d.violation_count > 0)) return false;
      if (q.length >= 2 && !d.id.toLowerCase().includes(q)) return false;
      return true;
    }

    function isInPrReview(nodeId: string) {
      if (!hasPrFilter) return true;
      return f.prReviewFiles!.has(nodeId);
    }

    graphState.nodeSelection
      .attr("opacity", (d: any) => {
        if (!activeLayerSet.has(d.layer)) return 0;
        if (f.showChangedOnly && !d.changed) return 0.05;
        if (hasPrFilter && !isInPrReview(d.id)) return 0.05;
        if (hasInsightFilter && !f.insightFilter!.has(d.id)) return 0.1;
        if (hasSearch && !matchesSearch(d)) return 0.15;
        return 1;
      })
      .classed("pulse", (d: any) => d.changed && !hasPrFilter && !hasInsightFilter)
      .attr("r", (d: any) => {
        if (hasSearch && matchesSearch(d) && (q.length >= 2 || parsed.filterLayer || parsed.filterChanged || parsed.filterViolation))
          return nodeRadius(d) + 3;
        if (hasPrFilter && isInPrReview(d.id)) return nodeRadius(d) + 2;
        if (hasInsightFilter && f.insightFilter!.has(d.id)) return nodeRadius(d) + 3;
        if (d.changed) return nodeRadius(d) + 2;
        return nodeRadius(d);
      })
      .attr("fill", (d: any) => {
        if (hasInsightFilter && f.insightFilter!.has(d.id)) return getLayerColor(d.layer);
        if (hasPrFilter && isInPrReview(d.id)) return getLayerColor(d.layer);
        if (hasSearch && matchesSearch(d)) return getLayerColor(d.layer);
        return d.changed ? NODE_CHANGED : NODE_DEFAULT;
      })
      .attr("stroke", (d: any) => {
        if (hasSearch && matchesSearch(d)) return "rgba(255,255,255,0.3)";
        if (hasInsightFilter && f.insightFilter!.has(d.id)) return "rgba(255,255,255,0.3)";
        if (hasPrFilter && isInPrReview(d.id)) return "rgba(255,255,255,0.3)";
        return d.changed ? "rgba(108,140,255,0.4)" : "rgba(255,255,255,0.08)";
      })
      .attr("stroke-width", (d: any) => {
        if (hasSearch && matchesSearch(d)) return 2;
        if (hasInsightFilter && f.insightFilter!.has(d.id)) return 2;
        if (hasPrFilter && isInPrReview(d.id)) return 2;
        return d.changed ? 2.5 : 1;
      });

    graphState.linkSelection.attr("opacity", (d: any) => {
      const { sId, tId } = getEdgeIds(d);
      const sNode = graphState!.nodesCopyMap.get(sId);
      const tNode = graphState!.nodesCopyMap.get(tId);
      if (!sNode || !tNode) return 0;
      if (!activeLayerSet.has(sNode.layer) || !activeLayerSet.has(tNode.layer)) return 0;
      if (hasPrFilter) {
        const sIn = isInPrReview(sId);
        const tIn = isInPrReview(tId);
        if (sIn && tIn) return 0.6;
        if (sIn || tIn) return 0.15;
        return 0.02;
      }
      if (hasInsightFilter) {
        const sIn = f.insightFilter!.has(sId);
        const tIn = f.insightFilter!.has(tId);
        if (sIn && tIn) return 0.6;
        if (sIn || tIn) return 0.15;
        return 0.03;
      }
      if (hasSearch) {
        const sMatch = matchesSearch(sNode);
        const tMatch = matchesSearch(tNode);
        if (sMatch || tMatch) return 0.6;
        return 0.05;
      }
      return 0.45;
    });

    if (graphState.labelSelection) {
      graphState.labelSelection.attr("opacity", (d: any) => {
        if (!activeLayerSet.has(d.layer)) return 0;
        if (f.showChangedOnly && !d.changed) return 0;
        if (hasPrFilter && !isInPrReview(d.id)) return 0;
        if (hasInsightFilter && !f.insightFilter!.has(d.id)) return 0;
        if (hasSearch && !matchesSearch(d)) return 0;
        return graphState!.currentZoomK > 1.3 ? 0.8 : 0;
      });
    }
  }

  function focusNode(node: GraphNode) {
    if (!graphState) return;
    focusedNodeId = node.id;
    const connected = new Set([node.id]);
    for (const f of opts.edgeOut.get(node.id) || []) connected.add(f);
    for (const f of opts.edgeIn.get(node.id) || []) connected.add(f);

    graphState.nodeSelection
      .attr("opacity", (n: any) => (connected.has(n.id) ? 1 : 0.06))
      .attr("r", (n: any) => (n.id === node.id ? nodeRadius(n) + 3 : nodeRadius(n)))
      .attr("fill", (n: any) => {
        if (n.id === node.id) return "#e8eaf0";
        if (connected.has(n.id)) return getLayerColor(n.layer);
        return NODE_DEFAULT;
      })
      .attr("stroke", (n: any) => {
        if (n.id === node.id) return "rgba(255,255,255,0.5)";
        if (connected.has(n.id)) return "rgba(255,255,255,0.2)";
        return "rgba(255,255,255,0.08)";
      })
      .attr("stroke-width", (n: any) => (n.id === node.id ? 3 : connected.has(n.id) ? 1.5 : 1));

    graphState.linkSelection
      .attr("opacity", (e: any) => {
        const { sId, tId } = getEdgeIds(e);
        if (sId === node.id || tId === node.id) return 0.6;
        return 0.02;
      })
      .attr("stroke", (e: any) => {
        const { sId, tId } = getEdgeIds(e);
        if (sId === node.id || tId === node.id) return "rgba(255,255,255,0.4)";
        return "#8899bb";
      })
      .attr("stroke-width", (e: any) => {
        const { sId, tId } = getEdgeIds(e);
        if (sId === node.id || tId === node.id) return 1.5;
        return 1.2;
      });

    if (graphState.labelSelection) {
      graphState.labelSelection.attr("opacity", (n: any) => (connected.has(n.id) && graphState!.currentZoomK > 0.8 ? 0.9 : 0));
    }
    if (graphState.ringSelection) {
      graphState.ringSelection.attr("opacity", (n: any) => (connected.has(n.id) ? 0.5 : 0));
    }
  }

  function unfocusNode() {
    focusedNodeId = null;
    if (!graphState) return;
    // Reset link styles
    graphState.linkSelection.attr("stroke", "#8899bb").attr("stroke-width", 1.2);
    // Re-apply filters to restore node opacity, radius, fill, stroke, labels, rings
    if (lastFilters) {
      applyFilters(lastFilters);
    }
  }

  function zoomToNode(nodeId: string): GraphNode | null {
    if (!graphState) return null;
    const d = graphState.nodesCopy.find((n: any) => n.id === nodeId);
    if (!d || d.x == null) return null;
    const scale = 2;
    const transform = d3.zoomIdentity.translate(width / 2 - d.x * scale, height / 2 - d.y * scale).scale(scale);
    graphState.svg.transition().duration(500).call(graphState.zoom.transform, transform);
    return d;
  }

  function highlightCascade(nodeId: string, cascadeFiles: Set<string>) {
    if (!graphState) return;
    cascadeFiles.add(nodeId);
    graphState.nodeSelection
      .attr("opacity", (d: any) => (cascadeFiles.has(d.id) ? 1 : 0.07))
      .classed("insight-glow", (d: any) => cascadeFiles.has(d.id) && d.id !== nodeId)
      .attr("stroke", (d: any) => {
        if (d.id === nodeId) return "#60a5fa";
        if (cascadeFiles.has(d.id)) return "#fbbf24";
        return "#333";
      })
      .attr("stroke-width", (d: any) => (cascadeFiles.has(d.id) ? 2.5 : 1));
    graphState.linkSelection.attr("opacity", (d: any) => {
      const { sId, tId } = getEdgeIds(d);
      return cascadeFiles.has(sId) && cascadeFiles.has(tId) ? 0.6 : 0.03;
    });
  }

  function clearHighlight() {
    if (!graphState) return;
    graphState.nodeSelection.classed("insight-glow", false);
    if (lastFilters) {
      applyFilters(lastFilters);
    }
  }

  return {
    applyFilters,
    focusNode,
    unfocusNode,
    zoomToNode,
    highlightCascade,
    clearHighlight,
    getGraphState: () => graphState,
    isClustered: () => clustered.clustered,
    destroy() {
      resizeObserver.disconnect();
      simulation.stop();
      svg.remove();
      graphState = null;
    },
  };
}

function createNoopApi(): GraphApi {
  return {
    applyFilters() {},
    focusNode() {},
    unfocusNode() {},
    zoomToNode() { return null; },
    highlightCascade() {},
    clearHighlight() {},
    getGraphState() { return null; },
    isClustered() { return false; },
    destroy() {},
  };
}
