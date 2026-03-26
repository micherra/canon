<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<any>(null);
  let errorMsg = $state("");

  onMount(async () => {
    try {
      await bridge.init();
      data = await bridge.callTool("get_drift_report");
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load drift report";
    }
  });
</script>

<div class="drift-report">
  {#if status === "loading"}
    <div class="empty-state">Loading drift report...</div>
  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>
  {:else if data}
    <div class="placeholder">
      <h2>Drift Report</h2>
      <p>{data.report?.total_reviews ?? 0} reviews &middot; {data.report?.most_violated?.length ?? 0} violated principles</p>
      <p>{data.pr_reviews?.length ?? 0} PR reviews</p>
      <p class="muted">Drift visualization coming soon</p>
    </div>
  {/if}
</div>

<style>
  .drift-report { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .empty-state { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--text-muted, #888); font-size: 13px; }
  .error { color: var(--danger, #e05252); }
  .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; }
  .placeholder h2 { color: var(--text-bright, #eee); font-size: 16px; font-weight: 600; }
  .placeholder p { color: var(--text, #b4b8c8); font-size: 13px; }
  .muted { color: var(--text-muted, #636a80); }
</style>
