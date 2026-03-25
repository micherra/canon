<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import SubGraph from "./components/SubGraph.svelte";
  import type { GraphData, GraphNode } from "./lib/types";
  import type { FilterOptions } from "./lib/sigmaGraph";

  let status = $state<"loading" | "ready" | "error">("loading");
  let graphData = $state<GraphData | null>(null);
  let selectedNode = $state<GraphNode | null>(null);
  let errorMsg = $state("");

  // ── Filter state ──────────────────────────────────────────────────────────

  let filterViolations = $state(false);
  let filterChanged = $state(false);
  // activeLayers: all layer names start included; toggling a layer removes/adds it
  let activeLayers = $state<Set<string>>(new Set());
  // whether layer chips are expanded
  let layersExpanded = $state(false);

  // allLayerNames: derived set of every layer name in the graph data
  let allLayerNames = $derived(
    new Set((graphData?.layers ?? []).map((l) => l.name)),
  );

  // ── Derived helpers ───────────────────────────────────────────────────────

  let layerColors = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const layer of graphData?.layers ?? []) {
      if (layer?.name && layer?.color) map[layer.name] = layer.color;
    }
    return map;
  });

  let changedNodeIds = $derived(
    new Set<string>((graphData?.nodes ?? []).filter((n) => n.changed).map((n) => n.id)),
  );

  let stats = $derived.by(() => {
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
    filterViolations ||
    filterChanged ||
    (allLayerNames.size > 0 && activeLayers.size < allLayerNames.size),
  );

  // Build FilterOptions to pass to SubGraph whenever any filter state changes.
  // Only set when at least one filter is active (null = no filtering).
  let filterOptions = $derived.by((): FilterOptions | null => {
    if (!graphData) return null;
    if (!filtersActive) return null;
    return {
      activeLayers: activeLayers.size > 0 ? activeLayers : allLayerNames,
      searchQuery: "",
      parsedSearch: {
        textQuery: "",
        filterLayer: null,
        filterChanged: filterChanged,
        filterViolation: filterViolations,
      },
      prReviewFiles: null,
      insightFilter: null,
      showChangedOnly: filterChanged,
    };
  });

  // ── Event handlers ────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await bridge.init();
      const result = await bridge.callTool("codebase_graph");
      graphData = result as GraphData;
      activeLayers = new Set((graphData.layers ?? []).map((l) => l.name));
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load graph";
    }
  });

  function handleNodeClick(node: GraphNode) {
    selectedNode = node;
  }

  function handleBackgroundClick() {
    selectedNode = null;
  }

  function toggleViolations() {
    filterViolations = !filterViolations;
  }

  function toggleChanged() {
    filterChanged = !filterChanged;
  }

  function toggleLayersExpanded() {
    layersExpanded = !layersExpanded;
  }

  function toggleLayer(layerName: string) {
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
    <div class="empty-state">Generating codebase graph...</div>
  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>
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
      <div class="node-detail">
        <div class="node-path">{selectedNode.id}</div>
        <div class="node-meta">
          <span class="layer-badge" style="background: {layerColors[selectedNode.layer] ?? '#6b7394'}">{selectedNode.layer}</span>
          {#if selectedNode.violation_count}
            <span class="violation-badge">{selectedNode.violation_count} violations</span>
          {/if}
          {#if selectedNode.changed}
            <span class="changed-badge">changed</span>
          {/if}
        </div>
        {#if selectedNode.top_violations?.length}
          <div class="violation-list">
            {#each selectedNode.top_violations as v}
              <div class="violation-item">{v}</div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="empty-state">No graph data. Run <code>codebase_graph</code> first.</div>
  {/if}
</div>

<style>
  .codebase-graph {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
    min-height: 600px;
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

  .graph-container {
    flex: 1;
    overflow: hidden;
    min-height: 500px;
  }

  .node-detail {
    padding: 10px 12px;
    border-top: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
    max-height: 140px;
    overflow-y: auto;
  }

  .node-path {
    font-family: monospace;
    font-size: 12px;
    color: var(--text-bright, #e8eaf0);
    margin-bottom: 4px;
  }

  .node-meta {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
  }

  .layer-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    color: #fff;
  }

  .violation-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(255,107,107,0.15);
    color: var(--danger, #ff6b6b);
  }

  .changed-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent-soft, rgba(108,140,255,0.12));
    color: var(--accent, #6c8cff);
  }

  .violation-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .violation-item {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    padding-left: 8px;
    border-left: 2px solid var(--danger, #ff6b6b);
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-muted, #888);
    font-size: 13px;
  }

  .empty-state code {
    font-family: monospace;
    background: var(--bg-card, rgba(255,255,255,0.06));
    padding: 1px 4px;
    border-radius: 3px;
  }

  .error { color: var(--danger, #e05252); }
</style>
