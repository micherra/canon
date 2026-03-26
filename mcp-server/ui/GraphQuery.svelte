<script lang="ts">
  import { bridge } from "./stores/bridge";
  import EmptyState from "./components/EmptyState.svelte";
  import { useDataLoader } from "./lib/useDataLoader.svelte";

  const loader = useDataLoader(async () => {
    await bridge.init();
    // The tool requires query_type and target — the MCP App receives them as tool input
    return { placeholder: true };
  });

  let status = $derived(loader.status);
  let data = $derived(loader.data);
  let errorMsg = $derived(loader.errorMsg);
</script>

<div class="graph-query">
  {#if status === "loading"}
    <EmptyState message="Loading graph query..." />
  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />
  {:else if data}
    <div class="placeholder">
      <h2>Graph Query</h2>
      <p class="muted">Call trees, blast radius hierarchy, and search results coming soon</p>
    </div>
  {/if}
</div>

<style>
  .graph-query { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; }
  .placeholder h2 { color: var(--text-bright, #eee); font-size: 16px; font-weight: 600; }
  .muted { color: var(--text-muted, #636a80); }
</style>
