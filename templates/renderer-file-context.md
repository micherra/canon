---
template: renderer-file-context
description: Renderer spawn prompt for converting get_file_context MCP data into a standalone file-context.html
used-by: [orchestrator]
read-by: [renderer-agent]
model: sonnet
output-path: ${WORKSPACE}/artifacts/file-context.html
---

# Template: Renderer — File Context

Use this template when spawning the renderer agent to produce a standalone file context view
for any file in the codebase.

The orchestrator reads this template, fills in the variable placeholders, and passes the
result as the renderer agent's spawn prompt.

## Variables

- `${WORKSPACE}` — absolute path to the Canon workspace (not the worktree)
- `${SLUG}` — the build slug (e.g., `add-dark-mode`)
- `${FILE_PATH}` — the project-relative file path to inspect (e.g., `mcp-server/src/app/index.ts`)

## Prompt

````
You are a renderer agent. Your sole job is to produce a standalone file context HTML page
and write it to ${WORKSPACE}/artifacts/file-context.html.
Do NOT modify the worktree. Do NOT edit any source files.

## Step 1 — Read source files

Read these files before doing anything else:
1. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — authoritative design system reference (read all sections)
2. mcp-server/src/ui/snippets/file-detail-card.html — source of the Canvas dependency graph script and CSS patterns
3. mcp-server/src/ui/snippets/blast-radius-tree.html — blast radius tree snippet (CSS and HTML pattern)

You will reuse the Canvas script from file-detail-card.html verbatim (see Step 4.3). Do NOT
rewrite it — extract it exactly as-is.

## Step 2 — Call MCP tool for file context data

Call the `get_file_context` MCP tool:

```
mcp__canon__get_file_context({ file_path: "${FILE_PATH}" })
```

From the result, extract and name these variables for use in subsequent steps:

- `filePath` — `file_path` (string)
- `layer` — `layer` (string)
- `imports` — `imports` (string[])
- `importedBy` — `imported_by` (string[])
- `exports` — `exports` (string[])
- `importsByLayer` — `imports_by_layer` (Record<string, string[]>)
- `importedByLayer` — `imported_by_layer` (Record<string, string[]> | undefined)
- `violationCount` — `violation_count` (number)
- `violations` — `violations` (array of { principle_id, severity, message? })
- `graphMetrics` — `graph_metrics` (object with in_degree, out_degree, is_hub, in_cycle, impact_score)
- `shape` — `shape` (object with label, description) or null
- `projectMaxImpact` — `project_max_impact` (number | undefined)
- `entities` — `entities` (array of { name, kind, is_exported, line_start, line_end }) or []
- `blastRadius` — `blast_radius` (unified report object with seed_file, seed_layer, summary, by_depth, affected) or null
- `hotspotScore` — `hotspot_score` (object with churn_percentile, complexity_percentile, is_hotspot, score) or null
- `coChangePartners` — `co_change_partners` (array of { path, jaccard }) or []
- `computedTags` — `computed_tags` (string[]) or []

If the tool call fails, write a minimal error page to `${WORKSPACE}/artifacts/file-context.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>File Context Error</title>
<style>body{background:#0c0f1a;color:#b4b8c8;font-family:monospace;padding:32px;}</style>
</head>
<body><h1 style="color:#ff6b6b">Error</h1><p>Could not load file context for: ${FILE_PATH}</p></body>
</html>
```

Then stop.

## Step 3 — Compute derived values

Compute these values before composing the HTML. Use JavaScript-style pseudocode as your guide;
translate into whatever you need to produce the correct HTML strings.

```javascript
// Filename only (no directory)
const fileName = filePath.split("/").pop() ?? filePath;

// Layer color (hash-based HSL — same function as F.12 in DESIGN-SYSTEM.md)
function layerColor(layer) {
  let hash = 0;
  for (let i = 0; i < layer.length; i++) {
    hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 62%, 56%)`;
}
const lColor = layerColor(layer);

// Violation badge
const violationBadgeClass = violationCount > 0 ? "danger" : "clean";
const violationBadgeText = violationCount > 0 ? `${violationCount} violation${violationCount > 1 ? "s" : ""}` : "no violations";

// Import layer count
const importLayerCount = Object.keys(importsByLayer ?? {}).length;

// Cross-layer imports and dependents
const crossLayerImports = [];
for (const [layerName, files] of Object.entries(importsByLayer ?? {})) {
  if (layerName !== layer) crossLayerImports.push(...files);
}
const crossLayerDependents = [];
for (const [layerName, files] of Object.entries(importedByLayer ?? {})) {
  if (layerName !== layer) crossLayerDependents.push(...files);
}

// Entity counts for sub-label
const entityTypeCount = (entities ?? []).filter(e => e.kind === "type" || e.kind === "interface").length;
const entityFnCount = (entities ?? []).filter(e => e.kind === "function").length;

// Impact score display
const impactScore = graphMetrics?.impact_score?.toFixed(2) ?? "0.00";
const impactMax = projectMaxImpact?.toFixed(2) ?? "—";

// Sort entities: exported first, then by kind, then by name
const kindOrder = { function: 0, interface: 1, type: 2, class: 3, variable: 4 };
const sortedEntities = [...(entities ?? [])].sort((a, b) => {
  if (a.is_exported !== b.is_exported) return a.is_exported ? -1 : 1;
  const kd = (kindOrder[a.kind] ?? 5) - (kindOrder[b.kind] ?? 5);
  if (kd !== 0) return kd;
  return a.name.localeCompare(b.name);
});

// Sort violations by severity
const severityOrder = { rule: 0, "strong-opinion": 1, convention: 2 };
const sortedViolations = [...(violations ?? [])].sort(
  (a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
);

// Blast radius (guard against legacy array format)
const blastReport = blastRadius && !Array.isArray(blastRadius) ? blastRadius : null;
const blastSummary = blastReport?.summary ?? null;
const blastByDepth = blastReport?.by_depth ?? {};
const depth1Files = blastByDepth["1"] ?? [];
const depth2PlusCount = Object.entries(blastByDepth)
  .filter(([k]) => Number(k) >= 2)
  .reduce((sum, [, files]) => sum + files.length, 0);
const blastTotalAffected = blastReport?.affected?.length ?? 0;

// Graph data JSON for Canvas (HTML-attribute-escape after JSON.stringify)
const graphData = {
  imports: imports ?? [],
  imported_by: importedBy ?? [],
  exports: exports ?? [],
  fileName,
  layer,
  crossLayerImports,
  crossLayerDependents,
};
const graphDataJson = JSON.stringify(graphData)
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;");
```

## Step 4 — Compose the HTML

Use the security helpers (Step 4.0), then assemble each section in order (Steps 4.1–4.9).

### Step 4.0 — Security helpers

Use the canonical `escapeHtml` and `markdownToHtml` defined in
`mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` Section E (Security Requirements) — which you read
in Step 1. Copy those definitions verbatim into the script generating the HTML (use the runtime
null-safe `escapeHtml` form noted there). Do NOT redefine or re-implement them here.

Apply `escapeHtml` to ALL user-supplied strings before embedding in HTML:
- file paths, layer names, entity names, principle IDs, violation messages
- co-change partner paths, tag values, shape labels and descriptions

Color constants, computed numbers, and CSS hex values do NOT need escaping.

### Step 4.1 — Page shell

Use Section B from DESIGN-SYSTEM.md. Title: `File Context — ${escapeHtml(fileName)}`.

Start with:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>File Context — {escapeHtml(fileName)}</title>
  <style>
    /* Step 4.10 CSS goes here */
  </style>
</head>
<body>
<div class="container">
  <!-- Sections 4.2–4.9 go here, in order -->
</div>
<!-- Canvas script goes here — see Step 4.3 -->
</body>
</html>
```

### Step 4.2 — Header panel

A `.section-card` with file info and badges:

```html
<div class="section-card" style="margin-bottom:12px;">
  <div class="section-card-header">
    <div class="fc-header-row">
      <span class="fc-file-path">{escapeHtml(filePath)}</span>
      <div class="fc-header-badges">
        <span class="fc-layer-badge" style="background:{lColor}22;color:{lColor};border-color:{lColor}44;">{escapeHtml(layer)}</span>
        {shape ? `<span class="fc-shape-badge" title="{escapeHtml(shape.description)}">{escapeHtml(shape.label)}</span>` : ""}
        <span class="fc-violation-badge fc-violation-{violationBadgeClass}">{violationBadgeText}</span>
      </div>
    </div>
    {shape ? `<div class="fc-shape-desc">{escapeHtml(shape.description)}</div>` : ""}
  </div>
</div>
```

### Step 4.3 — Stats row

Four metric cards using `.stats-row` / `.stat-card` from DESIGN-SYSTEM.md Section C:

```html
<div class="stats-row" style="margin-bottom:12px;">
  <div class="stat-card">
    <span class="stat-value">{imports.length}</span>
    <span class="stat-label">Imports</span>
    <span class="stat-sub">{importLayerCount} layer{importLayerCount !== 1 ? "s" : ""}</span>
  </div>
  <div class="stat-card">
    <span class="stat-value">{importedBy.length}</span>
    <span class="stat-label">Referenced by</span>
    <span class="stat-sub">{importedBy.length} file{importedBy.length !== 1 ? "s" : ""}</span>
  </div>
  <div class="stat-card">
    <span class="stat-value">{exports.length}</span>
    <span class="stat-label">Exports</span>
    <span class="stat-sub">{entityTypeCount}t, {entityFnCount}fns</span>
  </div>
  <div class="stat-card">
    <span class="stat-value">{impactScore}</span>
    <span class="stat-label">Impact score</span>
    <span class="stat-sub">out of {impactMax}</span>
  </div>
</div>
```

### Step 4.4 — Canvas dependency graph

A `.section-card` containing a full-width canvas. The canvas is larger than the embedded card
version (height expands with node count; no fixed 240px cap).

```html
<div class="section-card" style="margin-bottom:12px;">
  <div class="section-card-header">
    <h2 class="section-title">Dependency Graph</h2>
  </div>
  <div class="fc-graph-legend">
    <span class="fc-legend-item"><span class="fc-legend-dot" style="background:#7F77DD"></span>this file</span>
    <span class="fc-legend-item"><span class="fc-legend-dot" style="background:#888780"></span>depends on</span>
    <span class="fc-legend-item"><span class="fc-legend-dot" style="background:#1D9E75"></span>used by</span>
    <span class="fc-legend-item"><span class="fc-legend-dot" style="background:#EF9F27"></span>cross-layer</span>
  </div>
  <div class="fdc-canvas-wrap">
    <canvas
      id="fdc-canvas-main"
      class="fdc-dep-canvas"
      data-graph="{graphDataJson}"
    ></canvas>
  </div>
</div>
```

**Canvas script**: Extract the entire `<script>` block from `mcp-server/src/ui/snippets/file-detail-card.html`
(the block starting with `(function () {` and ending with `</script>`) and include it verbatim
before `</body>`. Do NOT rewrite or summarize the script — use the exact text.

The script auto-initializes via `initAllGraphs()` on DOMContentLoaded and handles resize via
ResizeObserver. No additional wiring is needed.

### Step 4.5 — Entity table (collapsible, open by default)

Show ALL entities — no row cap. Omit this section entirely if `entities` is empty.

```html
<details class="collapsible-section" open style="margin-bottom:12px;">
  <summary class="collapsible-summary">
    <span class="collapsible-arrow">&#9654;</span>
    <span class="collapsible-title">Entities ({entities.length} total)</span>
  </summary>
  <div class="collapsible-body">
    <table class="fdc-entity-table" style="width:100%;">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kind</th>
          <th>Exp</th>
          <th>Lines</th>
        </tr>
      </thead>
      <tbody>
        {sortedEntities.map(e => `
        <tr>
          <td><span class="fdc-entity-name">{escapeHtml(e.name)}</span></td>
          <td><span class="fdc-kind-badge" style="background:{kindColor(e.kind)}22;color:{kindColor(e.kind)};border-color:{kindColor(e.kind)}44;">{escapeHtml(e.kind)}</span></td>
          <td class="fdc-entity-exported">{e.is_exported ? "&#10003;" : "—"}</td>
          <td class="fdc-entity-lines">{e.line_start}–{e.line_end}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>
</details>
```

Kind badge colors (use this function):
```javascript
function kindColor(kind) {
  const map = { function: "#7F77DD", interface: "#1D9E75", type: "#6c8cff", class: "#e07060" };
  return map[kind] ?? "#636a80";
}
```

### Step 4.6 — Blast radius panel

Use the blast-radius-tree.html snippet pattern. Omit if `blastSummary === null` or
`blastTotalAffected === 0`.

Blast severity CSS class map: `"contained"` and `"low"` → `fdc-severity-low`;
`"moderate"` → `fdc-severity-moderate`; `"high"` → `fdc-severity-high`;
`"critical"` → `fdc-severity-critical`.

```html
<div class="section-card" style="margin-bottom:12px;">
  <div class="section-card-header">
    <div style="display:flex;align-items:center;gap:10px;">
      <h2 class="section-title">Blast Radius</h2>
      <span class="fdc-severity-badge fdc-severity-{blastSummary.severity}">{blastSummary.severity}</span>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">{escapeHtml(blastSummary.description)}</p>
  </div>
  <div class="section-card-body">
    <details class="collapsible-section" open>
      <summary class="collapsible-summary">
        <span class="collapsible-arrow">&#9654;</span>
        <span class="collapsible-title">Dependency Tree ({blastTotalAffected} affected files)</span>
      </summary>
      <div class="collapsible-body">
        <div class="dep-tree">
          <div class="dep-tree-group">
            <div class="dep-tree-root">{escapeHtml(filePath)}</div>
            <div class="dep-tree-edges">
              {depth1Files.map((f, i) => {
                const isLast = i === depth1Files.length - 1 && depth2PlusCount === 0;
                const connector = isLast ? "&#9492;&#9472;&#9472;" : "&#9500;&#9472;&#9472;";
                const fColor = layerColor(f.layer ?? "");
                return `
              <div class="dep-tree-edge">
                <div class="dep-tree-connector">{connector}</div>
                <div class="dep-tree-node">
                  <span class="dep-tree-name">{escapeHtml(f.path.split("/").pop() ?? f.path)}</span>
                  <span class="layer-badge" style="background:{fColor}22;color:{fColor};border-color:{fColor}44;">{escapeHtml(f.layer ?? "")}</span>
                </div>
              </div>`;
              }).join("")}
              {depth2PlusCount > 0 ? `
              <div class="dep-tree-edge">
                <div class="dep-tree-connector">&#9492;&#9472;&#9472;</div>
                <div class="dep-tree-node dep-tree-node--summary">+{depth2PlusCount} more at depth 2+</div>
              </div>` : ""}
            </div>
          </div>
        </div>
      </div>
    </details>
  </div>
</div>
```

If `depth1Files` is empty but blast radius is not null, render:
```html
<p class="empty-note">No blast radius data available</p>
```

### Step 4.7 — Violations panel (collapsible, conditional)

Omit entirely if `violationCount === 0`.

Severity color map:
- `"rule"` → `#e74c3c`
- `"strong-opinion"` → `#f39c12`
- `"convention"` → `#3498db`

```html
<details class="collapsible-section" open style="margin-bottom:12px;">
  <summary class="collapsible-summary">
    <span class="collapsible-arrow">&#9654;</span>
    <span class="collapsible-title">Violations ({violationCount})</span>
  </summary>
  <div class="collapsible-body">
    <ul class="violation-list">
      {sortedViolations.map(v => {
        const sColor = severityColors[v.severity] ?? "#636a80";
        return `
      <li class="violation-item">
        <span class="severity-badge" style="background:{sColor}22;color:{sColor};border-color:{sColor}44;">{escapeHtml(v.severity)}</span>
        <div class="item-body">
          <span class="principle-id-text">{escapeHtml(v.principle_id)}</span>
          {v.message ? `<span class="item-message">{escapeHtml(v.message)}</span>` : ""}
        </div>
      </li>`;
      }).join("")}
    </ul>
  </div>
</details>
```

```javascript
const severityColors = { rule: "#e74c3c", "strong-opinion": "#f39c12", convention: "#3498db" };
```

### Step 4.8 — Co-change partners panel (collapsible, conditional)

Omit entirely if `coChangePartners` is empty.

```html
<details class="collapsible-section" style="margin-bottom:12px;">
  <summary class="collapsible-summary">
    <span class="collapsible-arrow">&#9654;</span>
    <span class="collapsible-title">Co-Change Partners ({coChangePartners.length})</span>
  </summary>
  <div class="collapsible-body">
    <table class="requirement-table" style="width:100%;">
      <thead>
        <tr>
          <th>File</th>
          <th style="width:100px;text-align:right;">Jaccard</th>
        </tr>
      </thead>
      <tbody>
        {coChangePartners.map(p => `
        <tr>
          <td style="font-family:monospace;font-size:11px;">{escapeHtml(p.path)}</td>
          <td style="text-align:right;font-family:monospace;font-size:11px;">{Math.round(p.jaccard * 100)}%</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>
</details>
```

### Step 4.9 — Hotspot panel (conditional)

Omit entirely if `hotspotScore === null`.

```html
<div class="section-card" style="margin-bottom:12px;">
  <div class="section-card-header">
    <div style="display:flex;align-items:center;gap:10px;">
      <h2 class="section-title">Hotspot Analysis</h2>
      {hotspotScore.is_hotspot
        ? `<span class="fc-violation-badge fc-violation-danger">HOTSPOT</span>`
        : `<span class="fc-violation-badge fc-violation-clean">not a hotspot</span>`}
    </div>
  </div>
  <div class="section-card-body">
    <div class="stats-row" style="padding:0;gap:8px;">
      <div class="stat-card">
        <span class="stat-value">{hotspotScore.churn_percentile}th</span>
        <span class="stat-label">Churn percentile</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{hotspotScore.complexity_percentile}th</span>
        <span class="stat-label">Complexity percentile</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{hotspotScore.score?.toFixed(2) ?? "—"}</span>
        <span class="stat-label">Hotspot score</span>
      </div>
    </div>
  </div>
</div>
```

### Step 4.9b — Computed tags panel (conditional)

Omit entirely if `computedTags` is empty.

```html
<div class="section-card" style="margin-bottom:12px;">
  <div class="section-card-header">
    <h2 class="section-title">Computed Tags</h2>
  </div>
  <div class="section-card-body">
    <div class="fc-tags-row">
      {computedTags.map(tag => `
      <span class="fc-tag-badge">{escapeHtml(tag)}</span>`).join("")}
    </div>
  </div>
</div>
```

### Step 4.10 — CSS

Assemble the full `<style>` block in this order:

1. **Design tokens** — Section A from DESIGN-SYSTEM.md (copy `:root {}` block verbatim)

2. **Reset and base** — from Section B:
   ```css
   * { margin: 0; padding: 0; box-sizing: border-box; }
   body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
   .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
   ```

3. **Section card** — from Section C:
   ```css
   .section-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
   .section-card-header { padding: 14px 16px 10px; border-bottom: 1px solid var(--border); }
   .section-title { font-size: 13px; font-weight: 700; color: var(--text-bright); margin: 0; letter-spacing: 0.02em; }
   .section-card-body { padding: 14px 16px; color: var(--text); font-size: 13px; line-height: 1.5; }
   ```

4. **Collapsible section** — from Section C:
   ```css
   .collapsible-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
   .collapsible-summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; list-style: none; user-select: none; }
   .collapsible-summary::-webkit-details-marker { display: none; }
   .collapsible-arrow { font-size: 9px; color: var(--text-muted); transition: transform 0.15s ease; display: inline-block; }
   details[open] .collapsible-arrow { transform: rotate(90deg); }
   .collapsible-title { font-size: 12px; font-weight: 700; color: var(--text-bright); text-transform: uppercase; letter-spacing: 0.06em; }
   .collapsible-body { padding: 10px 14px 14px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 12px; line-height: 1.5; }
   ```

5. **Stats row** — from Section C:
   ```css
   .stats-row { display: flex; gap: 12px; padding: 12px 16px; }
   .stat-card { flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--bg-card); border-radius: 6px; border: 1px solid var(--border); min-width: 0; }
   .stat-value { font-size: 24px; font-weight: 700; color: var(--text-bright); line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
   .stat-label { font-size: 11px; color: var(--text-muted); }
   .stat-sub { font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
   ```

6. **File context header** — custom:
   ```css
   .fc-header-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
   .fc-file-path { font-family: monospace; font-size: 13px; color: var(--text-bright); flex: 1; word-break: break-all; }
   .fc-header-badges { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: nowrap; align-items: center; }
   .fc-layer-badge { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap; }
   .fc-shape-badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-glow); white-space: nowrap; }
   .fc-violation-badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; white-space: nowrap; border: 1px solid transparent; }
   .fc-violation-clean { background: rgba(52,211,153,0.12); color: var(--success); border-color: rgba(52,211,153,0.25); }
   .fc-violation-danger { background: rgba(255,107,107,0.12); color: var(--danger); border-color: rgba(255,107,107,0.25); }
   .fc-shape-desc { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.4; }
   ```

7. **Graph legend** — custom:
   ```css
   .fc-graph-legend { display: flex; gap: 12px; justify-content: flex-end; padding: 8px 14px 6px; flex-wrap: wrap; }
   .fc-legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-muted); }
   .fc-legend-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
   ```

8. **Canvas** — extracted from file-detail-card.html `<style>` block (`.fdc-canvas-wrap`, `.fdc-dep-canvas`):
   ```css
   .fdc-canvas-wrap { width: 100%; background: var(--bg-surface); overflow: hidden; }
   .fdc-dep-canvas { display: block; width: 100%; height: 320px; }
   ```
   The canvas height is a CSS minimum; the Canvas script overrides it dynamically based on node count.

9. **Entity table** — extracted from file-detail-card.html `<style>` block (`.fdc-entity-table` and related):
   ```css
   .fdc-entity-table { width: 100%; border-collapse: collapse; font-size: 11px; }
   .fdc-entity-table th { font-size: 9px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; padding: 5px 10px; text-align: left; border-bottom: 1px solid var(--border); }
   .fdc-entity-table td { padding: 4px 10px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
   .fdc-entity-table tr:last-child td { border-bottom: none; }
   .fdc-entity-name { font-family: monospace; color: var(--text-bright); font-size: 10px; word-break: break-all; }
   .fdc-entity-exported { text-align: center; color: var(--success); font-size: 11px; }
   .fdc-entity-lines { font-family: monospace; font-size: 9px; color: var(--text-muted); white-space: nowrap; }
   .fdc-kind-badge { font-size: 8px; padding: 1px 5px; border-radius: 3px; font-weight: 600; white-space: nowrap; border: 1px solid; }
   ```

10. **Blast radius tree** — extracted from blast-radius-tree.html `<style>` block:
    ```css
    .dep-tree { display: flex; flex-direction: column; gap: 16px; }
    .dep-tree-group { display: flex; flex-direction: column; gap: 4px; }
    .dep-tree-root { font-family: monospace; font-size: 12px; font-weight: 700; color: var(--text-bright); padding: 6px 10px; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 6px; display: inline-block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dep-tree-edges { display: flex; flex-direction: column; gap: 3px; padding-left: 16px; margin-top: 4px; }
    .dep-tree-edge { display: flex; align-items: center; gap: 6px; }
    .dep-tree-connector { font-family: monospace; font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
    .dep-tree-node { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 3px 8px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; min-width: 0; }
    .dep-tree-name { font-family: monospace; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
    .dep-tree-node--summary { color: var(--text-muted); font-style: italic; }
    .layer-badge { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px; border: 1px solid; white-space: nowrap; flex-shrink: 0; }
    ```

11. **Blast radius severity badges** — from file-detail-card.html:
    ```css
    .fdc-severity-badge { font-size: 9px; font-weight: 700; padding: 2px 8px; border-radius: 20px; border: 1px solid transparent; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
    .fdc-severity-low, .fdc-severity-contained { background: rgba(52,211,153,0.12); color: #34d399; border-color: rgba(52,211,153,0.3); }
    .fdc-severity-moderate { background: rgba(251,191,36,0.12); color: #fbbf24; border-color: rgba(251,191,36,0.3); }
    .fdc-severity-high { background: rgba(251,146,60,0.12); color: #fb923c; border-color: rgba(251,146,60,0.3); }
    .fdc-severity-critical { background: rgba(255,107,107,0.12); color: #ff6b6b; border-color: rgba(255,107,107,0.3); }
    ```

12. **Violations panel** — custom:
    ```css
    .violation-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .violation-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; background: var(--bg-card); border-radius: 6px; border: 1px solid var(--border); }
    .severity-badge { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap; letter-spacing: 0.03em; flex-shrink: 0; }
    .item-body { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
    .principle-id-text { font-size: 11px; font-family: monospace; color: var(--text-bright); }
    .item-message { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
    ```

13. **Co-change table** — reuse `.requirement-table` from Section C.

14. **Tags panel** — custom:
    ```css
    .fc-tags-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .fc-tag-badge { font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-glow); white-space: nowrap; }
    ```

15. **Shared table** — for co-change partners:
    ```css
    .requirement-table { width: 100%; border-collapse: collapse; font-size: 12px; background: var(--bg-card); }
    .requirement-table th { padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 700; color: var(--text-bright); background: var(--bg-surface); border-bottom: 1px solid var(--border); white-space: nowrap; }
    .requirement-table td { padding: 7px 12px; color: var(--text); border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.4; }
    .requirement-table tbody tr:last-child td { border-bottom: none; }
    .requirement-table tbody tr:nth-child(even) td { background: var(--bg-surface); }
    ```

16. **Misc** — empty states:
    ```css
    .empty-note { font-size: 12px; color: var(--text-muted); padding: 8px 0; }
    ```

## Step 5 — Write output

NEVER echo the HTML or large content into your response — compose it and write directly to the output path; if large, write then Edit-append. Echoing the artifact will exceed the output-token limit and fail the render.

Write the complete, self-contained HTML file to:

  `${WORKSPACE}/artifacts/file-context.html`

The file must:
- Include all CSS inline in `<style>` (no external stylesheets)
- Include the Canvas script inline before `</body>` (no external scripts)
- Be readable in a browser with no network access
- Have all user data escaped via `escapeHtml`
- Cover all 9 layout sections (header, stats, graph, entities, blast radius, violations,
  co-change partners, hotspot, tags) — conditionally rendering panels only when data exists

If any section has no data, render the section with an `.empty-note` message rather than
omitting the section header. Exception: violations, co-change partners, hotspot, and tags
panels are omitted entirely when their data is empty (not shown with empty state).
````
