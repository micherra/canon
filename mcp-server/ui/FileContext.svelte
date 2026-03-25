<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import { getLayerColor, SEVERITY_COLORS, VERDICT_COLORS } from "./lib/constants";

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

  interface FileBlastRadiusEntry {
    name: string;
    qualified_name: string;
    kind: string;
    depth: number;
  }

  interface FileViolationDetail {
    principle_id: string;
    severity: string;
    message?: string;
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
    summary: string | null;
    violations: FileViolationDetail[];
    imports_by_layer: Record<string, string[]>;
    layer_stack: string[];
    role: string;
    graph_metrics?: FileGraphMetrics;
    entities?: Array<{
      name: string;
      kind: string;
      is_exported: boolean;
      line_start: number;
      line_end: number;
    }>;
    blast_radius?: FileBlastRadiusEntry[];
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let status = $state<"loading" | "ready" | "error">("loading");
  let data = $state<FileContextOutput | null>(null);
  let errorMsg = $state("");

  // ── Derived state ─────────────────────────────────────────────────────────

  let fileName = $derived(data?.file_path.split("/").pop() ?? "");

  let blastRadiusLabel = $derived.by(() => {
    if (!data) return "none";
    const br = data.blast_radius;
    if (!br || br.length === 0) {
      if (data.imports.length > 0) return `all ${data.imports.length} imports`;
      return "none";
    }
    return `${br.length} downstream`;
  });

  let dependentsLabel = $derived(
    data?.imported_by.length ? `${data.imported_by.length}` : "none"
  );

  let sortedImportLayers = $derived(
    data ? Object.keys(data.imports_by_layer).sort() : []
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await bridge.init();
      data = await bridge.waitForToolResult();
      if (!data) throw new Error("No data received from tool");
      status = "ready";
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : "Failed to load file context";
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function shortName(path: string): string {
    return path.split("/").pop() ?? path;
  }

  function formatPrincipleTitle(id: string): string {
    return id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  function severityColor(severity: string): string {
    return SEVERITY_COLORS[severity] ?? "#636a80";
  }

  function roleColor(role: string): string {
    switch (role) {
      case "entry point": return "var(--success, #34d399)";
      case "hub":         return "var(--accent, #6c8cff)";
      case "leaf":        return "var(--text-muted, #636a80)";
      case "cycle member": return "var(--warning, #fbbf24)";
      default:            return "var(--text, #b4b8c8)";
    }
  }
</script>

<div class="file-context">
  {#if status === "loading"}
    <div class="empty-state">Loading file context...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if data}
    <!-- ── Hero Header ──────────────────────────────────────────────────── -->
    <div class="hero">
      <div class="hero-top">
        <div class="hero-left">
          <span class="hero-path">{data.file_path}</span>
          <span class="hero-title">{data.summary ? fileName : fileName}</span>
        </div>
        <div class="hero-badges">
          {#if data.graph_metrics?.is_hub}
            <span class="badge badge-hub">hub</span>
          {/if}
          <span
            class="badge badge-layer"
            style="--chip-color: {getLayerColor(data.layer)}"
          >{data.layer}</span>
          {#if data.violation_count === 0}
            <span class="badge badge-clean">no violations</span>
          {:else}
            <span class="badge badge-violation">{data.violation_count} violation{data.violation_count === 1 ? "" : "s"}</span>
          {/if}
        </div>
      </div>

      {#if data.summary}
        <div class="hero-summary">
          <p>{data.summary}</p>
        </div>
      {/if}
    </div>

    <!-- ── Stat Bar ─────────────────────────────────────────────────────── -->
    <div class="stat-bar">
      <div class="stat">
        <span class="stat-label">Imports</span>
        <span class="stat-value">{data.imports.length}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Imported by</span>
        <span class="stat-value">{data.imported_by.length}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Violations</span>
        <span class="stat-value" class:danger-text={data.violation_count > 0}>{data.violation_count}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Layer</span>
        <span class="stat-value">{data.layer}</span>
      </div>
    </div>

    <div class="content-area">
      <!-- ── Two-column cards ─────────────────────────────────────────── -->
      <div class="card-row">
        <!-- Position in Architecture -->
        <div class="card">
          <div class="card-header">POSITION IN ARCHITECTURE</div>
          <div class="layer-stack">
            {#each data.layer_stack as stackLayer (stackLayer)}
              <div class="layer-row" class:layer-active={stackLayer === data.layer}>
                {#if stackLayer === data.layer}
                  <span class="layer-arrow">→</span>
                {:else}
                  <span class="layer-arrow-spacer"></span>
                {/if}
                <span class="layer-name" class:layer-name-active={stackLayer === data.layer}>{stackLayer}</span>
                <span class="layer-dot" style="background: {getLayerColor(stackLayer)}"></span>
              </div>
            {/each}
            {#if data.layer_stack.length === 0}
              <div class="card-empty">No layer configuration</div>
            {/if}
          </div>
        </div>

        <!-- Risk & Impact -->
        <div class="card">
          <div class="card-header">RISK & IMPACT</div>
          <div class="risk-list">
            <div class="risk-row">
              <span class="risk-icon">↑</span>
              <span class="risk-label">Blast radius</span>
              <span class="risk-badge" class:risk-badge-accent={data.blast_radius && data.blast_radius.length > 0}>{blastRadiusLabel}</span>
            </div>
            <div class="risk-row">
              <span class="risk-icon">↙</span>
              <span class="risk-label">Dependents</span>
              <span class="risk-badge" class:risk-badge-accent={data.imported_by.length > 0}>{dependentsLabel}</span>
            </div>
            <div class="risk-row">
              <span class="risk-icon">◎</span>
              <span class="risk-label">In cycle</span>
              {#if data.graph_metrics?.in_cycle}
                <span class="risk-badge risk-badge-warn">yes</span>
              {:else}
                <span class="risk-badge risk-badge-ok">no</span>
              {/if}
            </div>
            <div class="risk-row">
              <span class="risk-icon">✦</span>
              <span class="risk-label">Role</span>
              <span class="risk-badge" style="color: {roleColor(data.role)}; border-color: {roleColor(data.role)}">{data.role}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Imports — Grouped by Layer ──────────────────────────────── -->
      {#if data.imports.length > 0}
        <div class="section">
          <div class="section-header">IMPORTS — GROUPED BY LAYER</div>
          {#each sortedImportLayers as layerName (layerName)}
            {@const files = data.imports_by_layer[layerName]}
            <div class="import-layer-group">
              <div class="import-layer-label">
                {layerName.toUpperCase()}
                <span class="import-layer-count">({files.length})</span>
              </div>
              <div class="import-chips">
                {#each files as imp (imp)}
                  <span class="import-chip" title={imp}>{shortName(imp)}</span>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <!-- ── Violations Section ──────────────────────────────────────── -->
      {#if data.violations.length === 0}
        <div class="section">
          <div class="compliance-card compliance-clean">
            <span class="compliance-icon">✓</span>
            <div class="compliance-text">
              <span class="compliance-title ok">No violations</span>
              <span class="compliance-sub">This file complies with all Canon principles</span>
            </div>
          </div>
        </div>
      {:else}
        <div class="section">
          <div class="section-header">VIOLATIONS PRESENT — {data.violations.length} VIOLATION{data.violations.length === 1 ? "" : "S"}</div>
          <div class="violations-container">
            <div class="violations-header">
              <span class="violations-count"><span class="count-num danger-text">{data.violations.length}</span> violations found</span>
              <button class="fix-all-btn">Fix all ↗</button>
            </div>
            {#each data.violations as v (v.principle_id)}
              <div class="violation-card">
                <div class="violation-top">
                  <span
                    class="severity-badge"
                    style="background: {severityColor(v.severity)}20; color: {severityColor(v.severity)}; border-color: {severityColor(v.severity)}40"
                  >{v.severity}</span>
                  <div class="violation-principle">
                    <span class="violation-principle-title">{formatPrincipleTitle(v.principle_id)}</span>
                    <span class="violation-principle-id">{v.principle_id}</span>
                  </div>
                </div>
                {#if v.message}
                  <div class="violation-bottom">
                    <span class="violation-warn-icon">⚠</span>
                    <div class="violation-detail">
                      <span class="violation-message">{v.message}</span>
                      <span class="violation-fix-link">Show me how to fix this ↗</span>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
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

  /* ── Hero Header ──────────────────────────────────────────────────────────── */

  .hero {
    padding: 16px 16px 12px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .hero-top {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .hero-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hero-path {
    font-family: monospace;
    font-size: 11px;
    color: var(--text-muted, #636a80);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hero-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hero-badges {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid transparent;
  }

  .badge-hub {
    background: rgba(108, 140, 255, 0.15);
    color: var(--accent, #6c8cff);
    border-color: rgba(108, 140, 255, 0.3);
  }

  .badge-layer {
    border-color: var(--chip-color, #6b7394);
    color: var(--chip-color, #6b7394);
    background: transparent;
  }

  .badge-clean {
    background: rgba(52, 211, 153, 0.12);
    color: var(--success, #34d399);
    border-color: rgba(52, 211, 153, 0.25);
  }

  .badge-violation {
    background: rgba(255, 107, 107, 0.12);
    color: var(--danger, #ff6b6b);
    border-color: rgba(255, 107, 107, 0.25);
  }

  .hero-summary {
    margin-top: 10px;
    padding: 8px 12px;
    border-left: 3px solid var(--accent, #6c8cff);
    background: var(--bg-surface, rgba(255,255,255,0.03));
    border-radius: 0 4px 4px 0;
  }

  .hero-summary p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text, #b4b8c8);
  }

  /* ── Stat Bar ─────────────────────────────────────────────────────────────── */

  .stat-bar {
    display: flex;
    padding: 12px 16px;
    gap: 24px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat-label {
    font-size: 11px;
    color: var(--text-muted, #636a80);
  }

  .stat-value {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
    line-height: 1;
  }

  .danger-text {
    color: var(--danger, #ff6b6b);
  }

  /* ── Content area ─────────────────────────────────────────────────────────── */

  .content-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px;
    min-height: 0;
  }

  /* ── Two-column card row ──────────────────────────────────────────────────── */

  .card-row {
    display: flex;
    gap: 12px;
  }

  .card {
    flex: 1;
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    border-radius: 6px;
    background: var(--bg-card, rgba(255,255,255,0.03));
    overflow: hidden;
    min-width: 0;
  }

  .card-header {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 12px 6px;
  }

  .card-empty {
    padding: 8px 12px;
    font-size: 12px;
    color: var(--text-muted, #636a80);
    font-style: italic;
  }

  /* ── Layer stack (left card) ──────────────────────────────────────────────── */

  .layer-stack {
    display: flex;
    flex-direction: column;
    padding: 4px 0 8px;
  }

  .layer-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    transition: background 0.12s;
  }

  .layer-active {
    background: rgba(108, 140, 255, 0.08);
  }

  .layer-arrow {
    font-size: 12px;
    color: var(--accent, #6c8cff);
    font-weight: 700;
    width: 14px;
    flex-shrink: 0;
  }

  .layer-arrow-spacer {
    width: 14px;
    flex-shrink: 0;
  }

  .layer-name {
    font-size: 12px;
    color: var(--text-muted, #636a80);
    flex: 1;
  }

  .layer-name-active {
    color: var(--accent, #6c8cff);
    font-weight: 600;
  }

  .layer-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ── Risk & Impact (right card) ───────────────────────────────────────────── */

  .risk-list {
    display: flex;
    flex-direction: column;
    padding: 4px 12px 8px;
    gap: 8px;
  }

  .risk-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .risk-icon {
    font-size: 13px;
    color: var(--accent, #6c8cff);
    width: 18px;
    text-align: center;
    flex-shrink: 0;
  }

  .risk-label {
    font-size: 12px;
    color: var(--text, #b4b8c8);
    flex: 1;
  }

  .risk-badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    border: 1px solid var(--border, rgba(255,255,255,0.1));
    color: var(--text-muted, #636a80);
    white-space: nowrap;
  }

  .risk-badge-accent {
    color: var(--accent, #6c8cff);
    border-color: rgba(108, 140, 255, 0.3);
    background: rgba(108, 140, 255, 0.08);
  }

  .risk-badge-ok {
    color: var(--success, #34d399);
    border-color: rgba(52, 211, 153, 0.3);
    background: rgba(52, 211, 153, 0.08);
  }

  .risk-badge-warn {
    color: var(--warning, #fbbf24);
    border-color: rgba(251, 191, 36, 0.3);
    background: rgba(251, 191, 36, 0.08);
  }

  /* ── Section headers ──────────────────────────────────────────────────────── */

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-header {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* ── Imports grouped by layer ─────────────────────────────────────────────── */

  .import-layer-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .import-layer-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .import-layer-count {
    font-weight: 400;
    opacity: 0.7;
  }

  .import-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .import-chip {
    font-family: monospace;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border, rgba(255,255,255,0.08));
    color: var(--text, #b4b8c8);
    background: var(--bg-card, rgba(255,255,255,0.03));
    white-space: nowrap;
    cursor: default;
    transition: background 0.12s;
  }

  .import-chip:hover {
    background: rgba(255,255,255,0.08);
  }

  /* ── Compliance / Violations ──────────────────────────────────────────────── */

  .compliance-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    background: var(--bg-card, rgba(255,255,255,0.03));
  }

  .compliance-icon {
    font-size: 20px;
    color: var(--success, #34d399);
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(52, 211, 153, 0.12);
  }

  .compliance-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .compliance-title {
    font-size: 14px;
    font-weight: 600;
  }

  .compliance-title.ok {
    color: var(--success, #34d399);
  }

  .compliance-sub {
    font-size: 12px;
    color: var(--text-muted, #636a80);
  }

  .violations-container {
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    border-radius: 6px;
    background: var(--bg-card, rgba(255,255,255,0.03));
    overflow: hidden;
  }

  .violations-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
  }

  .violations-count {
    font-size: 13px;
    color: var(--text, #b4b8c8);
  }

  .count-num {
    font-size: 18px;
    font-weight: 700;
    margin-right: 4px;
  }

  .fix-all-btn {
    font-size: 11px;
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--border, rgba(255,255,255,0.15));
    background: transparent;
    color: var(--text, #b4b8c8);
    cursor: pointer;
    font-weight: 600;
    transition: background 0.15s, border-color 0.15s;
  }

  .fix-all-btn:hover {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.25);
  }

  .violation-card {
    margin: 0 10px 10px;
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    border-radius: 6px;
    overflow: hidden;
  }

  .violation-top {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: rgba(0,0,0,0.15);
  }

  .severity-badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .violation-principle {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .violation-principle-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
  }

  .violation-principle-id {
    font-family: monospace;
    font-size: 10px;
    color: var(--text-muted, #636a80);
  }

  .violation-bottom {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    align-items: flex-start;
  }

  .violation-warn-icon {
    font-size: 14px;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .violation-detail {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .violation-message {
    font-size: 12px;
    line-height: 1.5;
    color: var(--text, #b4b8c8);
  }

  .violation-fix-link {
    font-size: 12px;
    color: var(--accent, #6c8cff);
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .violation-fix-link:hover {
    opacity: 0.8;
  }

  /* ── Empty states ─────────────────────────────────────────────────────────── */

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
