<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { buildD3Graph, type GraphApi, type FilterOptions } from "../lib/d3Graph";
  import { parseSearchQuery } from "../lib/graph";
  import { graphData, edgeIn, edgeOut, summaries, type GraphNode } from "../stores/graphData";
  import { activeLayers, searchQuery, activeInsightFilter, prReviewFiles, showChangedOnly } from "../stores/filters";
  import { selectedNode, panelMode } from "../stores/selection";
  import { bridge } from "../stores/bridge";

  let container: HTMLDivElement;
  let graphApi: GraphApi | undefined;

  interface Props {
    onNodeClick: (node: GraphNode) => void;
    onBackgroundClick: () => void;
  }

  let { onNodeClick, onBackgroundClick }: Props = $props();

  onMount(() => {
    const data = $graphData;
    if (!data || !container) return;

    // Initialize active layers with all layers present in data
    const allLayers = [...new Set(data.nodes.map((n) => n.layer))];
    activeLayers.set(allLayers);

    graphApi = buildD3Graph(container, data, {
      onNodeClick: (node) => onNodeClick(node),
      onBackgroundClick: () => onBackgroundClick(),
      edgeIn: $edgeIn,
      edgeOut: $edgeOut,
      summaries: $summaries,
    });

  });

  onDestroy(() => {
    graphApi?.destroy();
  });

  // Re-apply filters whenever filter stores change
  $effect(() => {
    const opts: FilterOptions = {
      activeLayers: new Set($activeLayers),
      searchQuery: $searchQuery,
      parsedSearch: parseSearchQuery($searchQuery),
      prReviewFiles: $prReviewFiles,
      insightFilter: $activeInsightFilter,
      showChangedOnly: $showChangedOnly,
    };
    if (graphApi) graphApi.applyFilters(opts);
  });

  // Expose graph API for parent to call
  export function getApi(): GraphApi | undefined {
    return graphApi;
  }
</script>

<div class="graph-canvas" bind:this={container}>
</div>

<style>
  .graph-canvas {
    flex: 1;
    background: transparent;
    overflow: hidden;
    position: relative;
  }
  .graph-canvas :global(svg) {
    width: 100%;
    height: 100%;
  }
  .graph-canvas :global(.graph-tooltip) {
    position: absolute;
    pointer-events: none;
    z-index: 50;
    background: #14182aee;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    font-size: 12px;
    max-width: 320px;
    line-height: 1.5;
    box-shadow: var(--shadow-lg);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .graph-canvas :global(.graph-tooltip.visible) { opacity: 1; }
  .graph-canvas :global(.graph-tooltip strong) { color: var(--text-bright); font-size: 12px; display: block; margin-bottom: 4px; }
  .graph-canvas :global(.graph-tooltip .tt-meta) { color: var(--text-muted); font-size: 11px; }
  .graph-canvas :global(.graph-tooltip .tt-summary) { color: var(--text); font-size: 11px; margin-top: 4px; border-top: 1px solid var(--border); padding-top: 4px; }
</style>
