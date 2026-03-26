<script lang="ts">
  /**
   * BlastRadiusChart.svelte
   *
   * Horizontal bar chart showing files ranked by dependency count.
   * Pure CSS bars — no charting library. Width proportional to max dep_count.
   * Pure presentation — receives all data via props, no data fetching.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders blast radius chart only
   *   - compose-from-small-to-large: used as a leaf panel by PrReview.svelte
   */

  interface BlastRadiusEntry {
    file: string;
    dep_count: number;
  }

  interface BlastRadiusChartProps {
    entries: BlastRadiusEntry[];
  }

  let { entries }: BlastRadiusChartProps = $props();

  const maxDepCount = $derived(
    entries.length > 0 ? Math.max(...entries.map((e) => e.dep_count)) : 0,
  );

  function barWidth(depCount: number): string {
    if (maxDepCount === 0) return "0%";
    return `${Math.round((depCount / maxDepCount) * 100)}%`;
  }

  function basename(file: string): string {
    const parts = file.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] ?? file;
  }

  function truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
  }
</script>

<div class="blast-radius-chart">
  <div class="section-title">Highest Blast Radius</div>

  {#if entries.length === 0}
    <div class="empty">No blast radius data</div>
  {:else}
    <div class="chart-rows">
      {#each entries as entry (entry.file)}
        <div class="chart-row" title={entry.file}>
          <span class="file-name">{truncate(basename(entry.file), 25)}</span>
          <div class="bar-track">
            <div
              class="bar-fill"
              style:width={barWidth(entry.dep_count)}
            ></div>
          </div>
          <span class="dep-count">{entry.dep_count}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .blast-radius-chart {
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

  .file-name {
    width: 140px;
    flex-shrink: 0;
    color: var(--text, #e0e0e0);
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    background: var(--accent, #6c8cff);
  }

  .dep-count {
    width: 28px;
    flex-shrink: 0;
    color: var(--text-muted, #888);
    text-align: right;
    font-size: 10px;
  }
</style>
