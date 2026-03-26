<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<any>(null);
  let errorMsg = $state("");

  onMount(async () => {
    try {
      await bridge.init();
      // The tool requires query_type and target — the MCP App receives them as tool input
      data = { placeholder: true };
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load graph query";
    }
  });
</script>

<div class="graph-query">
  {#if status === "loading"}
    <div class="empty-state">Loading graph query...</div>
  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>
  {:else if data}
    <div class="placeholder">
      <h2>Graph Query</h2>
      <p class="muted">Call trees, blast radius hierarchy, and search results coming soon</p>
    </div>
  {/if}
</div>

<style>
  .graph-query { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .empty-state { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--text-muted, #888); font-size: 13px; }
  .error { color: var(--danger, #e05252); }
  .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; }
  .placeholder h2 { color: var(--text-bright, #eee); font-size: 16px; font-weight: 600; }
  .muted { color: var(--text-muted, #636a80); }
</style>
