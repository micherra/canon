<script lang="ts">
/**
 * NarrativeSummary.svelte
 *
 * Displays the narrative text paragraph and three metric cards:
 *   - Files Changed (totalFiles across layerCount layers)
 *   - Net New Files (netNewFiles)
 *   - Violations (violationCount, red if > 0)
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component, composed by container in Wave 4
 *   - props-are-the-component-contract: receives exactly what it needs, no global state
 */

interface NarrativeSummaryProps {
  narrative: string;
  totalFiles: number;
  layerCount: number;
  netNewFiles: number;
  violationCount: number;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { narrative, totalFiles, layerCount, netNewFiles, violationCount }: NarrativeSummaryProps = $props();
</script>

<div class="narrative-summary">
  {#if narrative}
    <div class="narrative-banner">
      <p class="narrative-text">{narrative}</p>
    </div>
  {/if}

  <div class="metric-cards">
    <div class="metric-card">
      <span class="metric-number">{totalFiles}</span>
      <span class="metric-label">Files Changed</span>
      <span class="metric-sublabel">across {layerCount} layer{layerCount === 1 ? "" : "s"}</span>
    </div>

    <div class="metric-card">
      <span class="metric-number" class:positive={netNewFiles > 0} class:negative={netNewFiles < 0}>
        {netNewFiles > 0 ? "+" : ""}{netNewFiles}
      </span>
      <span class="metric-label">Net New Files</span>
    </div>

    <div class="metric-card">
      <span class="metric-number" class:danger={violationCount > 0}>{violationCount}</span>
      <span class="metric-label">Violations</span>
    </div>
  </div>
</div>

<style>
  .narrative-summary {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ── Narrative banner ──────────────────────────────────────────────────── */

  .narrative-banner {
    padding: 10px 12px;
    background: var(--bg-surface, rgba(255,255,255,0.04));
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
  }

  .narrative-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-bright, #e8eaf0);
    margin: 0;
  }

  /* ── Metric cards ─────────────────────────────────────────────────────── */

  .metric-cards {
    display: flex;
    gap: 1px;
    background: var(--border, rgba(255,255,255,0.06));
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
  }

  .metric-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 10px 16px;
    flex: 1;
    background: var(--bg-card, rgba(255,255,255,0.04));
    gap: 2px;
  }

  .metric-number {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
    line-height: 1;
  }

  .metric-number.danger {
    color: var(--danger, #ff6b6b);
  }

  .metric-number.positive {
    color: var(--success, #34d399);
  }

  .metric-number.negative {
    color: var(--danger, #ff6b6b);
  }

  .metric-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .metric-sublabel {
    font-size: 10px;
    color: var(--text-muted, #636a80);
  }
</style>
