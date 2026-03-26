<script lang="ts">
  /**
   * PrReview.svelte
   *
   * Unified progressive PR Review container.
   *
   * Two-mode layout:
   *   - prep-only mode (has_review === false): single-column view — NarrativeSummary,
   *     ChangeStoryGrid, ImpactTabs, plus a "Run Review" banner.
   *   - review mode (has_review === true): VerdictStrip at top, then prep columns,
   *     then three-panel impact view: HotspotList | SubGraph | PrDetailPanel.
   *
   * Canon principles:
   *   - compose-from-small-to-large: pure composition container; no new leaf components
   *   - deep-modules: minimal interface — no props; all state internal
   *   - functions-do-one-thing: each handler does one thing only
   */

  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import NarrativeSummary from "./components/NarrativeSummary.svelte";
  import ChangeStoryGrid from "./components/ChangeStoryGrid.svelte";
  import ImpactTabs from "./components/ImpactTabs.svelte";
  import VerdictStrip from "./components/VerdictStrip.svelte";
  import HotspotList from "./components/HotspotList.svelte";
  import SubGraph from "./components/SubGraph.svelte";
  import PrDetailPanel from "./components/PrDetailPanel.svelte";
  import type { UnifiedPrOutput } from "./stores/pr-review";

  // ── State ─────────────────────────────────────────────────────────────────

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<UnifiedPrOutput | null>(null);
  let errorMsg = $state("");
  let selectedFile = $state<string | null>(null);

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

  // ── Derived: impact-level (only meaningful when review exists) ──────────────

  let seedNodeIds = $derived(new Set<string>(data?.review?.files ?? []));

  let subgraphLayerColors = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const layer of data?.subgraph?.layers ?? []) {
      if (layer?.name && layer?.color) map[layer.name] = layer.color;
    }
    return map;
  });

  let selectedFileViolations = $derived(
    (data?.review?.violations ?? []).filter(
      (v: { file_path?: string }) => v.file_path === selectedFile
    )
  );

  let selectedFileBlastRadius = $derived(
    (data?.blastRadius?.affected ?? []).filter(
      (a: { depth: number; file_path: string }) => a.depth > 0 && a.file_path === selectedFile
    )
  );

  let selectedFileDecisions = $derived.by(() => {
    const violatedPrinciples = new Set(
      selectedFileViolations.map((v: { principle_id: string }) => v.principle_id)
    );
    return (data?.decisions ?? []).filter((d: { principle_id: string }) =>
      violatedPrinciples.has(d.principle_id)
    );
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await bridge.init();
      data = await bridge.callTool("show_pr_impact") as UnifiedPrOutput;
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load PR data";
    }
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handlePrompt(text: string) {
    bridge.sendMessage(text);
  }

  function handleFileSelect(file: string) {
    selectedFile = file;
  }

  function handleGraphNodeClick(node: { id: string }) {
    selectedFile = node.id;
  }

  function handleGraphBackgroundClick() {
    // no-op — deselect on background click not needed
  }

  function handleRunReview() {
    bridge.sendMessage("Run a Canon review on this PR");
  }
</script>

<div class="pr-review">
  {#if status === "loading"}
    <div class="empty-state">Loading PR review data...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if data && data.prep.total_files === 0}
    <div class="empty-state">No changed files found.</div>

  {:else if data}
    <!-- Verdict strip (review mode only) -->
    {#if hasReview && data.review}
      <VerdictStrip
        verdict={data.review.verdict}
        fileCount={data.review.files.length}
        blastRadiusTotal={data.blastRadius?.total_affected ?? 0}
        violationCount={data.review.violations.length}
        score={data.review.score}
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

    <!-- Review Impact section (review mode only) -->
    {#if hasReview}
      <div class="review-impact-section">
        <div class="section-header">Review Impact</div>
        <div class="panels">
          <!-- Left panel: HotspotList — risk-ranked changed files -->
          <div class="panel-left">
            <HotspotList
              hotspots={data.hotspots}
              {selectedFile}
              onFileSelect={handleFileSelect}
            />
          </div>

          <!-- Center panel: SubGraph — changed files + dependency neighborhood -->
          <div class="panel-center">
            {#if data.subgraph?.nodes?.length > 0}
              <SubGraph
                nodes={data.subgraph.nodes}
                edges={data.subgraph.edges}
                {seedNodeIds}
                layerColors={subgraphLayerColors}
                onNodeClick={handleGraphNodeClick}
                onBackgroundClick={handleGraphBackgroundClick}
                fa2Iterations={60}
              />
            {:else}
              <div class="empty-state">
                {#if !data.blastRadius}
                  No knowledge graph available for subgraph visualization.
                {:else}
                  No graph data to display.
                {/if}
              </div>
            {/if}
          </div>

          <!-- Right panel: PrDetailPanel — per-file violations, blast radius, decisions -->
          <div class="panel-right">
            {#if selectedFile}
              <PrDetailPanel
                file={selectedFile}
                violations={selectedFileViolations}
                blastRadiusAffected={selectedFileBlastRadius}
                decisions={selectedFileDecisions}
                onFileClick={handleFileSelect}
              />
            {:else}
              <div class="empty-state">Select a file to see details</div>
            {/if}
          </div>
        </div>
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
    height: 100%;
    min-height: 600px;
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

  /* ── Review Impact section ───────────────────────────────────────────────── */

  .review-impact-section {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    min-height: 300px;
    border-top: 1px solid var(--border, rgba(255,255,255,0.06));
    margin-top: 4px;
  }

  .section-header {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .panels {
    flex: 1;
    display: flex;
    overflow: hidden;
    gap: 1px;
    background: var(--border, #333);
  }

  .panel-left {
    width: 220px;
    min-width: 180px;
    overflow-y: auto;
    background: var(--bg, #1a1a1a);
    flex-shrink: 0;
  }

  .panel-center {
    flex: 1;
    overflow: hidden;
    background: var(--bg, #1a1a1a);
    min-width: 0;
  }

  .panel-right {
    width: 280px;
    min-width: 220px;
    overflow-y: auto;
    background: var(--bg, #1a1a1a);
    flex-shrink: 0;
  }

  /* ── Empty states ────────────────────────────────────────────────────────── */

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 100%;
    color: var(--text-muted, #888);
    font-size: 13px;
    padding: 32px;
    text-align: center;
  }

  .error { color: var(--danger, #e05252); }
</style>
