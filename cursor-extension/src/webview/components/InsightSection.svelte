<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    count: number;
    badgeClass: string;
    type: string;
    open?: boolean;
    onHeaderClick: (type: string) => void;
    children: Snippet;
  }

  let { title, count, badgeClass, type, open = false, onHeaderClick, children }: Props = $props();
  let isOpen = $state(false);

  $effect(() => {
    isOpen = open;
  });

  function toggle() {
    isOpen = !isOpen;
    onHeaderClick(type);
  }
</script>

<div class="insight-section" class:open={isOpen}>
  <button class="insight-header" onclick={toggle}>
    {title}
    <span>
      <span class="badge {badgeClass}">{count}</span>
      <span class="chevron">›</span>
    </span>
  </button>
  {#if isOpen}
    <div class="insight-body" style="max-height:400px;overflow-y:auto">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .insight-section { border-bottom: 1px solid var(--border); }
  .insight-section:last-child { border-bottom: none; }
  .insight-header {
    display: flex; justify-content: space-between; align-items: center; width: 100%;
    cursor: pointer; padding: 10px 0; font-size: 12px; font-weight: 600;
    color: var(--text-bright); user-select: none;
    background: none; border: none; font-family: inherit; text-align: left;
  }
  .insight-header:hover { color: var(--accent); }
  .badge {
    font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 10px;
    background: var(--bg-card); color: var(--text-muted); min-width: 20px; text-align: center;
  }
  .badge.warn { background: rgba(251,191,36,0.15); color: var(--warning); }
  .badge.danger { background: rgba(255,107,107,0.15); color: var(--danger); }
  .chevron { transition: transform 0.2s; font-size: 10px; color: var(--text-muted); margin-left: 8px; }
  .open .chevron { transform: rotate(90deg); }
  .insight-body { transition: max-height 0.25s ease; }
</style>
