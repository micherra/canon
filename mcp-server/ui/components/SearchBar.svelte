<script lang="ts">
  import { graphData, layerColors } from "../stores/graphData";
  import { activeLayers, searchQuery } from "../stores/filters";
  import { parseSearchQuery } from "../lib/graph";
  import { getLayerColor } from "../lib/constants";
  import { escapeHtml } from "../lib/escapeHtml";

  interface Props {
    onZoomToNode: (nodeId: string) => void;
  }

  let { onZoomToNode }: Props = $props();

  let inputEl: HTMLInputElement;
  let isOpen = $state(false);
  let results = $state<Array<{ id: string; layer: string; pathHtml: string }>>([]);
  let searchTimeout: ReturnType<typeof setTimeout>;
  let wrapper: HTMLDivElement;

  function handleInput() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery.set(inputEl.value);
      updateDropdown();
    }, 150);
  }

  function handleFocus() {
    if (inputEl.value) updateDropdown();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      searchQuery.set("");
      inputEl.value = "";
      isOpen = false;
    }
  }

  function updateDropdown() {
    const query = inputEl.value;
    if (!query || query.length < 1) { isOpen = false; return; }

    const data = $graphData;
    if (!data) return;

    const parsed = parseSearchQuery(query);
    const activeLayerSet = $activeLayers;
    let matches = data.nodes.filter((n) => activeLayerSet.includes(n.layer));

    if (parsed.filterLayer) matches = matches.filter((n) => n.layer.toLowerCase().includes(parsed.filterLayer!));
    if (parsed.filterChanged) matches = matches.filter((n) => n.changed);
    if (parsed.filterViolation) matches = matches.filter((n) => (n.violation_count || 0) > 0);

    if (parsed.textQuery.length >= 2) {
      const q = parsed.textQuery.toLowerCase();
      matches = matches.filter((n) => n.id.toLowerCase().includes(q));
    } else if (!parsed.filterLayer && !parsed.filterChanged && !parsed.filterViolation) {
      isOpen = false;
      return;
    }

    matches = matches.slice(0, 15);
    if (matches.length === 0) { isOpen = false; return; }

    const q = (parsed.textQuery || "").toLowerCase();
    results = matches.map((n) => {
      let pathHtml: string;
      if (q.length >= 2) {
        const idx = n.id.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const before = escapeHtml(n.id.slice(0, idx));
          const match = escapeHtml(n.id.slice(idx, idx + q.length));
          const after = escapeHtml(n.id.slice(idx + q.length));
          pathHtml = `${before}<span class="match-highlight">${match}</span>${after}`;
        } else {
          pathHtml = escapeHtml(n.id);
        }
      } else {
        pathHtml = escapeHtml(n.id);
      }
      return { id: n.id, layer: n.layer, pathHtml };
    });
    isOpen = true;
  }

  function selectResult(nodeId: string) {
    isOpen = false;
    onZoomToNode(nodeId);
  }

  // Global keyboard handler for "/" to focus search
  function handleGlobalKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "/") {
      e.preventDefault();
      inputEl?.focus();
    }
  }

  // Click outside to close
  function handleClickOutside(e: MouseEvent) {
    if (wrapper && !wrapper.contains(e.target as Node)) isOpen = false;
  }

  import { onMount } from "svelte";
  onMount(() => {
    document.addEventListener("keydown", handleGlobalKey);
    document.addEventListener("click", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleGlobalKey);
      document.removeEventListener("click", handleClickOutside);
    };
  });

  export function focus() { inputEl?.focus(); }
</script>

<div class="search-prominent" bind:this={wrapper}>
  <input
    type="text"
    class="search-input"
    placeholder="Search files..."
    bind:this={inputEl}
    oninput={handleInput}
    onfocus={handleFocus}
    onkeydown={handleKeydown}
  />
  {#if isOpen && results.length > 0}
    <div class="search-results open">
      {#each results as r}
        <button class="search-result-item" onclick={() => selectResult(r.id)}>
          <span class="chip-dot" style="background:{getLayerColor(r.layer, $layerColors)}"></span>
          <span class="match-path">{@html r.pathHtml}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .search-prominent { position: relative; display: flex; align-items: center; }
  .search-input {
    background: var(--bg-card); border: 1px solid var(--border);
    color: var(--text); padding: 7px 14px; border-radius: 20px;
    font-family: inherit; font-size: 12px; width: 350px;
    transition: all 0.25s ease;
  }
  .search-input::placeholder { color: var(--text-muted); }
  .search-input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft); width: 450px;
  }
  .search-results {
    position: absolute; top: 100%; left: 0; right: 0; width: 100%; max-height: 280px;
    overflow-y: auto; background: #14182a; border: 1px solid rgba(255,255,255,0.08);
    border-radius: var(--radius); margin-top: 6px; z-index: 100;
    box-shadow: var(--shadow-lg);
  }
  .search-result-item {
    width: 100%; background: none; border: none; font-family: inherit; text-align: left; color: inherit;
    padding: 8px 14px; font-size: 12px; cursor: pointer;
    display: flex; align-items: center; gap: 8px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 0.1s;
  }
  .search-result-item:last-child { border-bottom: none; }
  .search-result-item:hover { background: var(--accent-soft); }
  .search-result-item :global(.match-highlight) { color: var(--accent); font-weight: 600; }
  .chip-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
</style>
