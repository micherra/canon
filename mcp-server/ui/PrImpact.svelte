<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";

  let status = $state<"loading" | "ready" | "error">("loading");
  let errorMessage = $state("");

  onMount(async () => {
    try {
      await bridge.init();
      status = "ready";
    } catch (e) {
      status = "error";
      errorMessage = e instanceof Error ? e.message : "Failed to connect";
    }
  });
</script>

<div class="pr-impact">
  {#if status === "loading"}
    <div class="empty-state">Loading PR Impact data...</div>
  {:else if status === "error"}
    <div class="empty-state error">{errorMessage}</div>
  {:else}
    <div class="empty-state">PR Impact View — scaffold ready</div>
  {/if}
</div>

<style>
  .pr-impact {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 500px;
  }
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-muted);
    font-size: 14px;
  }
  .error { color: var(--danger); }
</style>
