<script lang="ts">
  /**
   * PrReview.svelte
   *
   * Unified progressive PR Review container.
   *
   * Two-mode layout:
   *   - prep-only mode (has_review === false): single-column view — NarrativeSummary,
   *     ChangeStoryGrid, ImpactTabs, plus a "Run Review" banner.
   *   - review mode (has_review === true): scrollable dashboard of 8 panels:
   *     VerdictBanner, StatsRow, FixBeforeMerge, ViolationsByPrinciple,
   *     ComplianceScore, BlastRadiusChart, LayerChart, SubsystemsPanel.
   *
   * Canon principles:
   *   - compose-from-small-to-large: pure composition container; no leaf logic
   *   - deep-modules: minimal interface — no props; all state internal
   */

  import { bridge } from "./stores/bridge";
  import { useDataLoader } from "./lib/useDataLoader.svelte";
  import EmptyState from "./components/EmptyState.svelte";
  import NarrativeSummary from "./components/NarrativeSummary.svelte";
  import ChangeStoryGrid from "./components/ChangeStoryGrid.svelte";
  import ImpactTabs from "./components/ImpactTabs.svelte";
  import VerdictBanner from "./components/VerdictBanner.svelte";
  import StatsRow from "./components/StatsRow.svelte";
  import FixBeforeMerge from "./components/FixBeforeMerge.svelte";
  import ViolationsByPrinciple from "./components/ViolationsByPrinciple.svelte";
  import ComplianceScore from "./components/ComplianceScore.svelte";
  import BlastRadiusChart from "./components/BlastRadiusChart.svelte";
  import LayerChart from "./components/LayerChart.svelte";
  import SubsystemsPanel from "./components/SubsystemsPanel.svelte";
  import type { UnifiedPrOutput } from "./stores/pr-review";

  // ── Data loading ──────────────────────────────────────────────────────────

  const loader = useDataLoader(async () => {
    await bridge.init();
    return bridge.callTool("show_pr_impact") as Promise<UnifiedPrOutput>;
  });

  let status = $derived(loader.status);
  let data = $derived(loader.data);
  let errorMsg = $derived(loader.errorMsg);

  // ── Derived: prep-level ────────────────────────────────────────────────────

  let totalViolations = $derived(
    (data?.prep?.files ?? []).reduce((sum, f) => sum + (f.violations?.length ?? 0), 0)
  );

  let netNewFiles = $derived((() => {
    const files = data?.prep?.files ?? [];
    const added = files.filter(f => f.status === "added").length;
    const deleted = files.filter(f => f.status === "deleted").length;
    return added - deleted;
  })());

  let isStale = $derived((data?.prep?.graph_data_age_ms ?? 0) > 3_600_000);

  let hasReview = $derived(!!data?.has_review);

  // ── Derived: review-level (only meaningful when review exists) ─────────────

  let ruleViolationCount = $derived(
    (data?.review?.violations ?? []).filter(v => v.severity === "rule").length
  );

  let highestBlastRadius = $derived(
    (data?.blast_radius_by_file ?? []).length > 0
      ? data!.blast_radius_by_file[0]
      : null
  );

  let honoredPrinciples = $derived.by(() => {
    if (!data?.review) return [];
    // For now return empty — can be enhanced when full principle list is available
    return [] as string[];
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handlePrompt(text: string) {
    bridge.sendMessage(text);
  }

  function handleRunReview() {
    bridge.sendMessage("Run a Canon review on this PR");
  }
</script>

<div class="pr-review">
  {#if status === "loading"}
    <EmptyState message="Loading PR review data..." />

  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />

  {:else if data && data.prep.total_files === 0}
    <EmptyState message="No changed files found." />

  {:else if data}
    <!-- Verdict banner (review mode) or Run Review prompt (prep-only mode) -->
    {#if hasReview && data.review}
      <VerdictBanner
        verdict={data.review.verdict}
        fileCount={data.review.files.length}
        layerCount={data.prep.layers.length}
        violationCount={data.review.violations.length}
        {ruleViolationCount}
      />
    {:else}
      <!-- Run Review banner (prep-only mode) -->
      <div class="run-review-bar">
        <span class="run-review-label">No stored review yet.</span>
        <button class="run-review-btn" onclick={handleRunReview}>
          Run Review
        </button>
      </div>
    {/if}

    <!-- Header bar -->
    <div class="header-bar">
      <span class="header-title">PR Review</span>
      {#if data.prep.incremental && data.prep.last_reviewed_sha}
        <span class="badge-incremental">Incremental from {data.prep.last_reviewed_sha.slice(0, 7)}</span>
      {/if}
    </div>

    <!-- Section 1: Narrative Summary -->
    <NarrativeSummary
      narrative={data.prep.narrative}
      totalFiles={data.prep.total_files}
      layerCount={data.prep.layers.length}
      netNewFiles={netNewFiles}
      violationCount={totalViolations}
    />

    <!-- Section 2: Change Story Cards -->
    <ChangeStoryGrid files={data.prep.files} onPrompt={handlePrompt} />

    <!-- Staleness Warning -->
    {#if isStale}
      <div class="staleness-warning">
        Graph data is over 1 hour old. Re-index for accurate dependency information.
      </div>
    {/if}

    <!-- Section 3: Impact Tabs -->
    <ImpactTabs
      files={data.prep.files}
      blastRadius={data.prep.blast_radius}
      onPrompt={handlePrompt}
    />

    <!-- Dashboard panels (review mode only) -->
    {#if hasReview && data.review}
      <div class="dashboard-panels">
        <StatsRow
          filesChanged={data.review.files.length}
          violationCount={data.review.violations.length}
          ruleCount={ruleViolationCount}
          {highestBlastRadius}
        />

        <FixBeforeMerge violations={data.review.violations} />
        <ViolationsByPrinciple violations={data.review.violations} />
        <ComplianceScore score={data.review.score} {honoredPrinciples} />
        <BlastRadiusChart entries={data.blast_radius_by_file ?? []} />
        <LayerChart layers={data.prep.layers} />
        <SubsystemsPanel subsystems={data.subsystems ?? []} />
      </div>
    {/if}
  {/if}
</div>

<style>
  .pr-review {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Run Review banner ────────────────────────────────────────────────────── */

  .run-review-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: rgba(108, 140, 255, 0.06);
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .run-review-label {
    font-size: 12px;
    color: var(--text-muted, #636a80);
  }

  .run-review-btn {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--accent, #6c8cff);
    background: var(--accent-soft, rgba(108,140,255,0.12));
    color: var(--accent, #6c8cff);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }

  .run-review-btn:hover {
    background: var(--accent-glow, rgba(108,140,255,0.25));
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

  /* ── Dashboard panels ────────────────────────────────────────────────────── */

  .dashboard-panels {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    flex: 1;
    padding: 0 0 16px;
  }
</style>
