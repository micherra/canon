<script lang="ts">
  /**
   * HotspotList.svelte
   *
   * A scrollable file list ranked by risk score.
   * Pure presentation — receives all data via props, no data fetching.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders risk-ranked file list only
   *   - compose-from-small-to-large: used as an atom by PrReview.svelte
   */

  import { basename } from "../lib/graph";

  interface HotspotItem {
    file: string;
    blast_radius_count: number;
    violation_count: number;
    risk_score: number;
    violations: Array<{ principle_id: string; severity: string; message?: string }>;
  }

  interface HotspotListProps {
    hotspots: HotspotItem[];
    selectedFile: string | null;
    onFileSelect: (file: string) => void;
  }

  let { hotspots, selectedFile, onFileSelect }: HotspotListProps = $props();

  /** Returns the dominant severity color for a hotspot row */
  function dominantSeverityColor(violations: HotspotItem["violations"]): string {
    if (violations.some((v) => v.severity === "rule")) return "var(--danger, #e05252)";
    if (violations.some((v) => v.severity === "strong-opinion")) return "var(--warning, #e0a752)";
    if (violations.length > 0) return "var(--text-muted, #888)";
    return "transparent";
  }

  /** Format blast radius count for display */
  function formatBlast(count: number): string {
    return count > 0 ? `BR:${count}` : "";
  }
</script>

<div class="hotspot-list" role="list" aria-label="Files ranked by risk score">
  {#if hotspots.length === 0}
    <div class="empty">No changed files found.</div>
  {:else}
    {#each hotspots as hotspot (hotspot.file)}
      <button
        class="btn-reset hotspot-row"
        class:selected={selectedFile === hotspot.file}
        aria-current={selectedFile === hotspot.file ? "true" : undefined}
        onclick={() => onFileSelect(hotspot.file)}
        title={hotspot.file}
      >
        <!-- Severity indicator dot -->
        <span
          class="severity-dot"
          style:background={dominantSeverityColor(hotspot.violations)}
          aria-hidden="true"
        ></span>

        <!-- Filename (basename for display) -->
        <span class="filename">{basename(hotspot.file)}</span>

        <!-- Stats: blast radius + violations -->
        <span class="stats">
          {#if hotspot.blast_radius_count > 0}
            <span class="stat blast" title="Blast radius: {hotspot.blast_radius_count} affected entities">
              {formatBlast(hotspot.blast_radius_count)}
            </span>
          {/if}
          {#if hotspot.violation_count > 0}
            <span
              class="stat violations"
              style:color={dominantSeverityColor(hotspot.violations)}
              title="{hotspot.violation_count} violation{hotspot.violation_count === 1 ? '' : 's'}"
            >
              {hotspot.violation_count}v
            </span>
          {/if}
        </span>

        <!-- Risk score indicator -->
        {#if hotspot.risk_score > 0}
          <span class="risk-score" title="Risk score: {hotspot.risk_score}">{hotspot.risk_score}</span>
        {/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .hotspot-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    height: 100%;
    padding: 4px 0;
  }

  .empty {
    padding: 16px;
    color: var(--text-muted, #888);
    font-size: 12px;
    text-align: center;
  }

  .hotspot-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--text, #e0e0e0);
    border-radius: 0;
    transition: background 0.1s;
    min-height: 28px;
  }

  .hotspot-row:hover {
    background: var(--bg-hover, rgba(255,255,255,0.05));
  }

  .hotspot-row.selected {
    background: var(--accent-soft, rgba(78, 154, 241, 0.15));
  }

  .severity-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .filename {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
  }

  .stats {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .stat {
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--bg-alt, #2a2a2a);
    white-space: nowrap;
  }

  .blast {
    color: var(--text-muted, #888);
  }

  .risk-score {
    font-size: 10px;
    color: var(--text-muted, #888);
    min-width: 16px;
    text-align: right;
    flex-shrink: 0;
  }
</style>
