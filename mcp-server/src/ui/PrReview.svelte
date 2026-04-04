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

import { useDataLoader } from "./lib/useDataLoader.svelte";
import { bridge } from "./stores/bridge";
import type { UnifiedPrOutput } from "./stores/pr-review";

// ── Data loading ──────────────────────────────────────────────────────────

const loader = useDataLoader(async () => {
  await bridge.init();
  const result = (await bridge.waitForToolResult()) as UnifiedPrOutput;
  if (!result) throw new Error("No data received from tool");
  return result;
});

let _status = $derived(loader.status);
let data = $derived(loader.data);
let _errorMsg = $derived(loader.errorMsg);

// ── Derived: prep-level ────────────────────────────────────────────────────

let _totalViolations = $derived(data?.prep?.total_violations ?? 0);

let _netNewFiles = $derived(data?.prep?.net_new_files ?? 0);

let _isStale = $derived((data?.prep?.kg_freshness_ms ?? 0) > 3_600_000);

let _hasReview = $derived(!!data?.has_review);

// ── Derived: review-level (only meaningful when review exists) ─────────────

let _ruleViolationCount = $derived((data?.review?.violations ?? []).filter((v) => v.severity === "rule").length);

let _highestBlastRadius = $derived(
  (data?.blast_radius_by_file ?? []).length > 0 ? data!.blast_radius_by_file[0] : null,
);

let _honoredPrinciples = $derived(data?.review?.honored ?? []);

// ── Handlers ──────────────────────────────────────────────────────────────

function _handlePrompt(text: string) {
  bridge.sendMessage(text);
}

function _handleRunReview() {
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
    {#if hasReview && data.review}
      <!-- ── Review mode: VerdictBanner → StatsRow → 2-column grid dashboard ── -->
      <VerdictBanner
        verdict={data.review.verdict}
        fileCount={data.review.files.length}
        layerCount={data.prep.layers.length}
        violationCount={data.review.violations.length}
        {ruleViolationCount}
      />

      <StatsRow
        filesChanged={data.review.files.length}
        violationCount={data.review.violations.length}
        ruleCount={ruleViolationCount}
        {highestBlastRadius}
      />

      <div class="dashboard-grid">
        <!-- Row 1 left: FixBeforeMerge -->
        <div class="grid-card">
          <FixBeforeMerge violations={data.review.violations} recommendations={data.recommendations} onPrompt={handlePrompt} />
        </div>

        <!-- Row 1 right: ViolationsByPrinciple + ComplianceScore stacked -->
        <div class="grid-card grid-card--stack">
          <ViolationsByPrinciple violations={data.review.violations} onPrompt={handlePrompt} />
          <ComplianceScore score={data.review.score} {honoredPrinciples} />
        </div>

        <!-- Row 2 left: BlastRadiusChart -->
        <div class="grid-card">
          <BlastRadiusChart entries={data.blast_radius_by_file ?? []} onPrompt={handlePrompt} />
        </div>

        <!-- Row 2 right: LayerChart + SubsystemsPanel stacked -->
        <div class="grid-card grid-card--stack">
          <LayerChart layers={data.prep.layers} />
          <SubsystemsPanel subsystems={data.subsystems ?? []} />
        </div>
      </div>

    {:else}
      <!-- ── Prep-only mode: run-review banner + prep components ──────────── -->
      <div class="run-review-bar">
        <span class="run-review-label">No stored review yet.</span>
        <button class="run-review-btn" onclick={handleRunReview}>
          Run Review
        </button>
      </div>

      <div class="header-bar">
        <span class="header-title">PR Review</span>
        {#if data.prep.incremental && data.prep.last_reviewed_sha}
          <span class="badge-incremental">Incremental from {data.prep.last_reviewed_sha.slice(0, 7)}</span>
        {/if}
      </div>

      <NarrativeSummary
        narrative={data.prep.narrative}
        totalFiles={data.prep.total_files}
        layerCount={data.prep.layers.length}
        netNewFiles={netNewFiles}
        violationCount={totalViolations}
      />

      <ChangeStoryGrid files={data.prep.files} onPrompt={handlePrompt} />

      {#if isStale}
        <div class="staleness-warning">
          Graph data is over 1 hour old. Re-index for accurate dependency information.
        </div>
      {/if}

      <ImpactTabs
        files={data.prep.impact_files}
        blastRadius={data.prep.blast_radius}
        onPrompt={handlePrompt}
      />
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

  /* ── Dashboard grid (review mode) ───────────────────────────────────────── */

  .dashboard-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    overflow-y: auto;
    flex: 1;
    padding: 8px 12px 16px;
  }

  .grid-card {
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
    border-radius: 8px;
    overflow: hidden;
    min-width: 0;
  }

  .grid-card--stack {
    display: flex;
    flex-direction: column;
  }
</style>
