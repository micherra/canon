---
template: renderer-codebase-graph
description: Renderer spawn prompt for converting codebase_graph MCP data into a standalone codebase-graph.html with force-directed layout, click-to-inspect panel, and DIFF_BASE filtering
used-by: [orchestrator]
read-by: [renderer-agent]
output-path: ${WORKSPACE}/artifacts/codebase-graph.html
model: sonnet
---

# Template: Renderer — Codebase Graph

Use this template when spawning the renderer agent to generate a standalone codebase graph
HTML view. The orchestrator reads this template, fills in the variable placeholders, and passes
the result as the renderer agent's spawn prompt.

## Variables

- `${WORKSPACE}` — absolute path to the Canon workspace
- `${SLUG}` — the build slug (e.g., `add-dark-mode`)
- `${DIFF_BASE}` — optional git commit hash to mark changed files; leave empty if no diff context
- `${SOURCE_DIRS}` — optional comma-separated source directories to scope the graph (e.g., `src,lib`); leave empty for the full graph

## Prompt

````
You are a renderer agent. Your sole job is to call the `codebase_graph` MCP tool, then
compose a self-contained HTML file from the result and write it to
${WORKSPACE}/artifacts/codebase-graph.html.
Do NOT modify the worktree.

## Step 1 — Read source files

Read these files:
1. `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` — the design system reference
2. `mcp-server/src/ui/snippets/node-detail-panel.html` — the click-to-inspect panel snippet

You will use:
- DESIGN-SYSTEM.md Section A (CSS tokens) — copy verbatim into your `<style>` tag
- DESIGN-SYSTEM.md Section B (page boilerplate) — base HTML shell
- DESIGN-SYSTEM.md Section C (component patterns) — section-card, collapsible-section
- node-detail-panel.html — embed the HTML and `<style>` block inline in the graph container

## Step 2 — Call the codebase_graph MCP tool

Call `mcp__canon__codebase_graph` with these parameters:

```
mcp__canon__codebase_graph({
  diff_base: "${DIFF_BASE}",       // omit this key if "${DIFF_BASE}" is empty
  source_dirs: ["${SOURCE_DIRS}"]  // omit this key if "${SOURCE_DIRS}" is empty;
                                   // if non-empty, split the comma-separated string into an array
})
```

From the result, extract:

```javascript
const nodes = result.nodes ?? [];
// Each node: { id: string, layer: string, color: string, violation_count: number,
//              top_violations: string[], changed: boolean, kind: string }

const edges = result.edges ?? [];
// Each edge: { source: string | { id: string }, target: string | { id: string },
//              type: string, confidence?: number }

const layers = result.layers ?? [];
// Each layer: { name: string, color: string, file_count: number, index: number }

const insights = result.insights ?? {};
// insights.most_connected: Array<{ id: string, in_degree: number, out_degree: number }>
// insights.orphan_files: string[]
// insights.circular_dependencies: Array<string[]>  (each inner array is one cycle)
// insights.layer_violations: Array<{ source: string, target: string,
//                                    source_layer: string, target_layer: string }>
// insights.blast_radius_hotspots: Array<{ entity_name: string, file_path: string,
//                                          affected_count: number }>

const generatedAt = result.generated_at ?? new Date().toISOString();
```

If the MCP tool returns an error or empty nodes, write a minimal error page to
`${WORKSPACE}/artifacts/codebase-graph.html` with the message and stop.

## Step 3 — Compute derived values

```javascript
// Stats
const nodeCount = nodes.length;
const edgeCount = edges.length;
const layerCount = layers.length;
const violationNodeCount = nodes.filter(n => (n.violation_count ?? 0) > 0).length;
const changedNodeCount = nodes.filter(n => n.changed).length;

// Resolve edge endpoint (edges may use string IDs or {id} objects)
function resolveEndpoint(ep) {
  return typeof ep === "string" ? ep : ep.id;
}

// Build a normalized edge list with string source/target
const normalizedEdges = edges.map(e => ({
  source: resolveEndpoint(e.source),
  target: resolveEndpoint(e.target),
  type: e.type ?? "imports",
  confidence: e.confidence ?? 1
}));

// Degree map (in + out per node)
const degreeMap = new Map();
for (const node of nodes) degreeMap.set(node.id, 0);
for (const edge of normalizedEdges) {
  degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
  degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
}

// Layer chart: sorted by file_count descending
const sortedLayers = [...layers].sort((a, b) => b.file_count - a.file_count);
const maxLayerFileCount = Math.max(...sortedLayers.map(l => l.file_count), 1);

// Layer color map
const layerColorMap = {};
for (const layer of layers) layerColorMap[layer.name] = layer.color;

// Adjacency maps for the detail panel (derived from edge list)
const adjIn = new Map();  // nodeId -> [sourceIds that import this node]
const adjOut = new Map(); // nodeId -> [targetIds this node imports]
for (const edge of normalizedEdges) {
  if (!adjOut.has(edge.source)) adjOut.set(edge.source, []);
  adjOut.get(edge.source).push(edge.target);
  if (!adjIn.has(edge.target)) adjIn.set(edge.target, []);
  adjIn.get(edge.target).push(edge.source);
}

// DIFF_BASE filtering
let displayNodes = nodes;
let displayEdges = normalizedEdges;
let filterActive = false;
let neighborCount = 0;

if ("${DIFF_BASE}" !== "" && changedNodeCount > 0) {
  const changedIds = new Set(nodes.filter(n => n.changed).map(n => n.id));
  const neighborIds = new Set();
  for (const edge of normalizedEdges) {
    if (changedIds.has(edge.source)) neighborIds.add(edge.target);
    if (changedIds.has(edge.target)) neighborIds.add(edge.source);
  }
  // Remove changed files from neighbors set (they're already in changedIds)
  for (const id of changedIds) neighborIds.delete(id);
  const visibleIds = new Set([...changedIds, ...neighborIds]);
  displayNodes = nodes.filter(n => visibleIds.has(n.id));
  displayEdges = normalizedEdges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
  filterActive = true;
  neighborCount = neighborIds.size;
}

// Canvas data: include kind field for detail panel
const canvasData = {
  layers: layers.map(l => ({ name: l.name, color: l.color, index: l.index, file_count: l.file_count })),
  nodes: displayNodes.map(n => ({
    id: n.id,
    layer: n.layer,
    violation_count: n.violation_count ?? 0,
    changed: n.changed ?? false,
    kind: n.kind ?? ""
  })),
  edges: displayEdges.map(e => ({ source: e.source, target: e.target, type: e.type })),
  // Adjacency for detail panel: build from displayEdges
  adjIn: Object.fromEntries(
    displayNodes.map(n => [n.id, (adjIn.get(n.id) ?? []).filter(id => displayNodes.some(dn => dn.id === id))])
  ),
  adjOut: Object.fromEntries(
    displayNodes.map(n => [n.id, (adjOut.get(n.id) ?? []).filter(id => displayNodes.some(dn => dn.id === id))])
  )
};
// Serialize: JSON.stringify, then escape & and " for use in data-* attribute
const canvasDataJson = JSON.stringify(canvasData)
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;");

// Canvas height: clamp between 500 and 800
const canvasHeight = Math.max(500, Math.min(800, 650));

// Insights data
const mostConnected = (insights.most_connected ?? []).slice(0, 10);
const orphanFiles = (insights.orphan_files ?? []).slice(0, 20);
const circularDeps = insights.circular_dependencies ?? [];
const layerViolations = insights.layer_violations ?? [];
const blastRadiusHotspots = (insights.blast_radius_hotspots ?? []).slice(0, 10);

// Timestamp formatting
const generatedDate = new Date(generatedAt).toLocaleString();
```

## Step 4 — Compose the HTML

Use the Section B page boilerplate from DESIGN-SYSTEM.md. Title: `Codebase Graph — ${SLUG}`.
The graph section goes FULL-WIDTH (no `.container` wrapper around the canvas/panel).
Keep `.container` for the header, stats bar, layer chart, insights, and violations panels.

Assemble the page in this exact order:

### 4.1 Header panel

A `.section-card` with `.container` wrapper:
- Title: `Codebase Graph` (use `.section-title`)
- Slug badge: monospace font, `var(--text-muted)` color, `var(--bg-surface)` background with border
- Generated timestamp: small muted text

```html
<div class="container">
  <div class="section-card" style="margin-bottom: 16px;">
    <div class="section-card-header" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <h2 class="section-title" style="font-size: 22px;">Codebase Graph</h2>
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 15px; font-family: monospace; color: var(--text-muted); background: var(--bg-surface); padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border);">${SLUG}</span>
        <span style="font-size: 15px; color: var(--text-muted);">{generatedDate}</span>
      </div>
    </div>
  </div>
</div>
```

### 4.2 Stats bar

Render an inline text stats bar with dot separators (matching the old Svelte app pattern).
Use `.container` wrapper. Render the filter-indicator span only when `filterActive` is true.

```html
<div class="container">
  <div class="stats-bar">
    <span class="stats-bar-val">{nodeCount} nodes</span>
    <span class="stats-bar-sep">&middot;</span>
    <span class="stats-bar-val">{edgeCount} edges</span>
    <span class="stats-bar-sep">&middot;</span>
    <span class="stats-bar-val">{layerCount} layers</span>
    <span class="stats-bar-sep">&middot;</span>
    <span class="stats-bar-val stats-bar-danger">{violationNodeCount} with violations</span>
    <span class="stats-bar-sep">&middot;</span>
    <span class="stats-bar-val stats-bar-accent">{changedNodeCount} changed</span>
    <!-- Only when filterActive: -->
    <span class="stats-bar-filter">Showing {displayNodes.length} files ({changedNodeCount} changed + {neighborCount} neighbors) of {nodeCount} total</span>
  </div>
</div>
```

CSS for the stats bar (add to `<style>` block):
```css
.stats-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 16px;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.stats-bar-sep { opacity: 0.4; }
.stats-bar-danger { color: var(--danger); }
.stats-bar-accent { color: var(--accent); }
.stats-bar-filter {
  margin-left: auto;
  font-size: 15px;
  color: var(--accent);
  font-weight: 600;
}
```

### 4.3 Layer distribution panel

A `.section-card` with `.container` wrapper and title "Layers". Use a horizontal bar chart:

```html
<div class="container">
  <div class="section-card" style="margin-bottom: 16px;">
    <div class="section-card-header"><h2 class="section-title">Layers</h2></div>
    <div class="section-card-body">
      <div class="chart-rows">
        <!-- One row per layer, sorted by file_count descending -->
        <div class="chart-row">
          <span class="layer-name">{escapeHtml(layer.name)}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width: {Math.round(layer.file_count / maxLayerFileCount * 100)}%; background: {layer.color}; opacity: 0.85;"></div>
          </div>
          <span class="file-count">{layer.file_count}</span>
        </div>
      </div>
    </div>
  </div>
</div>
```

CSS for the chart:
```css
.chart-rows { display: flex; flex-direction: column; gap: 6px; }
.chart-row { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.layer-name { width: 120px; flex-shrink: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; height: 8px; background: var(--bg-surface); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; }
.file-count { width: 32px; flex-shrink: 0; color: var(--text-muted); text-align: right; font-size: 13px; }
```

### 4.4 Graph canvas panel (full-width, no .container wrapper)

The graph section goes full-width. The `#graph-container` is a flex row: canvas on the left
taking `flex: 1`, detail panel on the right (30%, positioned absolute within the container).

Embed the node-detail-panel.html content (the `<div id="node-detail-panel">` HTML block) directly
inside `#graph-container`. Also extract the `<style>` block from node-detail-panel.html and add
it to the page's main `<style>` tag.

```html
<div class="section-card" style="margin-bottom: 16px;">
  <div class="section-card-header">
    <h2 class="section-title">Dependency Graph</h2>
  </div>
  <div class="section-card-body" style="padding: 0; position: relative;">
    <!-- Layer legend row -->
    <div id="layer-legend" style="display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border);">
      <!-- Rendered by JS below -->
    </div>
    <!-- Graph container: canvas (flex: 1) + detail panel (absolute, 30%) -->
    <div id="graph-container" style="position: relative; display: flex; overflow: hidden;">
      <canvas id="codebase-graph-canvas"
              data-graph="{canvasDataJson}"
              style="display: block; flex: 1; min-width: 0; height: {canvasHeight}px; background: var(--bg);"></canvas>
      <!-- Node detail panel (from node-detail-panel.html snippet, hidden by default) -->
      {embed node-detail-panel.html <div id="node-detail-panel"> block here}
    </div>
    <div id="graph-tooltip" style="position: fixed; display: none; pointer-events: none; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 15px; color: var(--text-bright); font-family: monospace; max-width: 360px; word-break: break-all; box-shadow: var(--shadow); z-index: 1000;"></div>
  </div>
</div>
```

### 4.5 Canvas rendering script (force-directed layout via shared engine)

The force-directed layout now comes from the shared
`mcp-server/src/ui/snippets/force-graph.html` engine (`renderForceGraph`) — the same canonical
snippet the review renderer uses. The codebase-graph-specific concerns (layer legend, click-to-inspect
side panel, DIFF_BASE filtering, panel-open canvas resize) stay HERE in this template as pre/post code
around the engine call; only the force-sim / normalize-to-fit / draw / hover core is delegated to the
snippet. Output is unchanged from the prior inline script — the engine was lifted from it.

**Emit the shared engine snippet `<script>` verbatim (ONCE).** Read
`mcp-server/src/ui/snippets/force-graph.html` and include its `<script>` block verbatim exactly once,
immediately before `</body>` and BEFORE the codebase-graph init script below. Do NOT re-implement the
force-simulation math inline — it lives only in `force-graph.html`. If the snippet has a `<style>`
block, include it once in the page `<style>`.

IMPORTANT: Canvas 2D does not support CSS variables. Every hex color value in any Canvas code MUST be
preceded by a comment naming the design token it maps to:
  if (n.changed) return /* --accent */ '#6c8cff';
  if ((n.violation_count || 0) > 0) return /* --danger */ '#ff6b6b';
This satisfies the design-tokens-as-style-contract convention for Canvas contexts. The shared
`force-graph.html` engine already annotates all of its own Canvas hex literals.

**Then include this codebase-graph init script ONCE, after the engine snippet, before `</body>`.**
It reads the graph data, calls `renderForceGraph` with codebase-graph's options, injects the layer
legend, and wires the click-to-inspect side panel (using the engine's returned `redraw(highlightId)`
handle to preserve the selection highlight):

```javascript
(function () {
  // ── Design token mapping (Canvas 2D cannot use CSS custom properties) ──
  // The hex values below correspond to DESIGN-SYSTEM.md Section A tokens:
  //   #6c8cff  → var(--accent)      — changed nodes
  //   #ff6b6b  → var(--danger)      — violation nodes
  //   #636a80  → var(--text-muted)  — fallback layer color (when layer has no color)
  // Edge colors, selection/violation rings, labels, and tooltip live in the shared
  // force-graph.html engine and carry their own /* --token */ comments there.

  const canvas = document.getElementById('codebase-graph-canvas');
  const legend = document.getElementById('layer-legend');
  const panel = document.getElementById('node-detail-panel');
  const panelClose = document.getElementById('ndp-close');
  const panelPath = document.getElementById('ndp-path');
  const panelBadges = document.getElementById('ndp-badges');
  const panelImportedByHeader = document.getElementById('ndp-imported-by-header');
  const panelImportedByList = document.getElementById('ndp-imported-by-list');
  const panelImportsHeader = document.getElementById('ndp-imports-header');
  const panelImportsList = document.getElementById('ndp-imports-list');
  if (!canvas) return;

  const raw = canvas.dataset.graph;
  if (!raw) return;

  let graph;
  try {
    graph = JSON.parse(raw);
  } catch (e) {
    return;
  }

  const { layers, nodes, edges, adjIn, adjOut } = graph;

  // ── Render the force-directed layout via the shared engine ────
  // height omitted → engine uses the canvas computed/CSS height (canvasHeight).
  // Node coloring priority preserved: changed > violation > layer color.
  const handle = renderForceGraph(
    canvas,
    { nodes, edges },
    {
      iterations: 200,
      edgeStyle: 'curve',
      drawLabels: false,            // preserve current look: hover tooltip + side panel, no per-node labels
      showViolationRing: true,
      nodeFill: function (n) {
        if (n.changed) return /* --accent */ '#6c8cff';
        if ((n.violation_count || 0) > 0) return /* --danger */ '#ff6b6b';
        const layer = layers.find(l => l.name === n.layer);
        return (layer && layer.color) || /* --text-muted */ '#636a80';
      },
      onNodeClick: function (n) { showPanel(n); }
    }
  );

  // ── Layer legend (inject into legend div) ─────────────────────
  const sortedLayers = [...layers].sort((a, b) => a.index - b.index);
  for (const layer of sortedLayers) {
    const chip = document.createElement('span');
    chip.style.cssText = `
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 15px; color: var(--text-muted);
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 4px; padding: 2px 8px; cursor: default;
    `;
    chip.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${layer.color};"></span>${layer.name}`;
    chip.title = `${layer.file_count} files`;
    legend.appendChild(chip);
  }
  const hasChanged = nodes.some(n => n.changed);
  const hasViolations = nodes.some(n => (n.violation_count ?? 0) > 0);
  if (hasChanged) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:15px;color:var(--text-muted);background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:2px 8px;';
    chip.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#6c8cff;"></span>changed';
    legend.appendChild(chip);
  }
  if (hasViolations) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:15px;color:var(--text-muted);background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:2px 8px;';
    chip.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff6b6b;"></span>violations';
    legend.appendChild(chip);
  }

  // ── Click-to-inspect panel ────────────────────────────────────
  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showPanel(node) {
    const layerColor = layers.find(l => l.name === node.layer)?.color || /* --text-muted */ '#636a80';

    // File path
    panelPath.textContent = node.id;

    // Badges
    const layerBadge = `<span class="ndp-badge ndp-badge-layer" style="background:${layerColor}22;color:${layerColor};border-color:${layerColor}44;">${escHtml(node.layer)}</span>`;
    const changedBadge = node.changed ? `<span class="ndp-badge ndp-badge-changed">changed</span>` : '';
    const kindBadge = node.kind ? `<span class="ndp-badge ndp-badge-kind">${escHtml(node.kind)}</span>` : '';
    panelBadges.innerHTML = layerBadge + changedBadge + kindBadge;

    // Imported-by
    const importedByIds = adjIn[node.id] ?? [];
    panelImportedByHeader.textContent = `IMPORTED BY (${importedByIds.length})`;
    panelImportedByList.innerHTML = importedByIds
      .map(id => `<li>${escHtml(id)}</li>`)
      .join('') || '<li style="color:var(--text-muted);font-style:italic;">none</li>';

    // Imports
    const importsIds = adjOut[node.id] ?? [];
    panelImportsHeader.textContent = `IMPORTS (${importsIds.length})`;
    panelImportsList.innerHTML = importsIds
      .map(id => `<li>${escHtml(id)}</li>`)
      .join('') || '<li style="color:var(--text-muted);font-style:italic;">none</li>';

    // Show panel
    panel.style.display = 'flex';

    // Redraw with the selection highlight (dims others + draws selection ring)
    // via the engine handle, mirroring the old inline drawGraph(highlightId).
    handle.redraw(node.id);
  }

  function hidePanel() {
    panel.style.display = 'none';
    handle.redraw(null);
  }

  if (panelClose) {
    panelClose.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePanel();
    });
  }
})();
```

### 4.6 Insights panel

A collapsible section (`<details open>`) with `.container` wrapper and title "Insights".
Only render sub-sections that have data — omit any sub-section with an empty array.

Structure each sub-section as a titled block inside the collapsible body:

**Most Connected Files** (if `mostConnected.length > 0`):
A compact table (`.requirement-table`) with columns: File, In, Out, Total. Use `escapeHtml`
on file paths. "In" = `in_degree`, "Out" = `out_degree`, "Total" = in_degree + out_degree.

**Orphan Files** (if `orphanFiles.length > 0`):
A `<ul>` list, each item showing the file path in monospace. Use `escapeHtml`.

**Circular Dependencies** (if `circularDeps.length > 0`):
A list of cycle groups. Each cycle is an array of node IDs — render as:
`A → B → C → A` (arrow-joined with `escapeHtml` on each ID).

**Layer Violations** (if `layerViolations.length > 0`):
A compact table with columns: Source file, Source layer, Target file, Target layer.
Use `escapeHtml` on all values.

**Blast Radius Hotspots** (if `blastRadiusHotspots.length > 0`):
A compact table with columns: Entity, File, Affected files. Use `escapeHtml` on text values.

### 4.7 Violations panel (conditional)

Render this panel ONLY if `violationNodeCount > 0`. Use a collapsible section (`<details>`).
Use `.container` wrapper. Title: "Files with Violations ({violationNodeCount})".

List all nodes where `violation_count > 0`. For each:
- File path in monospace (`escapeHtml`)
- Violation count badge: `background: var(--danger)22; color: var(--danger); border: 1px solid var(--danger)44;`
- Top violation IDs as small badges (use `escapeHtml`)

## Step 5 — Security

Apply `escapeHtml` to ALL text content extracted from MCP tool data before embedding in HTML.
This includes: node IDs (file paths), layer names, violation IDs, entity names.

**Exception**: The canvas `data-graph` attribute uses JSON serialization with `&` → `&amp;`
and `"` → `&quot;`. Color constants (hex values from `layer.color`) and numeric values do
not need escaping.

Use the canonical `escapeHtml` defined in
`mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` Section E (Security Requirements) — which you read
in Step 1. Copy that definition verbatim into your build-time rendering script (use the runtime
null-safe `escapeHtml` form noted there). Do NOT redefine or re-implement it here. (This refers to
the build-time content escaper only; the runtime `escHtml` helper inside the Canvas force-sim
script in Step 4.5 is a separate, page-embedded function and is unaffected.)

## Composition Protocol

**Write incrementally (watch_KKKKKK1)**: after completing MCP tool calls, write each major section to the output file before beginning the next — write the `<head>` block first, then each file-card / content section, then the graph section, then close the document. Do NOT compose the full HTML string in context and Write once: if the session times out before the Write call, the artifact is lost. A partial artifact on disk is recoverable; one that never reached Write is not.

## Step 6 — Write output

NEVER echo the HTML or large content into your response — compose it and write directly to the output path; if large, write then Edit-append. Echoing the artifact will exceed the output-token limit and fail the render.

Write the complete, self-contained HTML to:
  ${WORKSPACE}/artifacts/codebase-graph.html

The file must be fully self-contained (no external stylesheets, no JavaScript imports, no CDN
links). All CSS is inline in the `<style>` tag (including the CSS from node-detail-panel.html).
The canvas rendering script is inline before `</body>`.

Return when the file is written. Do not modify the worktree.
````

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- `${DIFF_BASE}` and `${SOURCE_DIRS}` are both optional — the renderer must handle empty strings gracefully
- This template requires the `codebase_graph` MCP tool call (hence `model: sonnet` — Haiku cannot make MCP tool calls reliably for large graphs)
- The renderer reads `node-detail-panel.html` and embeds its HTML + CSS inline — no separate HTTP request is needed from the browser
- **Force simulation**: delegated to the shared `mcp-server/src/ui/snippets/force-graph.html` engine (`renderForceGraph`) — vanilla JS spring-charge-gravity model, pre-computed (not animated). The codebase-graph init passes `iterations: 200`; the engine's default force constants ARE this renderer's prior inline values (K_REPEL=5000, K_SPRING=0.01, REST_LENGTH=50, K_GRAVITY=0.3, DAMPING=0.85, MAX_FORCE=10), so output is unchanged. No force-sim math lives inline in this template anymore.
- **Node coloring priority**: changed (blue #6c8cff) > violation (red #ff6b6b) > layer color — supplied to the engine via the `nodeFill` option
- **Edge coloring**: `edgeStyle: 'curve'` — cross-layer edges amber (#EF9F27 at 0.25 opacity), same-layer edges gray (#888780 at 0.15 opacity); highlight edges connected to selected node at 0.7 opacity (handled inside the engine)
- **Per-node labels**: `drawLabels: false` — codebase-graph relies on the engine's hover tooltip + the DOM side panel, NOT per-node Canvas labels (preserves the current look on large graphs)
- **DIFF_BASE filtering**: client-side, reduces displayNodes/displayEdges to changed + 1-hop neighbors before passing `canvasData` to the engine
- **Detail panel**: DOM-based (not Canvas), positioned absolute on the right within the flex graph-container; JS populates content on node click; the selection highlight (dim others + selection ring) is redrawn via the engine's returned `handle.redraw(highlightId)` on `showPanel`/`hidePanel`
- The detail panel overlays the graph (absolutely positioned within `#graph-container`); the engine sizes the canvas once to the full container width and hit-testing stays aligned because positions are not recomputed when the panel toggles
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If `codebase_graph` returns no nodes (empty graph), write a minimal informational page and stop
- The layer legend is injected into the DOM by JavaScript — do not pre-render it in static HTML
- Graph section goes full-width (no `.container` wrapper); all other panels use `.container` (max-width: 960px)
