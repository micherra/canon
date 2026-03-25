<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import { getLayerColor, VERDICT_COLORS } from "./lib/constants";

  // ── Types ─────────────────────────────────────────────────────────────────

  interface FileGraphMetrics {
    in_degree: number;
    out_degree: number;
    is_hub: boolean;
    in_cycle: boolean;
    cycle_peers: string[];
    layer_violation_count: number;
    impact_score: number;
  }

  interface FileEntitySummary {
    name: string;
    kind: string;
    is_exported: boolean;
    line_start: number;
    line_end: number;
  }

  interface FileBlastRadiusEntry {
    name: string;
    qualified_name: string;
    kind: string;
    depth: number;
  }

  interface FileContextOutput {
    file_path: string;
    layer: string;
    content: string;
    imports: string[];
    imported_by: string[];
    exports: string[];
    violation_count: number;
    last_verdict: string | null;
    graph_metrics?: FileGraphMetrics;
    entities?: FileEntitySummary[];
    blast_radius?: FileBlastRadiusEntry[];
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<FileContextOutput | null>(null);
  let errorMsg = $state("");

  // Collapsible panel state
  let entitiesExpanded = $state(true);
  let blastRadiusExpanded = $state(true);
  let importsExpanded = $state(true);
  let importedByExpanded = $state(true);

  // ── Derived state ─────────────────────────────────────────────────────────

  let blastRadiusByDepth = $derived.by(() => {
    if (!data?.blast_radius?.length) return new Map<number, FileBlastRadiusEntry[]>();
    const map = new Map<number, FileBlastRadiusEntry[]>();
    for (const entry of data.blast_radius) {
      if (!map.has(entry.depth)) map.set(entry.depth, []);
      map.get(entry.depth)!.push(entry);
    }
    return map;
  });

  let sortedDepths = $derived(
    [...blastRadiusByDepth.keys()].sort((a, b) => a - b),
  );

  let verdictColor = $derived(
    data?.last_verdict ? (VERDICT_COLORS[data.last_verdict] ?? "#636a80") : "#636a80",
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await bridge.init();
      // The host delivers the tool result via ontoolresult after connection
      data = await bridge.waitForToolResult();
      if (!data) throw new Error("No data received from tool");
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load file context";
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function shortPath(path: string): string {
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return ".../" + parts.slice(-2).join("/");
  }

  function entityKindIcon(kind: string): string {
    switch (kind) {
      case "function":   return "fn";
      case "class":      return "cls";
      case "interface":  return "if";
      case "type":       return "typ";
      case "variable":   return "var";
      case "constant":   return "cst";
      case "enum":       return "enum";
      default:           return kind.slice(0, 3);
    }
  }

  function entityKindClass(kind: string): string {
    switch (kind) {
      case "function":   return "kind-fn";
      case "class":      return "kind-cls";
      case "interface":  return "kind-if";
      case "type":       return "kind-typ";
      default:           return "kind-other";
    }
  }

  function impactBarWidth(score: number): string {
    // Clamp to 0-100%
    const pct = Math.min(100, Math.max(0, score));
    return `${pct}%`;
  }

  function impactBarColor(score: number): string {
    if (score >= 75) return "var(--danger, #ff6b6b)";
    if (score >= 40) return "var(--warning, #fbbf24)";
    return "var(--accent, #6c8cff)";
  }
</script>

<div class="file-context">
  {#if status === "loading"}
    <div class="empty-state">Loading file context...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if data}
    <!-- ── Header bar ───────────────────────────────────────────────────── -->
    <div class="header-bar">
      <span class="file-path-header" title={data.file_path}>{data.file_path}</span>
      <span
        class="layer-chip"
        style="--chip-color: {getLayerColor(data.layer)}"
      >{data.layer}</span>

      {#if data.violation_count > 0}
        <span class="violation-badge">
          {data.violation_count} violation{data.violation_count === 1 ? "" : "s"}
        </span>
      {/if}

      {#if data.last_verdict}
        <span class="verdict-badge" style="--verdict-color: {verdictColor}">
          {data.last_verdict}
        </span>
      {/if}
    </div>

    <div class="content-area">

      <!-- ── Graph Metrics panel ──────────────────────────────────────── -->
      {#if data.graph_metrics}
        {@const m = data.graph_metrics}
        <div class="panel metrics-panel">
          <div class="panel-header-static">
            <span class="panel-title">Graph Metrics</span>
          </div>
          <div class="metrics-grid">
            <div class="metric-row">
              <span class="metric-label">Imported by</span>
              <span class="metric-value">{m.in_degree}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Imports</span>
              <span class="metric-value">{m.out_degree}</span>
            </div>
            {#if m.is_hub}
              <div class="metric-row">
                <span class="metric-label">Role</span>
                <span class="badge-hub">Hub</span>
              </div>
            {/if}
            {#if m.layer_violation_count > 0}
              <div class="metric-row">
                <span class="metric-label">Layer violations</span>
                <span class="metric-warn">{m.layer_violation_count}</span>
              </div>
            {/if}
            {#if m.in_cycle}
              <div class="metric-row">
                <span class="metric-label">Cycle</span>
                <span class="badge-cycle">In cycle ({m.cycle_peers.length} peer{m.cycle_peers.length === 1 ? "" : "s"})</span>
              </div>
              {#if m.cycle_peers.length > 0}
                <div class="cycle-peers">
                  {#each m.cycle_peers as peer}
                    <span class="peer-path" title={peer}>{shortPath(peer)}</span>
                  {/each}
                </div>
              {/if}
            {/if}
            <div class="metric-row impact-row">
              <span class="metric-label">Impact score</span>
              <div class="impact-bar-wrap">
                <div
                  class="impact-bar"
                  style="width: {impactBarWidth(m.impact_score)}; background: {impactBarColor(m.impact_score)}"
                ></div>
              </div>
              <span class="metric-value">{m.impact_score.toFixed(0)}</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- ── Entities list ────────────────────────────────────────────── -->
      {#if data.entities && data.entities.length > 0}
        <div class="panel">
          <button
            class="panel-header"
            onclick={() => (entitiesExpanded = !entitiesExpanded)}
          >
            <span class="panel-title">Entities</span>
            <span class="count-badge">{data.entities.length}</span>
            <span class="panel-toggle">{entitiesExpanded ? "▾" : "▸"}</span>
          </button>

          {#if entitiesExpanded}
            <div class="entity-list">
              {#each data.entities as entity}
                <div class="entity-row">
                  <span class="kind-chip {entityKindClass(entity.kind)}">{entityKindIcon(entity.kind)}</span>
                  <span class="entity-name" title="{entity.name} ({entity.kind})">{entity.name}</span>
                  {#if entity.is_exported}
                    <span class="export-badge">export</span>
                  {/if}
                  <span class="line-range">L{entity.line_start}–{entity.line_end}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Blast Radius ─────────────────────────────────────────────── -->
      {#if data.blast_radius !== undefined}
        <div class="panel">
          <button
            class="panel-header"
            onclick={() => (blastRadiusExpanded = !blastRadiusExpanded)}
          >
            <span class="panel-title">Blast Radius</span>
            <span class="count-badge">{data.blast_radius.length}</span>
            <span class="panel-toggle">{blastRadiusExpanded ? "▾" : "▸"}</span>
          </button>

          {#if blastRadiusExpanded}
            {#if data.blast_radius.length === 0}
              <div class="empty-panel">No downstream dependents found.</div>
            {:else}
              <div class="blast-list">
                {#each sortedDepths as depth}
                  {@const entries = blastRadiusByDepth.get(depth) ?? []}
                  <div class="depth-group">
                    <div class="depth-label">Depth {depth}</div>
                    {#each entries as entry}
                      <div class="blast-row">
                        <span class="kind-chip {entityKindClass(entry.kind)}">{entityKindIcon(entry.kind)}</span>
                        <span class="blast-name" title={entry.qualified_name}>{entry.name}</span>
                        <span class="blast-qname">{shortPath(entry.qualified_name)}</span>
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- ── Dependencies ────────────────────────────────────────────── -->
      <div class="panel">
        <button
          class="panel-header"
          onclick={() => (importsExpanded = !importsExpanded)}
        >
          <span class="panel-title">Imports</span>
          <span class="count-badge">{data.imports.length}</span>
          <span class="panel-toggle">{importsExpanded ? "▾" : "▸"}</span>
        </button>

        {#if importsExpanded}
          {#if data.imports.length === 0}
            <div class="empty-panel">No imports.</div>
          {:else}
            <div class="path-list">
              {#each data.imports as imp}
                <div class="path-row">
                  <span class="dep-arrow out-arrow">→</span>
                  <span class="dep-path" title={imp}>{imp}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <div class="panel">
        <button
          class="panel-header"
          onclick={() => (importedByExpanded = !importedByExpanded)}
        >
          <span class="panel-title">Imported By</span>
          <span class="count-badge">{data.imported_by.length}</span>
          <span class="panel-toggle">{importedByExpanded ? "▾" : "▸"}</span>
        </button>

        {#if importedByExpanded}
          {#if data.imported_by.length === 0}
            <div class="empty-panel">Not imported by any file.</div>
          {:else}
            <div class="path-list">
              {#each data.imported_by as imp}
                <div class="path-row">
                  <span class="dep-arrow in-arrow">←</span>
                  <span class="dep-path" title={imp}>{imp}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

    </div>
  {:else}
    <div class="empty-state">No file context available.</div>
  {/if}
</div>

<style>
  .file-context {
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
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .file-path-header {
    font-family: monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .layer-chip {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid var(--chip-color, #6b7394);
    color: var(--chip-color, #6b7394);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .violation-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(255, 107, 107, 0.12);
    color: var(--danger, #ff6b6b);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .verdict-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(from var(--verdict-color, #636a80) r g b / 0.12);
    color: var(--verdict-color, #636a80);
    border: 1px solid rgba(from var(--verdict-color, #636a80) r g b / 0.25);
    flex-shrink: 0;
    white-space: nowrap;
    font-weight: 600;
  }

  /* ── Content area ────────────────────────────────────────────────────────── */

  .content-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* ── Panels ──────────────────────────────────────────────────────────────── */

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

  .panel-toggle {
    color: var(--text-muted, #636a80);
    font-size: 10px;
    opacity: 0.6;
  }

  .count-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
  }

  .empty-panel {
    padding: 6px 12px 10px;
    font-size: 12px;
    color: var(--text-muted, #636a80);
    font-style: italic;
  }

  /* ── Graph Metrics ───────────────────────────────────────────────────────── */

  .metrics-panel {
    background: var(--bg-card, rgba(255,255,255,0.03));
  }

  .metrics-grid {
    padding: 4px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .metric-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }

  .metric-label {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    width: 110px;
    flex-shrink: 0;
  }

  .metric-value {
    font-size: 12px;
    font-family: monospace;
    color: var(--text, #b4b8c8);
    font-weight: 600;
  }

  .metric-warn {
    font-size: 12px;
    font-family: monospace;
    color: var(--warning, #fbbf24);
    font-weight: 600;
  }

  .badge-hub {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(108, 140, 255, 0.15);
    color: var(--accent, #6c8cff);
    font-weight: 600;
  }

  .badge-cycle {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
  }

  .cycle-peers {
    padding-left: 118px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-bottom: 2px;
  }

  .peer-path {
    font-size: 10px;
    font-family: monospace;
    color: var(--text-muted, #636a80);
    background: var(--bg-card, rgba(255,255,255,0.06));
    padding: 1px 4px;
    border-radius: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  .impact-row {
    gap: 8px;
  }

  .impact-bar-wrap {
    flex: 1;
    height: 5px;
    background: var(--bg-card, rgba(255,255,255,0.08));
    border-radius: 3px;
    overflow: hidden;
    min-width: 40px;
    max-width: 120px;
  }

  .impact-bar {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  /* ── Entity list ─────────────────────────────────────────────────────────── */

  .entity-list {
    display: flex;
    flex-direction: column;
    padding: 2px 12px 10px;
    gap: 3px;
  }

  .entity-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    border-radius: 3px;
    padding: 1px 4px;
    transition: background 0.12s;
  }

  .entity-row:hover {
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .kind-chip {
    font-size: 9px;
    font-family: monospace;
    padding: 1px 4px;
    border-radius: 3px;
    font-weight: 700;
    flex-shrink: 0;
    width: 30px;
    text-align: center;
  }

  .kind-fn   { background: rgba(108,140,255,0.15); color: var(--accent, #6c8cff); }
  .kind-cls  { background: rgba(52,211,153,0.12); color: var(--success, #34d399); }
  .kind-if   { background: rgba(251,191,36,0.12); color: var(--warning, #fbbf24); }
  .kind-typ  { background: rgba(168,85,247,0.12); color: #c084fc; }
  .kind-other { background: var(--bg-card, rgba(255,255,255,0.06)); color: var(--text-muted, #636a80); }

  .entity-name {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .export-badge {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(52,211,153,0.1);
    color: var(--success, #34d399);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .line-range {
    font-size: 9px;
    font-family: monospace;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* ── Blast radius ────────────────────────────────────────────────────────── */

  .blast-list {
    display: flex;
    flex-direction: column;
    padding: 2px 12px 10px;
    gap: 2px;
  }

  .depth-group {
    margin-bottom: 4px;
  }

  .depth-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 4px 0 2px;
  }

  .blast-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 21px;
    border-radius: 3px;
    padding: 1px 4px;
    transition: background 0.12s;
  }

  .blast-row:hover {
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .blast-name {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    flex-shrink: 0;
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .blast-qname {
    font-family: monospace;
    font-size: 10px;
    color: var(--text-muted, #636a80);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* ── Dependency paths ────────────────────────────────────────────────────── */

  .path-list {
    display: flex;
    flex-direction: column;
    padding: 2px 12px 10px;
    gap: 2px;
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 20px;
    border-radius: 3px;
    padding: 1px 4px;
    transition: background 0.12s;
  }

  .path-row:hover {
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .dep-arrow {
    font-size: 11px;
    font-family: monospace;
    flex-shrink: 0;
    width: 14px;
    text-align: center;
  }

  .out-arrow { color: var(--accent, #6c8cff); }
  .in-arrow  { color: var(--success, #34d399); }

  .dep-path {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
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
