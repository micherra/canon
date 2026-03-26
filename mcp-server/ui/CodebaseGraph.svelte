<script lang="ts">
  import { bridge } from "./stores/bridge";
  import { useDataLoader } from "./lib/useDataLoader.svelte";
  import EmptyState from "./components/EmptyState.svelte";
  import SubGraph from "./components/SubGraph.svelte";
  import Badge from "./components/Badge.svelte";
  import type { GraphData, GraphNode, GraphEdge } from "./lib/types";
  import type { FilterOptions } from "./lib/sigmaGraph";

  // ── Data loading ──────────────────────────────────────────────────────────

  const loader = useDataLoader(async () => {
    await bridge.init();
    return bridge.callTool("codebase_graph") as Promise<GraphData>;
  });

  let status = $derived(loader.status);
  let graphData = $derived(loader.data);
  let errorMsg = $derived(loader.errorMsg);

  // ── View state ────────────────────────────────────────────────────────────

  let selectedNode = $state<GraphNode | null>(null);

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
    // Build insightFilter set: only these nodes stay visible when violation/changed toggles are on
    let insight: Set<string> | null = null;
    if (filterViolations || filterChanged) {
      insight = new Set<string>();
      for (const n of graphData.nodes) {
        if (filterViolations && (n.violation_count ?? 0) > 0) insight.add(n.id);
        if (filterChanged && n.changed) insight.add(n.id);
      }
    }
    return {
      activeLayers: activeLayers.size > 0 ? activeLayers : allLayerNames,
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
  });

  // ── Edge maps for detail panel ─────────────────────────────────────────────
  // edgesIn[nodeId] = list of node IDs that import this node (in-edges)
  // edgesOut[nodeId] = list of node IDs this node imports (out-edges)

  function resolveEdgeId(endpoint: string | { id: string }): string {
    return typeof endpoint === "string" ? endpoint : endpoint.id;
  }

  let edgesIn = $derived.by((): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const edge of graphData?.edges ?? []) {
      const src = resolveEdgeId(edge.source);
      const tgt = resolveEdgeId(edge.target);
      if (!map.has(tgt)) map.set(tgt, []);
      map.get(tgt)!.push(src);
    }
    return map;
  });

  let edgesOut = $derived.by((): Map<string, string[]> => {
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
        <div class="detail-panel">
          <div class="detail-header">
            <div class="node-path">{selectedNode.id}</div>
            <button class="close-btn" onclick={handleBackgroundClick} title="Close panel">×</button>
          </div>

          <div class="node-meta">
            <Badge
              text={selectedNode.layer}
              bg={layerColors[selectedNode.layer] ?? '#6b7394'}
              color="#fff"
            />
            {#if selectedNode.changed}
              <Badge
                text="changed"
                bg="var(--accent-soft, rgba(108,140,255,0.12))"
                color="var(--accent, #6c8cff)"
              />
            {/if}
            {#if selectedNode.kind}
              <Badge
                text={selectedNode.kind}
              />
            {/if}
          </div>

          {#if selectedNode.summary}
            <div class="detail-section">
              <div class="section-label">Summary</div>
              <div class="summary-text">{selectedNode.summary}</div>
            </div>
          {/if}

          <div class="stats-row">
            {#if selectedNode.entity_count != null}
              <div class="stat-item">
                <span class="stat-value">{selectedNode.entity_count}</span>
                <span class="stat-label">entities</span>
              </div>
            {/if}
            {#if selectedNode.export_count != null}
              <div class="stat-item">
                <span class="stat-value">{selectedNode.export_count}</span>
                <span class="stat-label">exports</span>
              </div>
            {/if}
            {#if selectedNode.dead_code_count != null}
              <div class="stat-item">
                <span class="stat-value">{selectedNode.dead_code_count}</span>
                <span class="stat-label">dead</span>
              </div>
            {/if}
            {#if selectedNode.community != null}
              <div class="stat-item">
                <span class="stat-value">#{selectedNode.community}</span>
                <span class="stat-label">community</span>
              </div>
            {/if}
          </div>

          {#if (edgesIn.get(selectedNode.id)?.length ?? 0) > 0 || (edgesOut.get(selectedNode.id)?.length ?? 0) > 0}
            <div class="detail-section">
              <div class="section-label">Dependencies</div>
              {#if (edgesIn.get(selectedNode.id)?.length ?? 0) > 0}
                <div class="dep-group">
                  <div class="dep-group-label">imported by ({edgesIn.get(selectedNode.id)!.length})</div>
                  {#each edgesIn.get(selectedNode.id)! as dep}
                    <div class="dep-item">{dep}</div>
                  {/each}
                </div>
              {/if}
              {#if (edgesOut.get(selectedNode.id)?.length ?? 0) > 0}
                <div class="dep-group">
                  <div class="dep-group-label">imports ({edgesOut.get(selectedNode.id)!.length})</div>
                  {#each edgesOut.get(selectedNode.id)! as dep}
                    <div class="dep-item">{dep}</div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if selectedNode.entities?.length}
            <div class="detail-section">
              <div class="section-label">Entities</div>
              {#each selectedNode.entities as entity}
                <div class="entity-item">
                  <span class="entity-name">{entity.name}</span>
                  <span class="entity-kind">{entity.kind}</span>
                </div>
              {/each}
            </div>
          {/if}

          {#if selectedNode.exports?.length}
            <div class="detail-section">
              <div class="section-label">Exports</div>
              {#each selectedNode.exports as exp}
                <div class="export-item">{exp}</div>
              {/each}
            </div>
          {/if}

          {#if selectedNode.violation_count}
            <div class="detail-section">
              <div class="section-label violation-label">{selectedNode.violation_count} violation{selectedNode.violation_count !== 1 ? 's' : ''}</div>
              {#if selectedNode.top_violations?.length}
                <div class="violation-list">
                  {#each selectedNode.top_violations as v}
                    <div class="violation-item">{v}</div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
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

  /* ── Detail panel (right side) ──────────────────────────────────────────── */

  .detail-panel {
    width: 300px;
    flex-shrink: 0;
    border-left: 1px solid var(--border, rgba(255,255,255,0.06));
    background: var(--bg-surface, rgba(255,255,255,0.03));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px 6px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .node-path {
    font-family: monospace;
    font-size: 11px;
    color: var(--text-bright, #e8eaf0);
    flex: 1;
    word-break: break-all;
    line-height: 1.4;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted, #636a80);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
    border-radius: 3px;
    transition: color 0.15s;
  }

  .close-btn:hover {
    color: var(--text-bright, #e8eaf0);
  }

  .node-meta {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    padding: 6px 12px 8px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
  }

  /* ── Stats row ──────────────────────────────────────────────────────────── */

  .stats-row {
    display: flex;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
    flex-wrap: wrap;
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
  }

  .stat-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
  }

  .stat-label {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* ── Sections ───────────────────────────────────────────────────────────── */

  .detail-section {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 5px;
  }

  .violation-label {
    color: var(--danger, #ff6b6b);
  }

  .summary-text {
    font-size: 11px;
    color: var(--text, #b4b8c8);
    line-height: 1.5;
  }

  /* ── Dependency lists ───────────────────────────────────────────────────── */

  .dep-group {
    margin-bottom: 6px;
  }

  .dep-group:last-child {
    margin-bottom: 0;
  }

  .dep-group-label {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 3px;
  }

  .dep-item {
    font-family: monospace;
    font-size: 10px;
    color: var(--text, #b4b8c8);
    padding: 1px 0 1px 8px;
    border-left: 2px solid var(--border, rgba(255,255,255,0.1));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.6;
  }

  /* ── Entity list ────────────────────────────────────────────────────────── */

  .entity-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 2px 0;
  }

  .entity-name {
    font-size: 11px;
    color: var(--text-bright, #e8eaf0);
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .entity-kind {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    flex-shrink: 0;
  }

  /* ── Export list ────────────────────────────────────────────────────────── */

  .export-item {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    padding: 1px 0;
    line-height: 1.5;
  }

  /* ── Violations ─────────────────────────────────────────────────────────── */

  .violation-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .violation-item {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    padding: 2px 6px 2px 8px;
    border-left: 2px solid var(--danger, #ff6b6b);
    line-height: 1.4;
  }
</style>
