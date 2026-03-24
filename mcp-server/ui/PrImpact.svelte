<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import SubGraph from "./components/SubGraph.svelte";

  // ── Reactive state ────────────────────────────────────────────────────────

  let status = $state<"loading" | "ready" | "error">("loading");
  let payload = $state<any>(null);
  let selectedFile = $state<string | null>(null);
  let errorMsg = $state("");

  // ── Derived state for SubGraph ────────────────────────────────────────────

  // Seed node IDs = changed files in the PR (highlighted in the graph)
  let seedNodeIds = $derived(new Set<string>(payload?.review?.files ?? []));

  // Layer color map from payload.subgraph.layers
  let subgraphLayerColors = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const layer of payload?.subgraph?.layers ?? []) {
      if (layer?.name && layer?.color) map[layer.name] = layer.color;
    }
    return map;
  });

  // ── Data loading ──────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await bridge.init();
      const result = await bridge.request("getPrImpact");
      payload = result;
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load";
    }
  });

  // ── Event handlers ────────────────────────────────────────────────────────

  function handleFileSelect(file: string) {
    selectedFile = file;
  }

  function handleGraphNodeClick(node: any) {
    selectedFile = node.id;
  }

  function handleGraphBackgroundClick() {
    // Optionally clear selection or do nothing
  }
</script>

<div class="pr-impact">
  {#if status === "loading"}
    <div class="empty-state">Loading PR Impact data...</div>
  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>
  {:else if payload?.status === "no_review"}
    <div class="empty-state">{payload.empty_state ?? "No PR review found. Run the Canon reviewer first."}</div>
  {:else if payload?.status === "no_kg"}
    <div class="empty-state">Knowledge graph not available. Run codebase_graph first for full impact analysis.</div>
  {:else}
    <!-- VerdictStrip placeholder — prtool-05 -->
    <div class="verdict-strip-placeholder">
      {payload?.review?.verdict ?? "UNKNOWN"} — {payload?.review?.files?.length ?? 0} files changed
    </div>
    <div class="panels">
      <div class="panel-left">
        <!-- HotspotList placeholder — prtool-05 -->
        {#if payload?.hotspots?.length > 0}
          <div class="hotspot-list-placeholder">
            {#each payload.hotspots as hotspot}
              <button
                class="hotspot-row"
                class:selected={selectedFile === hotspot.file}
                onclick={() => handleFileSelect(hotspot.file)}
              >
                <span class="hotspot-file">{hotspot.file.split("/").pop()}</span>
                <span class="hotspot-score">{hotspot.risk_score}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="empty-state">No hotspots</div>
        {/if}
      </div>
      <div class="panel-center">
        {#if payload?.subgraph?.nodes?.length > 0}
          <SubGraph
            nodes={payload.subgraph.nodes}
            edges={payload.subgraph.edges}
            {seedNodeIds}
            layerColors={subgraphLayerColors}
            onNodeClick={handleGraphNodeClick}
            onBackgroundClick={handleGraphBackgroundClick}
            fa2Iterations={60}
          />
        {:else}
          <div class="empty-state">
            {#if !payload?.blastRadius}
              No knowledge graph available for subgraph visualization.
            {:else}
              No graph data to display.
            {/if}
          </div>
        {/if}
      </div>
      <div class="panel-right">
        <!-- DetailPanel placeholder — prtool-07 -->
        {#if selectedFile}
          <div class="empty-state">Select a file to see details — {selectedFile}</div>
        {:else}
          <div class="empty-state">Select a file to see details</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .pr-impact {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 500px;
  }

  .verdict-strip-placeholder {
    padding: 12px 16px;
    background: var(--bg-alt, #1e1e1e);
    border-bottom: 1px solid var(--border, #333);
    font-size: 13px;
    font-weight: 600;
    color: var(--text, #eee);
    flex-shrink: 0;
  }

  .panels {
    flex: 1;
    display: flex;
    overflow: hidden;
    gap: 1px;
    background: var(--border, #333);
  }

  .panel-left {
    width: 220px;
    min-width: 180px;
    overflow-y: auto;
    background: var(--bg, #111);
  }

  .panel-center {
    flex: 1;
    overflow: hidden;
    background: var(--bg, #111);
  }

  .panel-right {
    width: 280px;
    min-width: 220px;
    overflow-y: auto;
    background: var(--bg, #111);
  }

  .hotspot-list-placeholder {
    display: flex;
    flex-direction: column;
  }

  .hotspot-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    cursor: pointer;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border, #333);
    color: var(--text, #eee);
    font-size: 12px;
    text-align: left;
    width: 100%;
  }

  .hotspot-row:hover {
    background: var(--bg-hover, #1a1a1a);
  }

  .hotspot-row.selected {
    background: var(--accent-soft, rgba(100, 100, 255, 0.15));
  }

  .hotspot-file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .hotspot-score {
    color: var(--text-muted, #888);
    margin-left: 8px;
    flex-shrink: 0;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-muted, #888);
    font-size: 13px;
    padding: 20px;
    text-align: center;
    height: 100%;
  }

  .error {
    color: var(--danger, #e74c3c);
  }
</style>
