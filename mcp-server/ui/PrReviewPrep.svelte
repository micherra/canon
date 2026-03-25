<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import { getLayerColor, truncate } from "./lib/constants";

  // ── Types ─────────────────────────────────────────────────────────────────

  interface PrFileInfo {
    path: string;
    layer: string;
    status: "added" | "modified" | "deleted" | "renamed";
    priority_score?: number;
    priority_factors?: {
      in_degree: number;
      violation_count: number;
      is_changed: boolean;
      layer: string;
      layer_centrality: number;
    };
  }

  interface PrReviewData {
    files: PrFileInfo[];
    layers: Array<{ name: string; file_count: number }>;
    total_files: number;
    incremental: boolean;
    last_reviewed_sha?: string;
    diff_command: string;
    prioritized_files?: Array<{ path: string; priority_score: number; factors: any }>;
    graph_data_age_ms?: number;
    error?: string;
  }

  // ── Constants ─────────────────────────────────────────────────────────────

  const HIGH_PRIORITY_THRESHOLD = 10;
  const MEDIUM_PRIORITY_THRESHOLD = 5;
  const MAX_REVIEW_ORDER = 8;

  // ── State ─────────────────────────────────────────────────────────────────

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<PrReviewData | null>(null);
  let errorMsg = $state("");
  let collapsedLayers = $state<Set<string>>(new Set());
  let sortBy = $state<"priority" | "path">("priority");
  let strategyExpanded = $state(true);

  // ── Derived state ─────────────────────────────────────────────────────────

  let filesGroupedByLayer = $derived.by(() => {
    const map = new Map<string, PrFileInfo[]>();
    if (!data) return map;

    for (const file of data.files) {
      if (!map.has(file.layer)) map.set(file.layer, []);
      map.get(file.layer)!.push(file);
    }

    // Sort files within each layer
    for (const [layer, files] of map) {
      if (sortBy === "priority") {
        files.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
      } else {
        files.sort((a, b) => a.path.localeCompare(b.path));
      }
      map.set(layer, files);
    }

    return map;
  });

  // Layers sorted by file count descending
  let sortedLayers = $derived.by(() => {
    if (!data) return [];
    return [...(data.layers ?? [])].sort((a, b) => b.file_count - a.file_count);
  });

  let riskFiles = $derived(
    (data?.files ?? []).filter(
      (f) =>
        (f.priority_factors?.violation_count ?? 0) > 0 ||
        (f.priority_score ?? 0) >= HIGH_PRIORITY_THRESHOLD,
    ),
  );

  let reviewOrder = $derived.by(() => {
    if (!data) return [];
    return [...data.files]
      .filter((f) => (f.priority_score ?? 0) > 0)
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
      .slice(0, MAX_REVIEW_ORDER);
  });

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

  function toggleLayer(layerName: string) {
    const next = new Set(collapsedLayers);
    if (next.has(layerName)) {
      next.delete(layerName);
    } else {
      next.add(layerName);
    }
    collapsedLayers = next;
  }

  function toggleSort() {
    sortBy = sortBy === "priority" ? "path" : "priority";
  }

  function toggleStrategy() {
    strategyExpanded = !strategyExpanded;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function priorityClass(score: number | undefined): string {
    if (score === undefined) return "priority-none";
    if (score >= HIGH_PRIORITY_THRESHOLD) return "priority-high";
    if (score >= MEDIUM_PRIORITY_THRESHOLD) return "priority-medium";
    return "priority-low";
  }

  function statusIcon(status: PrFileInfo["status"]): string {
    switch (status) {
      case "added":    return "+";
      case "deleted":  return "−";
      case "renamed":  return "→";
      default:         return "~";
    }
  }

  function statusClass(status: PrFileInfo["status"]): string {
    switch (status) {
      case "added":    return "status-added";
      case "deleted":  return "status-deleted";
      case "renamed":  return "status-renamed";
      default:         return "status-modified";
    }
  }

  function shortPath(path: string): string {
    // Show the last 2 segments for readability
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return "…/" + parts.slice(-2).join("/");
  }

  function rationale(file: PrFileInfo): string {
    const parts: string[] = [];
    const inDeg = file.priority_factors?.in_degree ?? 0;
    const viol = file.priority_factors?.violation_count ?? 0;
    if (inDeg > 0) parts.push(`${inDeg} importer${inDeg === 1 ? "" : "s"}`);
    if (viol > 0) parts.push(`${viol} violation${viol === 1 ? "" : "s"}`);
    if (parts.length === 0 && (file.priority_score ?? 0) > 0) return "High priority";
    return parts.join(" · ");
  }

  function formatAge(ms: number): string {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
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

    <div class="content-area">
      <!-- ── Review Strategy panel ───────────────────────────────────────── -->
      {#if reviewOrder.length > 0}
        <div class="panel strategy-panel" style="animation: fadeIn 0.2s ease">
          <button class="panel-header" onclick={toggleStrategy}>
            <span class="panel-title">Review Strategy</span>
            <span class="panel-toggle">{strategyExpanded ? "▾" : "▸"}</span>
          </button>

          {#if strategyExpanded}
            <div class="strategy-list">
              {#each reviewOrder as file, i}
                <div class="strategy-row">
                  <span class="strategy-rank">{i + 1}</span>
                  <span class="file-path" title={file.path}>{shortPath(file.path)}</span>
                  <div class="badges">
                    {#if file.priority_score !== undefined}
                      <span class="priority-badge {priorityClass(file.priority_score)}">
                        {file.priority_score.toFixed(1)}
                      </span>
                    {/if}
                    <span
                      class="layer-chip"
                      style="--chip-color: {getLayerColor(file.layer)}"
                    >{file.layer}</span>
                  </div>
                  {#if rationale(file)}
                    <span class="rationale">{rationale(file)}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Risk Areas panel ────────────────────────────────────────────── -->
      {#if riskFiles.length > 0}
        <div class="panel risk-panel" style="animation: fadeIn 0.2s ease">
          <div class="panel-header-static">
            <span class="panel-title risk-title">Risk Areas</span>
            <span class="count-badge">{riskFiles.length}</span>
          </div>
          <div class="risk-list">
            {#each riskFiles as file}
              <div class="risk-row">
                <span class="file-path" title={file.path}>{shortPath(file.path)}</span>
                <div class="badges">
                  {#if (file.priority_factors?.violation_count ?? 0) > 0}
                    <span class="violation-badge">
                      {file.priority_factors!.violation_count} violation{file.priority_factors!.violation_count === 1 ? "" : "s"}
                    </span>
                  {/if}
                  {#if (file.priority_factors?.in_degree ?? 0) > 0}
                    <span class="indegree-badge">
                      ↙ {file.priority_factors!.in_degree}
                    </span>
                  {/if}
                  {#if file.priority_score !== undefined}
                    <span class="priority-badge {priorityClass(file.priority_score)}">
                      {file.priority_score.toFixed(1)}
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- ── File list by layer ──────────────────────────────────────────── -->
      <div class="file-list-section" style="animation: fadeIn 0.2s ease">
        <div class="file-list-header">
          <span class="section-title">Files by Layer</span>
          <button class="sort-toggle" onclick={toggleSort}>
            Sort: <span class="sort-active">{sortBy}</span>
          </button>
        </div>

        {#if data.files.length === 0}
          <div class="empty-files">No files matched the diff.</div>
        {:else}
          <div class="layer-groups">
            {#each sortedLayers as layer (layer.name)}
              {@const layerFiles = filesGroupedByLayer.get(layer.name) ?? []}
              {@const isCollapsed = collapsedLayers.has(layer.name)}
              {@const layerColor = getLayerColor(layer.name)}

              <div class="layer-group">
                <button
                  class="layer-header"
                  onclick={() => toggleLayer(layer.name)}
                  title="{isCollapsed ? 'Expand' : 'Collapse'} {layer.name}"
                >
                  <span class="layer-dot" style="background: {layerColor}"></span>
                  <span class="layer-name">{layer.name}</span>
                  <span class="layer-count">{layer.file_count}</span>
                  <span class="layer-chevron">{isCollapsed ? "▸" : "▾"}</span>
                </button>

                {#if !isCollapsed}
                  <div class="file-rows">
                    {#each layerFiles as file (file.path)}
                      <div class="file-row">
                        <span class="status-icon {statusClass(file.status)}" title={file.status}>
                          {statusIcon(file.status)}
                        </span>
                        <span class="file-mono" title={file.path}>{shortPath(file.path)}</span>
                        <div class="file-badges">
                          {#if file.priority_score !== undefined}
                            <span class="priority-badge {priorityClass(file.priority_score)}">
                              {file.priority_score.toFixed(1)}
                            </span>
                          {/if}
                          {#if (file.priority_factors?.in_degree ?? 0) > 0}
                            <span class="indegree-small" title="Imported by {file.priority_factors!.in_degree} files">
                              ↙{file.priority_factors!.in_degree}
                            </span>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
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

  /* ── Content area ────────────────────────────────────────────────────────── */

  .content-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    min-height: 0;
  }

  /* ── Panels (Strategy, Risk) ─────────────────────────────────────────────── */

  .panel {
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

  .panel-header-static {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex: 1;
  }

  .risk-title {
    color: var(--danger, #ff6b6b);
  }

  .panel-toggle {
    color: var(--text-muted, #636a80);
    font-size: 10px;
    opacity: 0.6;
  }

  .count-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(255, 107, 107, 0.15);
    color: var(--danger, #ff6b6b);
  }

  /* ── Strategy list ───────────────────────────────────────────────────────── */

  .strategy-list {
    display: flex;
    flex-direction: column;
    padding: 0 12px 10px;
    gap: 5px;
  }

  .strategy-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
  }

  .strategy-rank {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    width: 14px;
    text-align: right;
    flex-shrink: 0;
  }

  .rationale {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    margin-left: auto;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* ── Risk list ───────────────────────────────────────────────────────────── */

  .risk-list {
    display: flex;
    flex-direction: column;
    padding: 0 12px 10px;
    gap: 4px;
  }

  .risk-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
  }

  .violation-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(255, 107, 107, 0.12);
    color: var(--danger, #ff6b6b);
    flex-shrink: 0;
  }

  .indegree-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
  }

  /* ── File list section ───────────────────────────────────────────────────── */

  .file-list-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .file-list-header {
    display: flex;
    align-items: center;
    padding: 8px 12px 6px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex: 1;
  }

  .sort-toggle {
    background: none;
    border: none;
    font: inherit;
    font-size: 11px;
    color: var(--text-muted, #636a80);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    transition: background 0.15s, color 0.15s;
  }

  .sort-toggle:hover {
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text, #b4b8c8);
  }

  .sort-active {
    color: var(--accent, #6c8cff);
  }

  /* ── Layer groups ────────────────────────────────────────────────────────── */

  .layer-groups {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .layer-group {
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
  }

  .layer-header {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
    transition: background 0.15s;
  }

  .layer-header:hover {
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .layer-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .layer-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text, #b4b8c8);
    flex: 1;
  }

  .layer-count {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    background: var(--bg-card, rgba(255,255,255,0.06));
    padding: 1px 5px;
    border-radius: 3px;
  }

  .layer-chevron {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    opacity: 0.6;
    width: 10px;
    text-align: center;
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

  .file-badges {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .indegree-small {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    font-family: monospace;
  }

  /* ── Shared: badges & chips ─────────────────────────────────────────────── */

  .badges {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .file-path {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .priority-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: monospace;
    flex-shrink: 0;
  }

  .priority-high {
    background: rgba(255, 107, 107, 0.15);
    color: var(--danger, #ff6b6b);
  }

  .priority-medium {
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
  }

  .priority-low {
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
  }

  .priority-none {
    display: none;
  }

  .layer-chip {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--chip-color, #6b7394);
    color: var(--chip-color, #6b7394);
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

  .empty-files {
    padding: 16px 12px;
    font-size: 12px;
    color: var(--text-muted, #636a80);
  }

  .error { color: var(--danger, #e05252); }
</style>
