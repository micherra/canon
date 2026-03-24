<script lang="ts">
  import { onDestroy } from "svelte";
  import { buildSigmaGraph, type SigmaGraphApi, type FilterOptions } from "../lib/sigmaGraph";
  import { parseSearchQuery } from "../lib/graph";
  import { graphData, edgeIn, edgeOut, layerColors, type GraphNode, type GraphData } from "../stores/graphData";
  import { activeLayers, searchQuery, activeInsightFilter, prReviewFiles, showChangedOnly } from "../stores/filters";
  import { selectedNode, panelMode } from "../stores/selection";
  import { bridge } from "../stores/bridge";

  let container: HTMLDivElement;
  let graphApi: SigmaGraphApi | undefined;

  interface Props {
    onNodeClick: (node: GraphNode) => void;
    onBackgroundClick: () => void;
  }

  let { onNodeClick, onBackgroundClick }: Props = $props();

  function buildGraph(data: GraphData) {
    if (!container) return;
    if (graphApi) {
      graphApi.destroy();
      graphApi = undefined;
    }

    // Initialize active layers with all layers present in data
    const allLayers = [...new Set(data.nodes.map((n) => n.layer))];
    activeLayers.set(allLayers);

    graphApi = buildSigmaGraph(container, data, {
      onNodeClick: (node) => onNodeClick(node),
      onBackgroundClick: () => onBackgroundClick(),
      edgeIn: $edgeIn,
      edgeOut: $edgeOut,
      layerColors: $layerColors,
    });
  }

  // Build/rebuild Sigma graph whenever graphData changes (initial load or message push)
  $effect(() => {
    const data = $graphData;
    if (!data || !container) return;
    buildGraph(data);
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
  export function getApi(): SigmaGraphApi | undefined {
    return graphApi;
  }
</script>

<div class="graph-canvas">
  <div class="graph-sigma" bind:this={container}></div>
</div>

<style>
  .graph-canvas {
    flex: 1;
    background: transparent;
    overflow: hidden;
    position: relative;
  }
  .graph-sigma {
    width: 100%;
    height: 100%;
  }
  :global(.graph-tooltip) {
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
  }
  :global(.graph-tooltip strong) { color: var(--text-bright); font-size: 12px; display: block; margin-bottom: 4px; }
  :global(.graph-tooltip .tt-meta) { color: var(--text-muted); font-size: 11px; }
  :global(.graph-tooltip .tt-summary) { color: var(--text); font-size: 11px; margin-top: 4px; border-top: 1px solid var(--border); padding-top: 4px; }
</style>
