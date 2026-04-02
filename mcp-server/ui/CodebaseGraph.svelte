<script lang="ts">
import type { FilterOptions } from "./lib/sigmaGraph";
import type { CompactGraphData, GraphData, GraphNode } from "./lib/types";
import { decodeCompactGraph } from "./lib/types";
import { useDataLoader } from "./lib/useDataLoader.svelte";
import { bridge } from "./stores/bridge";

// ── Data loading ──────────────────────────────────────────────────────────

const loader = useDataLoader(async () => {
  await bridge.init();
  const raw = await bridge.waitForToolResult();
  if (!raw) throw new Error("No data received from tool");
  // Support both compact (index-encoded) and full graph formats
  if (raw._compact) return decodeCompactGraph(raw as CompactGraphData);
  return raw as GraphData;
});

let _status = $derived(loader.status);
let graphData = $derived(loader.data);
let _errorMsg = $derived(loader.errorMsg);

// ── View state ────────────────────────────────────────────────────────────

let _selectedNode = $state<GraphNode | null>(null);

// ── Filter state ──────────────────────────────────────────────────────────

let filterViolations = $state(false);
let filterChanged = $state(false);
// activeLayers: all layer names start included; toggling a layer removes/adds it
let activeLayers = $state<Set<string>>(new Set());
// whether layer chips are expanded
let layersExpanded = $state(false);

// Initialise activeLayers once data is loaded
$effect(() => {
  if (graphData) {
    activeLayers = new Set((graphData.layers ?? []).map((l) => l.name));
  }
});

// allLayerNames: derived set of every layer name in the graph data
let allLayerNames = $derived(new Set((graphData?.layers ?? []).map((l) => l.name)));

// ── Derived helpers ───────────────────────────────────────────────────────

let _layerColors = $derived.by(() => {
  const map: Record<string, string> = {};
  for (const layer of graphData?.layers ?? []) {
    if (layer?.name && layer?.color) map[layer.name] = layer.color;
  }
  return map;
});

let changedNodeIds = $derived(new Set<string>((graphData?.nodes ?? []).filter((n) => n.changed).map((n) => n.id)));

let _stats = $derived.by(() => {
  if (!graphData) return null;
  const nodes = graphData.nodes;
  const violationCount = nodes.filter((n) => (n.violation_count ?? 0) > 0).length;
  return {
    nodes: nodes.length,
    edges: graphData.edges.length,
    layers: graphData.layers?.length ?? 0,
    violations: violationCount,
    changed: changedNodeIds.size,
  };
});

// filtersActive: true when any filter deviates from the "show everything" default
let filtersActive = $derived(
  filterViolations || filterChanged || (allLayerNames.size > 0 && activeLayers.size < allLayerNames.size),
);

// Build FilterOptions to pass to SubGraph whenever any filter state changes.
// Only set when at least one filter is active (null = no filtering).
function buildInsightFilter(nodes: GraphNode[], wantViolations: boolean, wantChanged: boolean): Set<string> | null {
  if (!wantViolations && !wantChanged) return null;
  const insight = new Set<string>();
  for (const n of nodes) {
    if (wantViolations && (n.violation_count ?? 0) > 0) insight.add(n.id);
    if (wantChanged && n.changed) insight.add(n.id);
  }
  return insight;
}

function buildFilterOptions(layers: Set<string>, allLayers: Set<string>, insight: Set<string> | null): FilterOptions {
  return {
    activeLayers: layers.size > 0 ? layers : allLayers,
    searchQuery: "",
    parsedSearch: {
      textQuery: "",
      filterLayer: null,
      filterChanged: false,
      filterViolation: false,
    },
    prReviewFiles: null,
    insightFilter: insight,
    showChangedOnly: false,
  };
}

let _filterOptions = $derived.by((): FilterOptions | null => {
  if (!graphData) return null;
  if (!filtersActive) return null;
  const insight = buildInsightFilter(graphData.nodes, filterViolations, filterChanged);
  return buildFilterOptions(activeLayers, allLayerNames, insight);
});

// ── Edge maps for detail panel ─────────────────────────────────────────────
// edgesIn[nodeId] = list of node IDs that import this node (in-edges)
// edgesOut[nodeId] = list of node IDs this node imports (out-edges)

function resolveEdgeId(endpoint: string | { id: string }): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

let _edgesIn = $derived.by((): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const edge of graphData?.edges ?? []) {
    const src = resolveEdgeId(edge.source);
    const tgt = resolveEdgeId(edge.target);
    if (!map.has(tgt)) map.set(tgt, []);
    map.get(tgt)!.push(src);
  }
  return map;
});

let _edgesOut = $derived.by((): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const edge of graphData?.edges ?? []) {
    const src = resolveEdgeId(edge.source);
    const tgt = resolveEdgeId(edge.target);
    if (!map.has(src)) map.set(src, []);
    map.get(src)!.push(tgt);
  }
  return map;
});

// ── Event handlers ────────────────────────────────────────────────────────

function _handleNodeClick(node: GraphNode) {
  _selectedNode = node;
}

function _handleBackgroundClick() {
  _selectedNode = null;
}

function _toggleViolations() {
  filterViolations = !filterViolations;
}

function _toggleChanged() {
  filterChanged = !filterChanged;
}

function _toggleLayersExpanded() {
  layersExpanded = !layersExpanded;
}

function _toggleLayer(layerName: string) {
  const next = new Set(activeLayers);
  if (next.has(layerName)) {
    next.delete(layerName);
  } else {
    next.add(layerName);
  }
  activeLayers = next;
}
</script>

<div class="codebase-graph">
  {#if status === "loading"}
    <EmptyState message="Generating codebase graph..." />
  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />
  {:else if graphData && graphData.nodes.length > 0}
    <div class="stats-bar">
      <span>{stats?.nodes} nodes</span>
      <span class="sep">&middot;</span>
      <span>{stats?.edges} edges</span>
      <span class="sep">&middot;</span>
      <!-- Layer toggle: collapsed shows a count button; expanded shows per-layer chips -->
      {#if !layersExpanded}
        <button
          class="filter-btn"
          class:active={activeLayers.size < allLayerNames.size}
          onclick={toggleLayersExpanded}
          title="Click to expand layer filters"
        >{stats?.layers} layers</button>
      {:else}
        <div class="layer-chips">
          <button
            class="filter-btn layer-collapse-btn"
            onclick={toggleLayersExpanded}
            title="Collapse layer filters"
          >layers:</button>
          {#each (graphData.layers ?? []) as layer (layer.name)}
            <button
              class="layer-chip"
              class:inactive={!activeLayers.has(layer.name)}
              style="--chip-color: {layer.color ?? '#6b7394'}"
              onclick={() => toggleLayer(layer.name)}
              title="{activeLayers.has(layer.name) ? 'Hide' : 'Show'} {layer.name} layer"
            >{layer.name}</button>
          {/each}
        </div>
      {/if}
      {#if stats?.violations}
        <span class="sep">&middot;</span>
        <button
          class="filter-btn violations"
          class:active={filterViolations}
          onclick={toggleViolations}
          title="{filterViolations ? 'Clear' : 'Show only'} nodes with violations"
        >{stats.violations} with violations</button>
      {/if}
      {#if stats?.changed}
        <span class="sep">&middot;</span>
        <button
          class="filter-btn changed"
          class:active={filterChanged}
          onclick={toggleChanged}
          title="{filterChanged ? 'Clear' : 'Show only'} changed nodes"
        >{stats.changed} changed</button>
      {/if}
    </div>

    <div class="main-area">
      <div class="graph-container">
        <SubGraph
          nodes={graphData.nodes}
          edges={graphData.edges}
          seedNodeIds={changedNodeIds}
          {layerColors}
          onNodeClick={handleNodeClick}
          onBackgroundClick={handleBackgroundClick}
          fa2Iterations={100}
          {filterOptions}
        />
      </div>

      {#if selectedNode}
        <CodebaseGraphDetailPanel
          {selectedNode}
          {layerColors}
          {edgesIn}
          {edgesOut}
          onClose={handleBackgroundClick}
        />
      {/if}
    </div>
  {:else}
    <EmptyState message="No graph data. Run codebase_graph first." />
  {/if}
</div>

<style>
  .codebase-graph {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .stats-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--text-muted, #636a80);
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .sep { opacity: 0.4; }

  /* Filter toggle buttons in the stats bar */
  .filter-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-size: 12px;
    color: var(--text-muted, #636a80);
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.15s, background 0.15s;
  }

  .filter-btn:hover {
    color: var(--text-bright, #e8eaf0);
  }

  .filter-btn.active {
    background: var(--bg-card, rgba(255,255,255,0.08));
    padding: 1px 6px;
    color: var(--text-bright, #e8eaf0);
  }

  .filter-btn.violations {
    color: var(--danger, #ff6b6b);
  }

  .filter-btn.violations.active {
    background: rgba(255, 107, 107, 0.15);
    color: var(--danger, #ff6b6b);
  }

  .filter-btn.changed {
    color: var(--accent, #6c8cff);
  }

  .filter-btn.changed.active {
    background: var(--accent-soft, rgba(108,140,255,0.15));
    color: var(--accent, #6c8cff);
  }

  /* Layer chips expansion */
  .layer-chips {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .layer-collapse-btn {
    color: var(--text-muted, #636a80);
    font-size: 11px;
    opacity: 0.7;
  }

  .layer-chip {
    background: none;
    border: 1px solid var(--chip-color, #6b7394);
    color: var(--chip-color, #6b7394);
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    cursor: pointer;
    transition: opacity 0.15s, background 0.15s;
    font-family: inherit;
  }

  .layer-chip:hover {
    background: color-mix(in srgb, var(--chip-color, #6b7394) 15%, transparent);
  }

  .layer-chip.inactive {
    opacity: 0.35;
    background: none;
  }

  /* ── Main content area: graph + right panel ─────────────────────────────── */

  .main-area {
    flex: 1;
    display: flex;
    flex-direction: row;
    overflow: hidden;
    min-height: 0;
  }

  .graph-container {
    flex: 1;
    overflow: hidden;
    min-height: 500px;
    min-width: 0;
  }

</style>
