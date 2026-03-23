<script lang="ts">
  import { onMount } from "svelte";
  import SearchBar from "./SearchBar.svelte";
  import { graphData, prReviews } from "../stores/graphData";
  import { activePrReview, prReviewFiles } from "../stores/filters";
  import { bridge } from "../stores/bridge";

  interface Props {
    onZoomToNode: (nodeId: string) => void;
    onRefreshGraph: () => void;
  }

  let { onZoomToNode, onRefreshGraph }: Props = $props();

  let branchName = $state("...");
  let changedCount = $state(0);

  // PR review handling
  let reviews = $derived($prReviews || []);

  onMount(() => {
    const data = $graphData;
    if (data) {
      changedCount = data.nodes.filter((n) => n.changed).length;
    }
    bridge.request("getBranch").then((info) => {
      if (info?.branch) branchName = info.branch;
    }).catch(() => {});
  });

  function prLabel(r: { pr_number?: number; pr_review_id?: string; verdict: string }): string {
    const id = r.pr_number != null ? `PR #${r.pr_number}` : r.pr_review_id || "Review";
    return `${id} — ${r.verdict}`;
  }

  function onPrChange(e: Event) {
    const idx = parseInt((e.target as HTMLSelectElement).value, 10);
    const review = reviews[idx];
    if (review) {
      activePrReview.set(review);
      prReviewFiles.set(new Set(review.files || []));
    } else {
      activePrReview.set(null);
      prReviewFiles.set(null);
    }
  }
</script>

<div class="toolbar">
  <div class="toolbar-brand"><span>Canon</span></div>
  <div class="toolbar-sep"></div>
  <div class="branch-chip">
    <span class="branch-icon">⎇</span>
    <span class="branch-name">{branchName}</span>
    {#if changedCount > 0}
      <span class="branch-changed-badge">{changedCount} changed</span>
    {/if}
  </div>
  {#if reviews.length > 0}
    <div class="pr-filter-bar">
      <label for="pr-review-select" style="font-size:12px;color:var(--text-muted)">PR Review:</label>
      <select id="pr-review-select" onchange={onPrChange}>
        <option value="">All files</option>
        {#each reviews as review, idx}
          <option value={idx}>{prLabel(review)}</option>
        {/each}
      </select>
    </div>
  {/if}
  <div class="toolbar-spacer"></div>
  <SearchBar {onZoomToNode} />
  <button class="refresh-btn" onclick={onRefreshGraph} title="Regenerate graph">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  </button>
</div>

<style>
  .toolbar {
    display: flex; align-items: center; gap: 10px; padding: 12px 20px;
    border-bottom: 1px solid var(--border); flex-shrink: 0;
    background: rgba(255,255,255,0.015); backdrop-filter: blur(12px);
  }
  .toolbar-brand { font-size: 15px; font-weight: 700; color: var(--text-bright); letter-spacing: -0.3px; margin-right: 4px; white-space: nowrap; }
  .toolbar-brand :global(span) { color: var(--accent); }
  .toolbar-sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; flex-shrink: 0; }
  .toolbar-spacer { flex: 1; }
  .branch-chip {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 500; color: var(--text-muted);
    background: var(--bg-card); padding: 4px 10px;
    border-radius: 20px; border: 1px solid var(--border); white-space: nowrap;
  }
  .branch-icon { font-size: 13px; }
  .branch-changed-badge {
    background: var(--accent-soft); color: var(--accent); font-weight: 600;
    padding: 1px 6px; border-radius: 10px; font-size: 10px; margin-left: 4px;
  }
  .pr-filter-bar { display: contents; }
  .pr-filter-bar :global(select) {
    background: var(--bg-card); border: 1px solid var(--border); color: var(--text);
    padding: 4px 10px; border-radius: 20px; font-family: inherit; font-size: 11px;
    cursor: pointer; transition: border-color 0.15s;
  }
  .pr-filter-bar :global(select:focus) { outline: none; border-color: var(--accent); }
  .refresh-btn {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--bg-card); border: 1px solid var(--border); color: var(--text-muted);
    width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
    transition: color 0.15s, border-color 0.15s; flex-shrink: 0;
  }
  .refresh-btn:hover { color: var(--accent); border-color: var(--accent); }
</style>
