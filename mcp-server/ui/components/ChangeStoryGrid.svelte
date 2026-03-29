<script lang="ts">
  import { clusterFiles, clusterIcon } from "../lib/clustering.ts";
  import type { ClusterInput, Cluster } from "../lib/clustering.ts";

  // ── Props ────────────────────────────────────────────────────────────────

  interface ChangeStoryGridProps {
    files: Array<{
      path: string;
      status: "added" | "modified" | "deleted" | "renamed";
      layer: string;
    }>;
    onPrompt: (text: string) => void;
  }

  let { files, onPrompt }: ChangeStoryGridProps = $props();

  // ── Derived ───────────────────────────────────────────────────────────────

  let clusters = $derived(clusterFiles(files as ClusterInput[]));

  // ── Helpers ───────────────────────────────────────────────────────────────

  function buildPrompt(cluster: Cluster): string {
    switch (cluster.type) {
      case "new-feature":
        return `Walk me through what ${cluster.title} adds to the codebase`;
      case "removal":
        return `Why was ${cluster.title} removed and what replaced it`;
      default:
        return `Explain the changes in ${cluster.title}`;
    }
  }

  function statusChipClass(status: ClusterInput["status"]): string {
    switch (status) {
      case "added":    return "chip-added";
      case "deleted":  return "chip-deleted";
      case "modified": return "chip-modified";
      case "renamed":  return "chip-renamed";
    }
  }

  function shortFileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1];
  }
</script>

<div class="change-story-grid">
  {#if clusters.length === 0}
    <div class="empty-state">No change stories to display</div>
  {:else}
    <div class="grid">
      {#each clusters as cluster (cluster.id)}
        <button
          class="card"
          onclick={() => onPrompt(buildPrompt(cluster))}
          title={buildPrompt(cluster)}
        >
          <div class="card-header">
            <span class="cluster-icon">{clusterIcon(cluster.type)}</span>
            <span class="cluster-title">{cluster.title}</span>
          </div>
          <p class="cluster-description">{cluster.description}</p>
          <div class="file-chips">
            {#each cluster.files.slice(0, 5) as file (file.path)}
              <span class="file-chip {statusChipClass(file.status)}" title={file.path}>
                {shortFileName(file.path)}
              </span>
            {/each}
            {#if cluster.files.length > 5}
              <span class="file-chip chip-more">+{cluster.files.length - 5} more</span>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .change-story-grid {
    width: 100%;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 8px 12px;
  }

  /* ── Card ──────────────────────────────────────────────────────────────── */

  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    transition: background 0.15s, border-color 0.15s;
  }

  .card:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
    border-color: var(--accent-soft, rgba(108,140,255,0.3));
  }

  /* ── Card header ─────────────────────────────────────────────────────── */

  .card-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cluster-icon {
    font-size: 14px;
    flex-shrink: 0;
    color: var(--accent, #6c8cff);
  }

  .cluster-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* ── Description ─────────────────────────────────────────────────────── */

  .cluster-description {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    line-height: 1.5;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ── File chips ──────────────────────────────────────────────────────── */

  .file-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 2px;
  }

  .file-chip {
    font-family: monospace;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    white-space: nowrap;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chip-added {
    background: rgba(52, 211, 153, 0.12);
    color: var(--success, #34d399);
    border: 1px solid rgba(52, 211, 153, 0.25);
  }

  .chip-deleted {
    background: rgba(255, 107, 107, 0.12);
    color: var(--danger, #ff6b6b);
    border: 1px solid rgba(255, 107, 107, 0.25);
  }

  .chip-modified {
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
    border: 1px solid rgba(251, 191, 36, 0.25);
  }

  .chip-renamed {
    background: rgba(108, 140, 255, 0.12);
    color: var(--accent, #6c8cff);
    border: 1px solid rgba(108, 140, 255, 0.25);
  }

  .chip-more {
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
    border: 1px solid var(--border, rgba(255,255,255,0.06));
  }

  /* ── Empty state ─────────────────────────────────────────────────────── */

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    color: var(--text-muted, #636a80);
    font-size: 13px;
  }
</style>
