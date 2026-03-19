<script lang="ts">
  import { onMount } from "svelte";
  import { graphData, graphStatus, loadEmbeddedData, edgeIn, nodeMap, type GraphNode } from "./stores/graphData";
  import { bridge } from "./stores/bridge";
  import { activeInsightFilter, searchQuery } from "./stores/filters";
  import { selectedNode, panelMode } from "./stores/selection";
  import { getCascadeFiles, getInsightFiles } from "./lib/graph";
  import type { GraphApi } from "./lib/d3Graph";

  import Toolbar from "./components/Toolbar.svelte";
  import PrBanner from "./components/PrBanner.svelte";
  import GraphCanvas from "./components/GraphCanvas.svelte";
  import RightPanel from "./components/RightPanel.svelte";
  import HelpOverlay from "./components/HelpOverlay.svelte";
  import Tooltip from "./components/Tooltip.svelte";
  import { tooltipState } from "./lib/tooltip";

  let mounted = $state(false);
  let graphCanvas = $state<GraphCanvas>();

  onMount(() => {
    loadEmbeddedData();
    bridge.init();
    // Signal to extension that webview is ready to receive messages
    bridge.request("webviewReady", {}).catch(() => {});
    mounted = true;
  });

  function getGraphApi(): GraphApi | undefined {
    return graphCanvas?.getApi();
  }

  function handleNodeClick(node: GraphNode) {
    selectedNode.set(node);
    panelMode.set("focus");
    bridge.notifyNodeSelected(node as any);
    getGraphApi()?.focusNode(node);
  }

  function handleBackToOverview() {
    panelMode.set("overview");
    selectedNode.set(null);
    bridge.notifyNodeSelected(null);
    getGraphApi()?.unfocusNode();
    // Re-apply filters after unfocus
    // GraphCanvas $effect will handle this
  }

  function handleBackgroundClick() {
    if ($selectedNode) handleBackToOverview();
  }

  function handleZoomToNode(nodeId: string) {
    const api = getGraphApi();
    if (!api) return;
    const d = api.zoomToNode(nodeId);
    if (d) {
      const node = $nodeMap.get(nodeId) || d;
      handleNodeClick(node);
    }
  }

  function handleHighlightCategory(type: string) {
    const data = $graphData;
    if (!data) return;
    const insightFiles = getInsightFiles(type, data);

    if (insightFiles.size === 0) {
      activeInsightFilter.set(null);
      return;
    }

    activeInsightFilter.set(insightFiles);
    getGraphApi()?.getGraphState()?.nodeSelection.classed("insight-glow", (d: any) => insightFiles.has(d.id));
  }

  function handleClearHighlight() {
    activeInsightFilter.set(null);
    getGraphApi()?.clearHighlight();
  }

  function handleHighlightCascade(nodeId: string) {
    const cascadeFiles = getCascadeFiles(nodeId, $edgeIn);
    getGraphApi()?.highlightCascade(nodeId, cascadeFiles);
  }

  function handleRefreshGraph() {
    bridge.request("refreshGraph");
  }

  // Global Escape handler
  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Escape") {
      searchQuery.set("");
      handleClearHighlight();
      handleBackToOverview();
    }
  }
</script>

<svelte:document onkeydown={handleKeydown} />

<div class="main-content">
  {#if mounted && $graphData}
    {#if $graphStatus === "refreshing"}
      <div class="refresh-bar">Refreshing graph...</div>
    {/if}
    <Toolbar onZoomToNode={handleZoomToNode} onRefreshGraph={handleRefreshGraph} />
    <PrBanner />
    <div class="graph-layout">
      <GraphCanvas
        bind:this={graphCanvas}
        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
      />
      <RightPanel
        onFileClick={handleZoomToNode}
        onHighlightCategory={handleHighlightCategory}
        onClearHighlight={handleClearHighlight}
        onHighlightCascade={handleHighlightCascade}
        onBackToOverview={handleBackToOverview}
        hasActiveHighlight={$activeInsightFilter !== null}
      />
    </div>
    <HelpOverlay />
    <Tooltip text={$tooltipState.text} visible={$tooltipState.visible} x={$tooltipState.x} y={$tooltipState.y} />
  {:else if mounted}
    <div class="loading-state">
      <div class="loading-spinner"></div>
      {#if $graphStatus === "generating"}
        <p class="loading-title">Mapping your codebase</p>
        <p class="loading-subtitle">Scanning files, resolving imports, and inferring layers...</p>
      {:else if $graphStatus === "error"}
        <p class="loading-title">Failed to load graph</p>
        <p class="loading-subtitle">Check the Canon terminal for errors, then click refresh to retry.</p>
      {:else}
        <p class="loading-title">No graph data</p>
        <p class="loading-subtitle">Click refresh to generate your codebase graph.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .main-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .graph-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .refresh-bar {
    background: var(--accent);
    color: var(--bg);
    text-align: center;
    padding: 4px 0;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    animation: pulse-bg 1.5s ease-in-out infinite;
  }
  @keyframes pulse-bg {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
  .loading-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 48px;
  }
  .loading-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-title {
    color: var(--text-bright);
    font-size: 15px;
    font-weight: 600;
  }
  .loading-subtitle {
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
    max-width: 320px;
    line-height: 1.6;
  }
</style>
