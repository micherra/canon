<script lang="ts">
  import { onMount } from "svelte";
  import { graphData, loadEmbeddedData, edgeIn, nodeMap, type GraphNode } from "./stores/graphData";
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

  let mounted = $state(false);
  let graphCanvas = $state<GraphCanvas>();

  onMount(() => {
    loadEmbeddedData();
    bridge.init();
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
    <Toolbar onZoomToNode={handleZoomToNode} />
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
  {:else if mounted}
    <p class="empty-state">No graph data. Run <code>/canon:dashboard</code> to generate.</p>
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
  .empty-state {
    color: var(--text-muted);
    font-style: normal;
    padding: 48px;
    text-align: center;
    font-size: 13px;
  }
  .empty-state :global(code) {
    background: var(--bg-card);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
  }
</style>
