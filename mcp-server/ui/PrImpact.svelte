<script lang="ts">
  /**
   * PrImpact.svelte
   *
   * Root component for the PR Impact View.
   * Three-panel layout: left (HotspotList) | center (SubGraph) | right (PrDetailPanel)
   */

  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import VerdictStrip from "./components/VerdictStrip.svelte";
  import HotspotList from "./components/HotspotList.svelte";
  import PrDetailPanel from "./components/PrDetailPanel.svelte";
  import SubGraph from "./components/SubGraph.svelte";
  import type { PrImpactPayload } from "./stores/pr-impact";

  let status = $state<"loading" | "ready" | "error">("loading");
  let payload = $state<PrImpactPayload | null>(null);
  let selectedFile = $state<string | null>(null);
  let errorMsg = $state("");

  // Derived state for SubGraph
  let seedNodeIds = $derived(new Set<string>(payload?.review?.files ?? []));

  let subgraphLayerColors = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const layer of payload?.subgraph?.layers ?? []) {
      if (layer?.name && layer?.color) map[layer.name] = layer.color;
    }
    return map;
  });

  // Derived state for DetailPanel
  let selectedFileViolations = $derived(
    (payload?.review?.violations ?? []).filter(
      (v: any) => v.file_path === selectedFile,
    ),
  );

  let selectedFileBlastRadius = $derived(
    (payload?.blastRadius?.affected ?? []).filter((a: any) => a.depth > 0),
  );

  let selectedFileDecisions = $derived.by(() => {
    const violatedPrinciples = new Set(
      selectedFileViolations.map((v: any) => v.principle_id),
    );
    return (payload?.decisions ?? []).filter((d: any) =>
      violatedPrinciples.has(d.principle_id),
    );
  });

  onMount(async () => {
    try {
      await bridge.init();
      const result = await bridge.request("getPrImpact");
      payload = result as PrImpactPayload;
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load PR impact data";
    }
  });

  function handleFileSelect(file: string) {
    selectedFile = file;
  }

  function handleGraphNodeClick(node: any) {
    selectedFile = node.id;
  }

  function handleGraphBackgroundClick() {
    // no-op
  }
</script>

<div class="pr-impact">
  {#if status === "loading"}
    <div class="empty-state">Loading PR Impact data...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if payload?.status === "no_review"}
    <div class="empty-state">
      {payload.empty_state ?? "No PR review found. Run the Canon reviewer first."}
    </div>

  {:else if payload?.status === "no_kg"}
    <div class="empty-state">
      Knowledge graph not available. Run <code>codebase_graph</code> first for full impact analysis.
    </div>

  {:else if payload?.status === "ok" && payload.review}
    <VerdictStrip
      verdict={payload.review.verdict}
      fileCount={payload.review.files.length}
      blastRadiusTotal={payload.blastRadius?.total_affected ?? 0}
      violationCount={payload.review.violations.length}
      score={payload.review.score}
    />

    <div class="panels">
      <!-- Left panel: HotspotList — risk-ranked changed files -->
      <div class="panel-left">
        <HotspotList
          hotspots={payload.hotspots}
          {selectedFile}
          onFileSelect={handleFileSelect}
        />
      </div>

      <!-- Center panel: SubGraph — changed files + dependency neighborhood -->
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

      <!-- Right panel: PrDetailPanel — per-file violations, blast radius, decisions -->
      <div class="panel-right">
        {#if selectedFile}
          <PrDetailPanel
            file={selectedFile}
            violations={selectedFileViolations}
            blastRadiusAffected={selectedFileBlastRadius}
            decisions={selectedFileDecisions}
            onFileClick={handleFileSelect}
          />
        {:else}
          <div class="empty-state">Select a file to see details</div>
        {/if}
      </div>
    </div>

  {:else}
    <div class="empty-state">Unexpected response from server.</div>
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
    background: var(--bg, #1a1a1a);
    flex-shrink: 0;
  }

  .panel-center {
    flex: 1;
    overflow: hidden;
    background: var(--bg, #1a1a1a);
    min-width: 0;
  }

  .panel-right {
    width: 280px;
    min-width: 220px;
    overflow-y: auto;
    background: var(--bg, #1a1a1a);
    flex-shrink: 0;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 100%;
    color: var(--text-muted, #888);
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }

  .empty-state code {
    font-family: var(--font-mono, monospace);
    background: var(--bg-alt, #2a2a2a);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .error {
    color: var(--danger, #e05252);
  }
</style>
