<script lang="ts">
  import HealthStrip from "./HealthStrip.svelte";
  import InsightsPanel from "./InsightsPanel.svelte";
  import DetailPanel from "./DetailPanel.svelte";
  import { selectedNode, panelMode } from "../stores/selection";
  import type { GraphNode } from "../stores/graphData";

  interface Props {
    onFileClick: (fileId: string) => void;
    onHighlightCategory: (type: string) => void;
    onClearHighlight: () => void;
    onHighlightCascade: (nodeId: string) => void;
    onBackToOverview: () => void;
    hasActiveHighlight: boolean;
  }

  let { onFileClick, onHighlightCategory, onClearHighlight, onHighlightCascade, onBackToOverview, hasActiveHighlight }: Props = $props();
</script>

<div class="right-panel">
  {#if $panelMode === "overview"}
    <HealthStrip onStatClick={onHighlightCategory} />
    <InsightsPanel
      {onFileClick}
      {onHighlightCategory}
      {hasActiveHighlight}
      {onClearHighlight}
    />
  {:else if $selectedNode}
    <DetailPanel
      node={$selectedNode}
      {onBackToOverview}
      {onFileClick}
      {onHighlightCascade}
    />
  {/if}
</div>

<style>
  .right-panel {
    width: 380px; display: flex; flex-direction: column; gap: 0;
    min-height: 0; flex-shrink: 0;
    background: rgba(12,15,26,0.85); backdrop-filter: blur(16px);
    border-left: 1px solid var(--border);
  }
</style>
