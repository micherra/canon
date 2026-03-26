<script lang="ts">
  import { bridge } from "./stores/bridge";
  import EmptyState from "./components/EmptyState.svelte";
  import { useDataLoader } from "./lib/useDataLoader.svelte";

  interface DriftReportResponse {
    report?: {
      total_reviews: number;
      most_violated?: Array<{ principle_id: string; count: number }>;
    };
    pr_reviews?: Array<{ review_id: string }>;
  }

  const loader = useDataLoader(async () => {
    await bridge.init();
    return bridge.callTool("get_drift_report") as Promise<DriftReportResponse>;
  });

  let status = $derived(loader.status);
  let data = $derived(loader.data);
  let errorMsg = $derived(loader.errorMsg);
</script>

<div class="drift-report">
  {#if status === "loading"}
    <EmptyState message="Loading drift report..." />
  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />
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
  .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; }
  .placeholder h2 { color: var(--text-bright, #eee); font-size: 16px; font-weight: 600; }
  .placeholder p { color: var(--text, #b4b8c8); font-size: 13px; }
  .muted { color: var(--text-muted, #636a80); }
</style>
