<script lang="ts">
  import { onMount } from "svelte";
  import { bridge } from "./stores/bridge";
  import { getLayerColor, SEVERITY_COLORS, truncate } from "./lib/constants";

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
    file_path?: string;
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
    imported_by_layer?: Record<string, string[]>;
    layer_stack: string[];
    role: string;
    shape?: { label: string; description: string };
    project_max_impact?: number;
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
  let canvasEl = $state<HTMLCanvasElement | null>(null);

  // ── Derived state ─────────────────────────────────────────────────────────

  let fileName = $derived(data?.file_path.split("/").pop() ?? "");

  let crossLayerImports = $derived.by(() => {
    if (!data) return new Set<string>();
    const result = new Set<string>();
    for (const [layerName, files] of Object.entries(data.imports_by_layer)) {
      if (layerName !== data.layer) {
        for (const f of files) result.add(f);
      }
    }
    return result;
  });

  let hasCrossLayerImports = $derived(crossLayerImports.size > 0);

  let importedByLabel = $derived.by(() => {
    if (!data) return "";
    const deps = data.imported_by;
    if (deps.length <= 3) return deps.map(shortName).join(", ");
    return `${deps.length} files`;
  });

  let uniqueImportLayers = $derived.by(() => {
    if (!data) return 0;
    return Object.keys(data.imports_by_layer).length;
  });

  let entityTypeCounts = $derived.by(() => {
    if (!data?.entities) return { types: 0, fns: 0 };
    const types = data.entities.filter(e => e.kind === "type" || e.kind === "interface").length;
    const fns = data.entities.filter(e => e.kind === "function").length;
    return { types, fns };
  });

  let sortedViolations = $derived.by(() => {
    if (!data?.violations) return [];
    const order: Record<string, number> = { rule: 0, "strong-opinion": 1, convention: 2 };
    return [...data.violations].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  });

  let sortedEntities = $derived.by(() => {
    if (!data?.entities) return [];
    const kindOrder: Record<string, number> = { function: 0, interface: 1, type: 2, class: 3, variable: 4 };
    return [...data.entities].sort((a, b) => {
      if (a.is_exported !== b.is_exported) return a.is_exported ? -1 : 1;
      const kd = (kindOrder[a.kind] ?? 5) - (kindOrder[b.kind] ?? 5);
      if (kd !== 0) return kd;
      return a.name.localeCompare(b.name);
    });
  });

  let blastRadiusByDepth = $derived.by(() => {
    if (!data?.blast_radius) return new Map<number, FileBlastRadiusEntry[]>();
    const map = new Map<number, FileBlastRadiusEntry[]>();
    for (const entry of data.blast_radius) {
      const arr = map.get(entry.depth) ?? [];
      arr.push(entry);
      map.set(entry.depth, arr);
    }
    return map;
  });

  let blastRadiusSummary = $derived.by(() => {
    if (!data?.blast_radius) return null;
    const br = data.blast_radius;
    if (br.length === 0) return "Nothing depends on this file's exports. Changes are fully contained.";
    const depth1 = br.filter(e => e.depth === 1).length;
    const depth2plus = br.filter(e => e.depth >= 2).length;
    if (depth1 <= 3 && depth2plus === 0) return `Low blast radius — ${depth1} direct dependent${depth1 === 1 ? "" : "s"}. Well-contained.`;
    const total = br.length;
    return `Moderate blast radius — changes affect ${depth1} file${depth1 === 1 ? "" : "s"} directly and propagate further.`;
  });

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

  // ── Canvas graph ──────────────────────────────────────────────────────────

  function drawGraph(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    if (!data) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = 280;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);

    const imports = data.imports ?? [];
    const dependents = data.imported_by ?? [];

    const CX = W / 2;
    const CY = H / 2;
    const LEFT_X = 80;
    const RIGHT_X = W - 80;

    // Node positions
    const importPositions: Array<{ x: number; y: number; path: string }> = imports.map((imp, i) => ({
      x: LEFT_X,
      y: (H / (imports.length + 1)) * (i + 1),
      path: imp,
    }));

    const dependentPositions: Array<{ x: number; y: number; path: string }> = dependents.map((dep, i) => ({
      x: RIGHT_X,
      y: (H / (dependents.length + 1)) * (i + 1),
      path: dep,
    }));

    // Draw edges
    function drawEdge(
      x1: number, y1: number,
      x2: number, y2: number,
      color: string,
    ) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Arrowhead at target
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const AL = 7;
      const AW = Math.PI / 7;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - AL * Math.cos(angle - AW),
        y2 - AL * Math.sin(angle - AW),
      );
      ctx.lineTo(
        x2 - AL * Math.cos(angle + AW),
        y2 - AL * Math.sin(angle + AW),
      );
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Import edges: import node → centre
    for (const pos of importPositions) {
      const isCross = crossLayerImports.has(pos.path);
      drawEdge(pos.x, pos.y, CX, CY, isCross ? "#EF9F27" : "#B4B2A9");
    }

    // Dependent edges: centre → dependent node
    for (const pos of dependentPositions) {
      drawEdge(CX, CY, pos.x, pos.y, "#5DCAA5");
    }

    // Draw import nodes
    for (const pos of importPositions) {
      const isCross = crossLayerImports.has(pos.path);
      const color = isCross ? "#EF9F27" : "#888780";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Label left of node
      ctx.font = "10px monospace";
      ctx.fillStyle = "#b4b8c8";
      ctx.textAlign = "end";
      ctx.fillText(truncate(shortName(pos.path), 28), pos.x - 9, pos.y + 3);
    }

    // Draw dependent nodes
    for (const pos of dependentPositions) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#1D9E75";
      ctx.fill();

      // Label right of node
      ctx.font = "10px monospace";
      ctx.fillStyle = "#b4b8c8";
      ctx.textAlign = "start";
      ctx.fillText(truncate(shortName(pos.path), 28), pos.x + 9, pos.y + 3);
    }

    // Draw centre node (this file) with halo
    ctx.beginPath();
    ctx.arc(CX, CY, 14, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(127, 119, 221, 0.3)";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(CX, CY, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#7F77DD";
    ctx.fill();

    // Centre label below node
    ctx.font = "11px monospace";
    ctx.fillStyle = "#e8eaf0";
    ctx.textAlign = "center";
    ctx.fillText(truncate(fileName, 28), CX, CY + 28);
  }

  $effect(() => {
    if (status !== "ready" || !canvasEl) return;
    const canvas = canvasEl;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawGraph(canvas, ctx);

    const ro = new ResizeObserver(() => drawGraph(canvas, ctx));
    ro.observe(canvas.parentElement ?? canvas);
    return () => ro.disconnect();
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function shortName(path: string): string {
    return path.split("/").pop() ?? path;
  }

  function severityColor(severity: string): string {
    return SEVERITY_COLORS[severity] ?? "#636a80";
  }

  function kindBadgeColor(kind: string): string {
    switch (kind) {
      case "function": return "#7F77DD";
      case "interface": return "#1D9E75";
      case "type": return "#6c8cff";
      case "class": return "#e07060";
      default: return "#636a80";
    }
  }

  function depthChipBorderColor(depth: number): string {
    if (depth === 1) return "#5F5E5A";
    if (depth === 2) return "#B4B2A9";
    return "#D3D1C7";
  }
</script>

<div class="file-context">
  {#if status === "loading"}
    <div class="empty-state">Loading file context...</div>

  {:else if status === "error"}
    <div class="empty-state error">{errorMsg}</div>

  {:else if data}
    <!-- ── Section 1: Hero ──────────────────────────────────────────────── -->
    <div class="hero">
      <span class="hero-path">{data.file_path}</span>
      <span class="hero-title">{fileName}</span>
      {#if data.summary}
        <p class="hero-summary">{data.summary}</p>
      {/if}
      <div class="hero-badges">
        <span
          class="badge badge-layer"
          style="--chip-color: {getLayerColor(data.layer)}"
        >{data.layer}</span>
        {#if data.graph_metrics?.is_hub}
          <span class="badge badge-hub">hub</span>
        {/if}
        {#if data.graph_metrics?.in_cycle}
          <span class="badge badge-cycle">cycle</span>
        {/if}
        {#if data.violation_count === 0}
          <span class="badge badge-clean">no violations</span>
        {:else}
          <span class="badge badge-violation">{data.violation_count} violation{data.violation_count === 1 ? "" : "s"}</span>
        {/if}
      </div>
    </div>

    <!-- ── Stat Bar ──────────────────────────────────────────────────────── -->
    <div class="stat-bar">
      <div class="metric-card">
        <span class="metric-value">{data.imports.length}</span>
        <span class="metric-label">Imports</span>
        <span class="metric-sub">{uniqueImportLayers} layer{uniqueImportLayers === 1 ? "" : "s"}</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">{data.imported_by.length}</span>
        <span class="metric-label">Imported by</span>
        <span class="metric-sub" title={data.imported_by.join(", ")}>{importedByLabel || "none"}</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">{data.exports.length}</span>
        <span class="metric-label">Exports</span>
        <span class="metric-sub">{entityTypeCounts.types} types, {entityTypeCounts.fns} fns</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">{data.graph_metrics?.impact_score ?? "—"}</span>
        <span class="metric-label">Impact score</span>
        {#if data.project_max_impact != null}
          <span class="metric-sub">out of {data.project_max_impact}</span>
        {:else}
          <span class="metric-sub">—</span>
        {/if}
      </div>
      {#if data.shape}
        <div class="metric-card verdict-card">
          <div class="verdict-inner">
            <span class="verdict-icon">✓</span>
            <div class="verdict-text">
              <span class="verdict-label">{data.shape.label}</span>
              <span class="verdict-desc">{data.shape.description}</span>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <div class="content-area">
      <!-- ── Section 2: Dependency Graph ──────────────────────────────── -->
      <div class="section">
        <div class="graph-legend">
          <span class="legend-item"><span class="legend-dot" style="background:#7F77DD"></span>this file</span>
          <span class="legend-item"><span class="legend-dot" style="background:#888780"></span>imports</span>
          <span class="legend-item"><span class="legend-dot" style="background:#1D9E75"></span>imported by</span>
          {#if hasCrossLayerImports}
            <span class="legend-item"><span class="legend-dot" style="background:#EF9F27"></span>cross-layer</span>
          {/if}
        </div>
        <div class="canvas-wrap">
          <canvas bind:this={canvasEl} class="dep-canvas"></canvas>
        </div>
      </div>

      <!-- ── Section 3: Entity table + Blast radius ─────────────────── -->
      <div class="two-col-grid">
        <!-- Entity table -->
        <div class="panel">
          <div class="panel-header">EXPORTS &amp; ENTITIES</div>
          {#if sortedEntities.length > 0}
            <table class="entity-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Exported</th>
                  <th>Lines</th>
                </tr>
              </thead>
              <tbody>
                {#each sortedEntities as e (e.name + e.line_start)}
                  <tr>
                    <td class="entity-name">{e.name}</td>
                    <td>
                      <span
                        class="kind-badge"
                        style="background: {kindBadgeColor(e.kind)}22; color: {kindBadgeColor(e.kind)}; border-color: {kindBadgeColor(e.kind)}44"
                      >{e.kind}</span>
                    </td>
                    <td class="entity-exported">{e.is_exported ? "✓" : "—"}</td>
                    <td class="entity-lines">{e.line_start}–{e.line_end}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="panel-empty">Entity data unavailable — run codebase_graph to index this file.</p>
          {/if}
        </div>

        <!-- Blast radius -->
        <div class="panel">
          <div class="panel-header">BLAST RADIUS</div>
          {#if data.blast_radius != null}
            {#if data.blast_radius.length === 0}
              <p class="panel-empty">{blastRadiusSummary}</p>
            {:else}
              {#each [...blastRadiusByDepth.entries()].sort((a, b) => a[0] - b[0]) as [depth, entries] (depth)}
                <div class="depth-group">
                  <span class="depth-label">Depth {depth}</span>
                  <div class="depth-chips">
                    {#each entries as entry (entry.qualified_name)}
                      <span
                        class="depth-chip"
                        title={entry.file_path ?? entry.qualified_name}
                        style="border-left-color: {depthChipBorderColor(depth)}"
                      >{shortName(entry.file_path ?? entry.name)}</span>
                    {/each}
                  </div>
                </div>
              {/each}
              {#if blastRadiusSummary}
                <p class="blast-summary">{blastRadiusSummary}</p>
              {/if}
            {/if}
          {:else}
            <p class="panel-empty">Blast radius unavailable — run codebase_graph to compute dependencies.</p>
          {/if}
        </div>
      </div>

      <!-- ── Section 4: Violations ──────────────────────────────────── -->
      <div class="section">
        <div class="section-header">VIOLATIONS</div>
        {#if sortedViolations.length > 0}
          <div class="violations-list">
            {#each sortedViolations as v (v.principle_id)}
              <div
                class="violation-card"
                style="border-left-color: {severityColor(v.severity)}"
              >
                <div class="violation-top">
                  <span
                    class="severity-pill"
                    style="background: {severityColor(v.severity)}22; color: {severityColor(v.severity)}; border-color: {severityColor(v.severity)}44"
                  >{v.severity}</span>
                  <strong class="violation-id">{v.principle_id}</strong>
                </div>
                {#if v.message}
                  <p class="violation-message">{v.message}</p>
                {/if}
              </div>
            {/each}
          </div>
        {:else if data.violation_count === 0 && data.last_verdict}
          <p class="muted-text">Last reviewed: {data.last_verdict}. Clean.</p>
        {:else}
          <p class="muted-text">No violations in the most recent review.</p>
        {/if}
      </div>
    </div>

  {:else}
    <div class="empty-state">No file context available.</div>
  {/if}
</div>

<style>
  /* ── Layout ────────────────────────────────────────────────────────────────── */

  .file-context {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
    min-height: 600px;
    background: var(--bg, #0c0f1a);
    color: var(--text, #b4b8c8);
  }

  /* ── Hero ──────────────────────────────────────────────────────────────────── */

  .hero {
    padding: 16px 16px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
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
    font-size: 18px;
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hero-summary {
    margin: 4px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text, #b4b8c8);
  }

  .hero-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  .badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid transparent;
  }

  .badge-layer {
    border-color: var(--chip-color, #6b7394);
    color: var(--chip-color, #6b7394);
    background: transparent;
  }

  .badge-hub {
    background: rgba(127, 119, 221, 0.15);
    color: #9d96e8;
    border-color: rgba(127, 119, 221, 0.35);
  }

  .badge-cycle {
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
    border-color: rgba(251, 191, 36, 0.3);
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

  /* ── Stat Bar ──────────────────────────────────────────────────────────────── */

  .stat-bar {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .metric-card {
    background: var(--bg-surface, rgba(255,255,255,0.03));
    border-radius: 6px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 80px;
  }

  .metric-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
    line-height: 1;
  }

  .metric-label {
    font-size: 11px;
    color: var(--text-muted, #636a80);
  }

  .metric-sub {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
  }

  .verdict-card {
    background: var(--bg-card, rgba(255,255,255,0.06));
    border: 1px solid rgba(255,255,255,0.1);
    flex: 2;
    min-width: 180px;
  }

  .verdict-inner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .verdict-icon {
    font-size: 18px;
    color: var(--success, #34d399);
    flex-shrink: 0;
    margin-top: 2px;
  }

  .verdict-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .verdict-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
  }

  .verdict-desc {
    font-size: 11px;
    color: var(--text, #b4b8c8);
    line-height: 1.4;
  }

  /* ── Content area ──────────────────────────────────────────────────────────── */

  .content-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 14px 16px;
    min-height: 0;
  }

  /* ── Section ───────────────────────────────────────────────────────────────── */

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

  /* ── Graph legend ──────────────────────────────────────────────────────────── */

  .graph-legend {
    display: flex;
    gap: 14px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--text-muted, #636a80);
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ── Canvas ────────────────────────────────────────────────────────────────── */

  .canvas-wrap {
    width: 100%;
    border-radius: 6px;
    background: var(--bg-surface, rgba(255,255,255,0.03));
    overflow: hidden;
  }

  .dep-canvas {
    display: block;
    width: 100%;
    height: 280px;
  }

  /* ── Two-column grid ───────────────────────────────────────────────────────── */

  .two-col-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .panel {
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 6px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    overflow: hidden;
    min-width: 0;
  }

  .panel-header {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 12px 6px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }

  .panel-empty {
    padding: 12px;
    font-size: 12px;
    color: var(--text-muted, #636a80);
    font-style: italic;
    margin: 0;
    line-height: 1.5;
  }

  /* ── Entity table ──────────────────────────────────────────────────────────── */

  .entity-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .entity-table th {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 6px 10px;
    text-align: left;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }

  .entity-table td {
    padding: 5px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    vertical-align: middle;
  }

  .entity-table tr:last-child td {
    border-bottom: none;
  }

  .entity-name {
    font-family: monospace;
    color: var(--text-bright, #e8eaf0);
    font-size: 11px;
    word-break: break-all;
  }

  .entity-exported {
    text-align: center;
    color: var(--success, #34d399);
    font-size: 12px;
  }

  .entity-lines {
    font-family: monospace;
    font-size: 10px;
    color: var(--text-muted, #636a80);
    white-space: nowrap;
  }

  .kind-badge {
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid;
  }

  /* ── Blast radius ──────────────────────────────────────────────────────────── */

  .depth-group {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }

  .depth-group:last-of-type {
    border-bottom: none;
  }

  .depth-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .depth-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .depth-chip {
    font-family: monospace;
    font-size: 10px;
    padding: 2px 8px 2px 6px;
    border-radius: 3px;
    border-left: 3px solid #5F5E5A;
    background: var(--bg-surface, rgba(255,255,255,0.03));
    color: var(--text, #b4b8c8);
    white-space: nowrap;
    cursor: default;
  }

  .blast-summary {
    margin: 4px 12px 10px;
    font-size: 11px;
    color: var(--text-muted, #636a80);
    line-height: 1.5;
    font-style: italic;
  }

  /* ── Violations ────────────────────────────────────────────────────────────── */

  .violations-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .violation-card {
    border: 1px solid rgba(255,255,255,0.06);
    border-left: 3px solid var(--danger, #ff6b6b);
    border-radius: 4px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    overflow: hidden;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .violation-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .severity-pill {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid;
    flex-shrink: 0;
  }

  .violation-id {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
    font-family: monospace;
  }

  .violation-message {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text, #b4b8c8);
  }

  .muted-text {
    font-size: 12px;
    color: var(--text-muted, #636a80);
    margin: 0;
    font-style: italic;
  }

  /* ── Empty states ──────────────────────────────────────────────────────────── */

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
