<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import NarrativeSummary from "./components/NarrativeSummary.svelte";
  import ChangeStoryGrid from "./components/ChangeStoryGrid.svelte";
  import ImpactTabs from "./components/ImpactTabs.svelte";

  // ── Types ─────────────────────────────────────────────────────────────────

  interface PrFileInfo {
    path: string;
    layer: string;
    status: "added" | "modified" | "deleted" | "renamed";
    bucket: "needs-attention" | "worth-a-look" | "low-risk";
    reason: string;
    priority_score?: number;
    priority_factors?: {
      in_degree: number;
      violation_count: number;
      is_changed: boolean;
      layer: string;
      layer_centrality: number;
    };
    violations?: Array<{
      principle_id: string;
      severity: "rule" | "strong-opinion" | "convention";
      message?: string;
    }>;
  }

  interface BlastRadiusEntry {
    file: string;
    affected: Array<{ path: string; depth: number }>;
  }

  interface PrReviewData {
    files: PrFileInfo[];
    layers: Array<{ name: string; file_count: number }>;
    total_files: number;
    incremental: boolean;
    last_reviewed_sha?: string;
    diff_command: string;
    narrative: string;
    blast_radius: BlastRadiusEntry[];
    graph_data_age_ms?: number;
    error?: string;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<PrReviewData | null>(null);
  let errorMsg = $state("");

  // ── Derived state ──────────────────────────────────────────────────────────

  let totalViolations = $derived(
    (data?.files ?? []).reduce((sum, f) => sum + (f.violations?.length ?? 0), 0)
  );

  let netNewFiles = $derived((() => {
    const files = data?.files ?? [];
    const added = files.filter(f => f.status === "added").length;
    const deleted = files.filter(f => f.status === "deleted").length;
    return added - deleted;
  })());

  let isStale = $derived(
    (data?.graph_data_age_ms ?? 0) > 3_600_000
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await bridge.init();
      data = await bridge.callTool("get_pr_review_data");
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load PR review data";
    }
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handlePrompt(text: string) {
    bridge.sendMessage(text);
  }
</script>

<div class="pr-review-prep">
  {#if status === "loading"}
    <div class="empty-state">Loading PR review data...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if data && data.total_files === 0}
    <div class="empty-state">No changed files found.</div>

  {:else if data}
    <!-- Header bar -->
    <div class="header-bar">
      <span class="header-title">PR Review</span>
      {#if data.incremental && data.last_reviewed_sha}
        <span class="badge-incremental">Incremental from {data.last_reviewed_sha.slice(0, 7)}</span>
      {/if}
    </div>

    <!-- Section 1: Narrative Summary -->
    <NarrativeSummary
      narrative={data.narrative}
      totalFiles={data.total_files}
      layerCount={data.layers.length}
      netNewFiles={netNewFiles}
      violationCount={totalViolations}
    />

    <!-- Section 2: Change Story Cards -->
    <ChangeStoryGrid files={data.files} onPrompt={handlePrompt} />

    <!-- Staleness Warning -->
    {#if isStale}
      <div class="staleness-warning">
        Graph data is over 1 hour old. Re-index for accurate dependency information.
      </div>
    {/if}

    <!-- Section 3: Impact Tabs -->
    <ImpactTabs
      files={data.files}
      blastRadius={data.blast_radius}
      onPrompt={handlePrompt}
    />
  {/if}
</div>

<style>
  .pr-review-prep {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
    min-height: 600px;
  }

  /* ── Header bar ──────────────────────────────────────────────────────────── */

  .header-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--text-muted, #636a80);
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .header-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--text-bright, #e8eaf0);
  }

  .badge-incremental {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent-soft, rgba(108,140,255,0.12));
    color: var(--accent, #6c8cff);
  }

  /* ── Staleness warning ───────────────────────────────────────────────────── */

  .staleness-warning {
    padding: 8px 12px;
    background: rgba(251, 191, 36, 0.08);
    border-bottom: 1px solid rgba(251, 191, 36, 0.25);
    border-top: 1px solid rgba(251, 191, 36, 0.25);
    color: var(--warning, #fbbf24);
    font-size: 12px;
    flex-shrink: 0;
  }

  /* ── Empty states ────────────────────────────────────────────────────────── */

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-muted, #888);
    font-size: 13px;
    padding: 32px;
    text-align: center;
  }

  .error { color: var(--danger, #e05252); }
</style>
