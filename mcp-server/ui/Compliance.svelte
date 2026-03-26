<script lang="ts">
  import { bridge } from "./stores/bridge";
  import EmptyState from "./components/EmptyState.svelte";
  import { useDataLoader } from "./lib/useDataLoader.svelte";

  const loader = useDataLoader(async () => {
    await bridge.init();
    // The tool requires a principle_id — the MCP App receives it as tool input
    // For now, show a placeholder until the tool call provides the principle_id
    return { placeholder: true };
  });

  let status = $derived(loader.status);
  let data = $derived(loader.data);
  let errorMsg = $derived(loader.errorMsg);
</script>

<div class="compliance">
  {#if status === "loading"}
    <EmptyState message="Loading compliance data..." />
  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />
  {:else if data}
    <div class="placeholder">
      <h2>Compliance</h2>
      <p class="muted">Compliance meter, trend chart, and stats coming soon</p>
    </div>
  {/if}
</div>

<style>
  .compliance { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; }
  .placeholder h2 { color: var(--text-bright, #eee); font-size: 16px; font-weight: 600; }
  .muted { color: var(--text-muted, #636a80); }
</style>
