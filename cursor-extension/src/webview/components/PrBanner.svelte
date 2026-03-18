<script lang="ts">
  import { activePrReview, prReviewFiles } from "../stores/filters";
  import { VERDICT_COLORS } from "../lib/constants";

  let review = $derived($activePrReview);
  let files = $derived($prReviewFiles);

  function clear() {
    activePrReview.set(null);
    prReviewFiles.set(null);
  }
</script>

{#if review}
  <div class="pr-review-banner">
    <span class="verdict-inline" style="color:{VERDICT_COLORS[review.verdict] || '#7f8c8d'}">{review.verdict || "CLEAN"}</span>
    <span class="score-inline">Rules <span>{review.score?.rules?.passed || 0}/{review.score?.rules?.total || 0}</span></span>
    <span class="score-inline">Opinions <span>{review.score?.opinions?.passed || 0}/{review.score?.opinions?.total || 0}</span></span>
    <span class="score-inline">Conventions <span>{review.score?.conventions?.passed || 0}/{review.score?.conventions?.total || 0}</span></span>
    <span class="score-inline">{(review.violations || []).length} violation{(review.violations || []).length !== 1 ? "s" : ""} across {files ? files.size : 0} files</span>
    <button class="clear-filter" onclick={clear}>Clear</button>
  </div>
{/if}

<style>
  .pr-review-banner {
    display: flex; align-items: center; gap: 16px; padding: 8px 20px;
    background: var(--bg-card); border-bottom: 1px solid var(--border);
    font-size: 12px; flex-shrink: 0;
  }
  .verdict-inline { font-weight: 700; font-size: 14px; }
  .score-inline { color: var(--text-muted); font-weight: 500; }
  .score-inline :global(span) { color: var(--text); font-weight: 600; }
  .clear-filter {
    background: none; border: 1px solid var(--border); color: var(--text-muted);
    padding: 3px 10px; border-radius: 4px; cursor: pointer; font-family: inherit;
    font-size: 11px; font-weight: 500; margin-left: auto; transition: all 0.15s;
  }
  .clear-filter:hover { border-color: var(--accent); color: var(--accent); }
</style>
