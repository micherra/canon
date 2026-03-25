<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import { getLayerColor, truncate } from "./lib/constants";

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
  let activeLayer = $state<string | null>(null);
  let collapsedBuckets = $state<Set<string>>(new Set(["low-risk"]));
  let expandedBlastRadius = $state<Set<string>>(new Set());

  // ── Derived state ─────────────────────────────────────────────────────────

  let filteredFiles = $derived(
    activeLayer ? (data?.files ?? []).filter(f => f.layer === activeLayer) : (data?.files ?? [])
  );

  let needsAttention = $derived(filteredFiles.filter(f => f.bucket === "needs-attention"));
  let worthALook = $derived(filteredFiles.filter(f => f.bucket === "worth-a-look"));
  let lowRisk = $derived(filteredFiles.filter(f => f.bucket === "low-risk"));

  // ── Event handlers ────────────────────────────────────────────────────────

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

  function toggleBucket(bucket: string) {
    const next = new Set(collapsedBuckets);
    if (next.has(bucket)) {
      next.delete(bucket);
    } else {
      next.add(bucket);
    }
    collapsedBuckets = next;
  }

  function toggleBlastRadius(filePath: string) {
    const next = new Set(expandedBlastRadius);
    if (next.has(filePath)) {
      next.delete(filePath);
    } else {
      next.add(filePath);
    }
    expandedBlastRadius = next;
  }

  function setActiveLayer(layer: string | null) {
    activeLayer = activeLayer === layer ? null : layer;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function statusIcon(fileStatus: PrFileInfo["status"]): string {
    switch (fileStatus) {
      case "added":    return "+";
      case "deleted":  return "−";
      case "renamed":  return "→";
      default:         return "~";
    }
  }

  function statusClass(fileStatus: PrFileInfo["status"]): string {
    switch (fileStatus) {
      case "added":    return "status-added";
      case "deleted":  return "status-deleted";
      case "renamed":  return "status-renamed";
      default:         return "status-modified";
    }
  }

  function shortPath(path: string): string {
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return "…/" + parts.slice(-2).join("/");
  }

  function formatAge(ms: number): string {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  // Get blast radius entry for a given file path (if any)
  function getBlastRadius(filePath: string): BlastRadiusEntry | undefined {
    return data?.blast_radius.find(br => br.file === filePath);
  }

  // Group affected files by depth for display
  function groupByDepth(affected: Array<{ path: string; depth: number }>): Map<number, string[]> {
    const map = new Map<number, string[]>();
    for (const { path, depth } of affected) {
      if (!map.has(depth)) map.set(depth, []);
      map.get(depth)!.push(path);
    }
    return map;
  }
</script>

<div class="pr-review-prep">
  {#if status === "loading"}
    <div class="empty-state">Loading PR review data...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if data && data.total_files === 0 && !data.error}
    <div class="empty-state">
      No changed files found. Run from a branch with changes.
    </div>

  {:else if data}
    <!-- ── Header bar ────────────────────────────────────────────────────── -->
    <div class="header-bar">
      <span class="header-title">PR Review Prep</span>
      <span class="sep">&middot;</span>
      <span class="header-stat">{data.total_files} file{data.total_files === 1 ? "" : "s"}</span>
      <span class="sep">&middot;</span>
      <span class="header-stat">{data.layers.length} layer{data.layers.length === 1 ? "" : "s"}</span>

      {#if data.incremental && data.last_reviewed_sha}
        <span class="sep">&middot;</span>
        <span class="badge badge-incremental">Incremental from {data.last_reviewed_sha.slice(0, 7)}</span>
      {/if}

      {#if data.graph_data_age_ms !== undefined}
        <span class="sep">&middot;</span>
        <span class="header-muted">graph {formatAge(data.graph_data_age_ms)}</span>
      {/if}

      {#if data.error}
        <span class="sep">&middot;</span>
        <span class="warning-inline" title={data.error}>⚠ {truncate(data.error, 60)}</span>
      {/if}
    </div>

    <!-- ── Narrative banner ──────────────────────────────────────────────── -->
    {#if data.narrative}
      <div class="narrative-banner">
        <p class="narrative-text">{data.narrative}</p>
      </div>
    {/if}

    <!-- ── Layer navigation tabs ─────────────────────────────────────────── -->
    {#if data.layers.length > 0}
      <div class="layer-tabs">
        <button
          class="layer-tab"
          class:active={activeLayer === null}
          onclick={() => setActiveLayer(null)}
        >
          All
          <span class="tab-count">{data.total_files}</span>
        </button>
        {#each data.layers as layer (layer.name)}
          <button
            class="layer-tab"
            class:active={activeLayer === layer.name}
            onclick={() => setActiveLayer(layer.name)}
          >
            <span class="layer-dot" style="background: {getLayerColor(layer.name)}"></span>
            {layer.name}
            <span class="tab-count">{layer.file_count}</span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="content-area">
      <!-- ── Needs Attention bucket ────────────────────────────────────── -->
      {#if needsAttention.length > 0}
        <div class="bucket-section">
          <button class="panel-header" onclick={() => toggleBucket("needs-attention")}>
            <span class="bucket-accent danger"></span>
            <span class="panel-title danger-title">Needs attention</span>
            <span class="count-badge danger-badge">{needsAttention.length}</span>
            <span class="panel-toggle">{collapsedBuckets.has("needs-attention") ? "▸" : "▾"}</span>
          </button>

          {#if !collapsedBuckets.has("needs-attention")}
            <div class="file-rows">
              {#each needsAttention as file (file.path)}
                {@const blastEntry = getBlastRadius(file.path)}
                <div class="file-row">
                  <span class="status-icon {statusClass(file.status)}" title={file.status}>
                    {statusIcon(file.status)}
                  </span>
                  <span class="file-mono" title={file.path}>{shortPath(file.path)}</span>
                  <span
                    class="layer-chip"
                    style="--chip-color: {getLayerColor(file.layer)}"
                  >{file.layer}</span>
                  <span class="reason-text">{file.reason}</span>
                </div>
                {#if blastEntry && blastEntry.affected.length > 0}
                  <div class="blast-radius-panel">
                    <button
                      class="blast-radius-header"
                      onclick={() => toggleBlastRadius(file.path)}
                    >
                      <span class="blast-file">{shortPath(blastEntry.file)}</span>
                      <span class="blast-affects">affects {blastEntry.affected.length} file{blastEntry.affected.length === 1 ? "" : "s"}</span>
                      <span class="panel-toggle">{expandedBlastRadius.has(file.path) ? "▾" : "▸"}</span>
                    </button>
                    {#if expandedBlastRadius.has(file.path)}
                      <div class="blast-body">
                        {#each [...groupByDepth(blastEntry.affected)] as [depth, paths] (depth)}
                          <div class="blast-depth-group">
                            <span class="blast-depth-label">
                              {depth === 1 ? "Direct dependents:" : `Transitive (depth ${depth}):`}
                            </span>
                            {#each paths as affectedPath (affectedPath)}
                              <div class="blast-path" style="padding-left: {depth * 16}px">
                                {shortPath(affectedPath)}
                              </div>
                            {/each}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Worth a Look bucket ───────────────────────────────────────── -->
      {#if worthALook.length > 0}
        <div class="bucket-section">
          <button class="panel-header" onclick={() => toggleBucket("worth-a-look")}>
            <span class="bucket-accent warning"></span>
            <span class="panel-title warning-title">Worth a look</span>
            <span class="count-badge warning-badge">{worthALook.length}</span>
            <span class="panel-toggle">{collapsedBuckets.has("worth-a-look") ? "▸" : "▾"}</span>
          </button>

          {#if !collapsedBuckets.has("worth-a-look")}
            <div class="file-rows">
              {#each worthALook as file (file.path)}
                <div class="file-row">
                  <span class="status-icon {statusClass(file.status)}" title={file.status}>
                    {statusIcon(file.status)}
                  </span>
                  <span class="file-mono" title={file.path}>{shortPath(file.path)}</span>
                  <span
                    class="layer-chip"
                    style="--chip-color: {getLayerColor(file.layer)}"
                  >{file.layer}</span>
                  <span class="reason-text">{file.reason}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Low Risk bucket ───────────────────────────────────────────── -->
      {#if lowRisk.length > 0}
        <div class="bucket-section">
          <button class="panel-header" onclick={() => toggleBucket("low-risk")}>
            <span class="bucket-accent muted"></span>
            <span class="panel-title">Low risk</span>
            <span class="count-badge muted-badge">{lowRisk.length}</span>
            <span class="panel-toggle">{collapsedBuckets.has("low-risk") ? "▸" : "▾"}</span>
          </button>

          {#if !collapsedBuckets.has("low-risk")}
            <div class="file-rows">
              {#each lowRisk as file (file.path)}
                <div class="file-row">
                  <span class="status-icon {statusClass(file.status)}" title={file.status}>
                    {statusIcon(file.status)}
                  </span>
                  <span class="file-mono" title={file.path}>{shortPath(file.path)}</span>
                  <span
                    class="layer-chip"
                    style="--chip-color: {getLayerColor(file.layer)}"
                  >{file.layer}</span>
                  <span class="reason-text">{file.reason}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Standalone blast radius panels (files not in needs-attention) ── -->
      {#if data.blast_radius.length > 0}
        {@const standaloneBlast = data.blast_radius.filter(
          br => !needsAttention.some(f => f.path === br.file)
        )}
        {#each standaloneBlast as blastEntry (blastEntry.file)}
          {#if blastEntry.affected.length > 0}
            <div class="blast-standalone">
              <button
                class="blast-radius-header"
                onclick={() => toggleBlastRadius(blastEntry.file)}
              >
                <span class="blast-file">{shortPath(blastEntry.file)}</span>
                <span class="blast-affects">affects {blastEntry.affected.length} file{blastEntry.affected.length === 1 ? "" : "s"}</span>
                <span class="panel-toggle">{expandedBlastRadius.has(blastEntry.file) ? "▾" : "▸"}</span>
              </button>
              {#if expandedBlastRadius.has(blastEntry.file)}
                <div class="blast-body">
                  {#each [...groupByDepth(blastEntry.affected)] as [depth, paths] (depth)}
                    <div class="blast-depth-group">
                      <span class="blast-depth-label">
                        {depth === 1 ? "Direct dependents:" : `Transitive (depth ${depth}):`}
                      </span>
                      {#each paths as affectedPath (affectedPath)}
                        <div class="blast-path" style="padding-left: {depth * 16}px">
                          {shortPath(affectedPath)}
                        </div>
                      {/each}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
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

  .sep { opacity: 0.4; }

  .header-stat {
    color: var(--text, #b4b8c8);
  }

  .header-muted {
    color: var(--text-muted, #636a80);
    font-size: 11px;
  }

  .badge-incremental {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent-soft, rgba(108,140,255,0.12));
    color: var(--accent, #6c8cff);
  }

  .warning-inline {
    font-size: 11px;
    color: var(--warning, #fbbf24);
  }

  /* ── Narrative banner ────────────────────────────────────────────────────── */

  .narrative-banner {
    padding: 10px 12px;
    background: var(--bg-surface, rgba(255,255,255,0.04));
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .narrative-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-bright, #e8eaf0);
    margin: 0;
  }

  /* ── Layer tabs ──────────────────────────────────────────────────────────── */

  .layer-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    overflow-x: auto;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
    flex-wrap: nowrap;
  }

  .layer-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    color: var(--text-muted, #636a80);
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
    border-radius: 2px 2px 0 0;
  }

  .layer-tab:hover {
    color: var(--text, #b4b8c8);
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .layer-tab.active {
    color: var(--accent, #6c8cff);
    border-bottom-color: var(--accent, #6c8cff);
  }

  .tab-count {
    font-size: 10px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
  }

  .layer-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ── Content area ────────────────────────────────────────────────────────── */

  .content-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    min-height: 0;
  }

  /* ── Bucket sections ─────────────────────────────────────────────────────── */

  .bucket-section {
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
    border-radius: 0;
    transition: background 0.15s;
  }

  .panel-header:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
  }

  .bucket-accent {
    width: 3px;
    height: 14px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .bucket-accent.danger { background: var(--danger, #ff6b6b); }
  .bucket-accent.warning { background: var(--warning, #fbbf24); }
  .bucket-accent.muted { background: var(--text-muted, #636a80); }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex: 1;
  }

  .danger-title { color: var(--danger, #ff6b6b); }
  .warning-title { color: var(--warning, #fbbf24); }

  .panel-toggle {
    color: var(--text-muted, #636a80);
    font-size: 10px;
    opacity: 0.6;
  }

  .count-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .danger-badge {
    background: rgba(255, 107, 107, 0.15);
    color: var(--danger, #ff6b6b);
  }

  .warning-badge {
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
  }

  .muted-badge {
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
  }

  /* ── File rows ───────────────────────────────────────────────────────────── */

  .file-rows {
    display: flex;
    flex-direction: column;
    padding: 2px 12px 6px 12px;
    gap: 2px;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 20px;
    border-radius: 3px;
    padding: 1px 4px;
    transition: background 0.12s;
  }

  .file-row:hover {
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .status-icon {
    font-family: monospace;
    font-size: 12px;
    font-weight: 600;
    width: 12px;
    text-align: center;
    flex-shrink: 0;
  }

  .status-added    { color: var(--success, #34d399); }
  .status-modified { color: var(--warning, #fbbf24); }
  .status-deleted  { color: var(--danger, #ff6b6b); }
  .status-renamed  { color: var(--accent, #6c8cff); }

  .file-mono {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .layer-chip {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--chip-color, #6b7394);
    color: var(--chip-color, #6b7394);
    flex-shrink: 0;
  }

  .reason-text {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    margin-left: auto;
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  /* ── Blast radius panels ─────────────────────────────────────────────────── */

  .blast-radius-panel {
    margin: 2px 12px 4px 28px;
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    border-radius: 4px;
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .blast-standalone {
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
  }

  .blast-radius-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 10px;
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
    color: inherit;
    text-align: left;
    transition: background 0.15s;
    border-radius: 4px;
  }

  .blast-radius-header:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
  }

  .blast-file {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .blast-affects {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
  }

  .blast-body {
    padding: 4px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .blast-depth-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .blast-depth-label {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    font-weight: 600;
    padding-top: 2px;
  }

  .blast-path {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
