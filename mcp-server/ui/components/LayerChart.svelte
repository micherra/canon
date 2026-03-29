<script lang="ts">
  /**
   * LayerChart.svelte
   *
   * Horizontal bar chart showing file counts per architectural layer.
   * Pure CSS bars — no charting library. Bar color derived from layer name via
   * getLayerColor() from constants.ts (hash-based HSL, consistent with graph views).
   * Pure presentation — receives all data via props, no data fetching.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders layer distribution chart only
   *   - compose-from-small-to-large: used as a leaf panel by PrReview.svelte
   */

  import { getLayerColor } from "../lib/constants";

  interface LayerEntry {
    name: string;
    file_count: number;
  }

  interface LayerChartProps {
    layers: LayerEntry[];
  }

  let { layers }: LayerChartProps = $props();

  const maxCount = $derived(
    layers.length > 0 ? Math.max(...layers.map((l) => l.file_count)) : 0,
  );

  function barWidth(fileCount: number): string {
    if (maxCount === 0) return "0%";
    return `${Math.round((fileCount / maxCount) * 100)}%`;
  }
</script>

<div class="layer-chart">
  <div class="section-title">Changes by Layer</div>

  {#if layers.length === 0}
    <div class="empty">No layer data</div>
  {:else}
    <div class="chart-rows">
      {#each layers as layer (layer.name)}
        <div class="chart-row">
          <span class="layer-name" title={layer.name}>{layer.name}</span>
          <div class="bar-track">
            <div
              class="bar-fill"
              style:width={barWidth(layer.file_count)}
              style:background={getLayerColor(layer.name)}
            ></div>
          </div>
          <span class="file-count">{layer.file_count}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .layer-chart {
    padding: 12px 16px;
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  }

  .section-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted, #888);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 12px;
  }

  .empty {
    font-size: 12px;
    color: var(--text-muted, #888);
    text-align: center;
    padding: 8px 0;
  }

  .chart-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .chart-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }

  .layer-name {
    width: 100px;
    flex-shrink: 0;
    color: var(--text, #e0e0e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }

  .bar-track {
    flex: 1;
    height: 8px;
    background: var(--bg-alt, rgba(255, 255, 255, 0.08));
    border-radius: 4px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 4px;
    opacity: 0.85;
  }

  .file-count {
    width: 28px;
    flex-shrink: 0;
    color: var(--text-muted, #888);
    text-align: right;
    font-size: 10px;
  }
</style>
