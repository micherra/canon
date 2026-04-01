<script lang="ts">
/**
 * ImpactRow.svelte
 *
 * A single file row in the impact list. Renders:
 *   - File path with filename portion bold (split on last "/")
 *   - Score bar proportional to maxScore, color-coded by severity threshold
 *   - Dependency count badge
 *   - Bucket badge with color scheme matching v1
 *   - Click handler that calls onPrompt with a contextual prompt string
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component, composed into the impact section
 *   - props-are-the-component-contract: no bridge access, no global state
 */

interface ImpactRowProps {
  filePath: string;
  priorityScore: number;
  maxScore: number;
  depCount: number;
  bucket: string;
  onPrompt: (text: string) => void;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { filePath, priorityScore, maxScore, depCount, bucket, onPrompt }: ImpactRowProps = $props();

/** Score bar width clamped to [0, 100]% */
let _barWidth = $derived(maxScore > 0 ? Math.min(100, Math.round((priorityScore / maxScore) * 100)) : 0);

/** Bar color by severity threshold */
let _barColor = $derived(
  priorityScore >= 20
    ? "var(--danger, #ff6b6b)"
    : priorityScore >= 10
      ? "var(--warning, #fbbf24)"
      : "var(--accent, #6c8cff)",
);

/** Bucket display label and color */
let _bucketLabel = $derived(
  bucket === "needs-attention" ? "Needs attention" : bucket === "worth-a-look" ? "Worth a look" : "Low risk",
);

let _bucketClass = $derived(
  bucket === "needs-attention" ? "bucket-danger" : bucket === "worth-a-look" ? "bucket-warning" : "bucket-muted",
);

function _handleClick() {
  onPrompt(`Show me ${filePath} and explain what changed`);
}
</script>

<button class="impact-row btn-reset" onclick={handleClick} title={filePath}>
  <!-- File path: directory prefix muted, filename bold -->
  <FilePath path={filePath} />

  <!-- Score bar -->
  <span class="score-bar-wrap" title="Priority score: {priorityScore}">
    <span
      class="score-bar-fill"
      style="width: {barWidth}%; background: {barColor};"
    ></span>
  </span>

  <!-- Dep count badge -->
  {#if depCount > 0}
    <span class="dep-badge" title="{depCount} dependent{depCount === 1 ? '' : 's'}">
      {depCount}d
    </span>
  {/if}

  <!-- Bucket badge -->
  <span class="bucket-badge {bucketClass}">{bucketLabel}</span>
</button>

<style>
  .impact-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    transition: background 0.12s;
    border-radius: 0;
    min-height: 28px;
  }

  .impact-row:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
  }

  /* ── Score bar ─────────────────────────────────────────────────────────── */

  .score-bar-wrap {
    width: 60px;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-card, rgba(255,255,255,0.08));
    flex-shrink: 0;
    overflow: hidden;
  }

  .score-bar-fill {
    display: block;
    height: 100%;
    border-radius: 2px;
    transition: width 0.2s;
  }

  /* ── Dep count badge ───────────────────────────────────────────────────── */

  .dep-badge {
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* ── Bucket badge ──────────────────────────────────────────────────────── */

  .bucket-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .bucket-danger {
    background: rgba(255, 107, 107, 0.15);
    color: var(--danger, #ff6b6b);
  }

  .bucket-warning {
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
  }

  .bucket-muted {
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
  }
</style>
