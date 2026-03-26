<script lang="ts">
  /**
   * StatsRow.svelte
   *
   * A horizontal row of 4 stat cards summarising key PR review metrics.
   * Pure presentation — no data fetching, no store access.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders stat summary row only
   *   - compose-from-small-to-large: standalone leaf; composed by PrReview.svelte
   */

  import { splitFilePath } from "../lib/utils";

  interface StatsRowProps {
    filesChanged: number;
    violationCount: number;
    ruleCount: number;
    highestBlastRadius: { file: string; dep_count: number } | null;
  }

  let { filesChanged, violationCount, ruleCount, highestBlastRadius }: StatsRowProps = $props();

  const blastBasename = $derived(
    highestBlastRadius ? splitFilePath(highestBlastRadius.file).name : null,
  );
</script>

<div class="stats-row">
  <!-- Card 1: Files Changed -->
  <div class="stat-card">
    <span class="stat-value">{filesChanged}</span>
    <span class="stat-label">Files Changed</span>
  </div>

  <!-- Card 2: Violations (red when > 0) -->
  <div class="stat-card">
    <span class="stat-value" class:stat-value--danger={violationCount > 0}>{violationCount}</span>
    <span class="stat-label">Violations</span>
  </div>

  <!-- Card 3: Rule-level violations -->
  <div class="stat-card">
    <span class="stat-value" class:stat-value--danger={ruleCount > 0}>{ruleCount}</span>
    <span class="stat-label">Rules</span>
  </div>

  <!-- Card 4: Highest Blast Radius -->
  <div class="stat-card">
    {#if highestBlastRadius && blastBasename}
      <span class="stat-value stat-value--file" title={highestBlastRadius.file}>
        {blastBasename}
      </span>
      <span class="stat-label">{highestBlastRadius.dep_count} dependents</span>
    {:else}
      <span class="stat-value stat-value--muted">None</span>
      <span class="stat-label">Highest Blast Radius</span>
    {/if}
  </div>
</div>

<style>
  .stats-row {
    display: flex;
    gap: 12px;
    padding: 12px 16px;
    flex-shrink: 0;
  }

  .stat-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
    min-width: 0;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text, #e0e0e0);
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stat-value--danger {
    color: var(--danger, #e74c3c);
  }

  .stat-value--muted {
    color: var(--text-muted, #888);
  }

  .stat-value--file {
    font-size: 14px;
    font-family: var(--font-mono, monospace);
    padding-top: 5px;
  }

  .stat-label {
    font-size: 11px;
    color: var(--text-muted, #888);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
