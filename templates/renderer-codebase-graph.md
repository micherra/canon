---
template: renderer-codebase-graph
description: Renderer spawn prompt for converting codebase_graph MCP data into a standalone codebase-graph.html
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

Read this file:
1. `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` — the design system reference

You will use:
- Section A (CSS tokens) — copy verbatim into your `<style>` tag
- Section B (page boilerplate) — use the `.container` wrapper (max-width: 960px)
- Section C (component patterns) — section-card, collapsible-section, stats-row, stat-card

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

// Group nodes by layer, sorted by degree descending within each group
const nodesByLayer = new Map();
for (const layer of layers) nodesByLayer.set(layer.name, []);
for (const node of nodes) {
  if (!nodesByLayer.has(node.layer)) nodesByLayer.set(node.layer, []);
  nodesByLayer.get(node.layer).push(node);
}
for (const [, layerNodes] of nodesByLayer) {
  layerNodes.sort((a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0));
}

// Max nodes in any layer (for canvas height)
let maxNodesInAnyLayer = 0;
for (const [, layerNodes] of nodesByLayer) {
  if (layerNodes.length > maxNodesInAnyLayer) maxNodesInAnyLayer = layerNodes.length;
}

// Layer chart: sorted by file_count descending
const sortedLayers = [...layers].sort((a, b) => b.file_count - a.file_count);
const maxLayerFileCount = Math.max(...sortedLayers.map(l => l.file_count), 1);

// Layer color map for the canvas script
const layerColorMap = {};
for (const layer of layers) layerColorMap[layer.name] = layer.color;

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
Use the `.container` wrapper (max-width: 960px). Assemble the page in this exact order:

### 4.1 Header panel

A `.section-card` with:
- Title: `Codebase Graph` (use `.section-title`)
- Slug badge: monospace font, `var(--text-muted)` color, `var(--bg-surface)` background with border
- Generated timestamp: small muted text

```html
<div class="section-card" style="margin-bottom: 16px;">
  <div class="section-card-header" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
    <h2 class="section-title" style="font-size: 18px;">Codebase Graph</h2>
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 11px; font-family: monospace; color: var(--text-muted); background: var(--bg-surface); padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border);">${SLUG}</span>
      <span style="font-size: 11px; color: var(--text-muted);">{generatedDate}</span>
    </div>
  </div>
</div>
```

### 4.2 Stats row

4 `.stat-card` elements in a `.stats-row`:
1. **Nodes** — value: `{nodeCount}`
2. **Edges** — value: `{edgeCount}`
3. **Layers** — value: `{layerCount}`
4. **Files with violations** — value: `{violationNodeCount}`, class `.stat-value--danger` if > 0

If `${DIFF_BASE}` is non-empty, add a 5th stat card: **Changed files** — value: `{changedNodeCount}`.

### 4.3 Layer distribution panel

A `.section-card` with title "Layers". Use a horizontal bar chart:

```html
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
```

Add this CSS for the chart:
```css
.chart-rows { display: flex; flex-direction: column; gap: 6px; }
.chart-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.layer-name { width: 120px; flex-shrink: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; height: 8px; background: var(--bg-surface); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; }
.file-count { width: 32px; flex-shrink: 0; color: var(--text-muted); text-align: right; font-size: 10px; }
```

### 4.4 Graph canvas panel

A `.section-card` with title "Dependency Graph". Contains a `<canvas>` element and a tooltip div.

Serialize the graph data for the canvas script. The data attribute must be HTML-escaped:

```javascript
// Build the canvas data object
const canvasData = {
  layers: layers.map(l => ({ name: l.name, color: l.color, index: l.index })),
  nodes: nodes.map(n => ({
    id: n.id,
    layer: n.layer,
    violation_count: n.violation_count ?? 0,
    changed: n.changed ?? false
  })),
  edges: normalizedEdges.map(e => ({ source: e.source, target: e.target, type: e.type }))
};
// Serialize: JSON.stringify, then escape & and " for use in data-* attribute
const canvasDataJson = JSON.stringify(canvasData)
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;");
```

Canvas height: `Math.max(400, maxNodesInAnyLayer * 22 + 80)` px.

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
    <canvas id="codebase-graph-canvas"
            data-graph="{canvasDataJson}"
            style="display: block; width: 100%; height: {canvasHeight}px; background: var(--bg);"></canvas>
    <div id="graph-tooltip" style="
      position: fixed; display: none; pointer-events: none;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 6px; padding: 6px 10px; font-size: 11px;
      color: var(--text-bright); font-family: monospace;
      max-width: 360px; word-break: break-all;
      box-shadow: var(--shadow); z-index: 1000;
    "></div>
  </div>
</div>
```

### 4.5 Canvas rendering script

Include this script ONCE, immediately before `</body>`. It renders the layered column graph:

IMPORTANT: Canvas 2D does not support CSS variables. Every hex color value in the
Canvas script MUST be preceded by a comment naming the design token it maps to:
  ctx.fillStyle = /* --accent */ '#6c8cff';
  ctx.strokeStyle = /* --danger */ '#ef4444';
This satisfies the design-tokens-as-style-contract convention for Canvas contexts.

```javascript
(function () {
  const canvas = document.getElementById('codebase-graph-canvas');
  const tooltip = document.getElementById('graph-tooltip');
  const legend = document.getElementById('layer-legend');
  if (!canvas) return;

  const raw = canvas.dataset.graph;
  if (!raw) return;

  let graph;
  try {
    graph = JSON.parse(raw);
  } catch (e) {
    return;
  }

  const { layers, nodes, edges } = graph;

  // Build lookup maps
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Assign node positions: layered columns left-to-right by layer index
  // Layer columns sorted by layer.index ascending
  const sortedLayers = [...layers].sort((a, b) => a.index - b.index);

  // Group nodes by layer
  const nodesByLayer = new Map();
  for (const layer of sortedLayers) nodesByLayer.set(layer.name, []);
  for (const node of nodes) {
    if (!nodesByLayer.has(node.layer)) nodesByLayer.set(node.layer, []);
    nodesByLayer.get(node.layer).push(node);
  }

  // Build degree map for vertical sorting within each column
  const degreeMap = new Map(nodes.map(n => [n.id, 0]));
  for (const edge of edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
  }
  for (const [, layerNodes] of nodesByLayer) {
    layerNodes.sort((a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0));
  }

  // Canvas dimensions (CSS pixels)
  const W = canvas.parentElement.clientWidth || 800;
  const H = canvas.getBoundingClientRect().height || 400;
  canvas.width = W * window.devicePixelRatio;
  canvas.height = H * window.devicePixelRatio;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  // Layout constants
  const PADDING_X = 48;
  const HEADER_H = 32;
  const NODE_RADIUS = 5;
  const colCount = sortedLayers.length || 1;
  const colWidth = (W - PADDING_X * 2) / colCount;

  // Compute column X centers and node positions
  const layerXMap = new Map(); // layer name → x center
  const nodePositions = new Map(); // node id → {x, y}

  sortedLayers.forEach((layer, colIdx) => {
    const x = PADDING_X + colIdx * colWidth + colWidth / 2;
    layerXMap.set(layer.name, x);

    const layerNodes = nodesByLayer.get(layer.name) ?? [];
    const nodeCount = layerNodes.length;
    const usableH = H - HEADER_H - NODE_RADIUS * 2 - 16;

    layerNodes.forEach((node, rowIdx) => {
      const y = HEADER_H + NODE_RADIUS + (nodeCount <= 1
        ? usableH / 2
        : (rowIdx / (nodeCount - 1)) * usableH);
      nodePositions.set(node.id, { x, y });
    });
  });

  // Draw layer column headers
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const layer of sortedLayers) {
    const x = layerXMap.get(layer.name) ?? 0;
    ctx.fillStyle = layer.color || /* --text-muted */ '#636a80';
    ctx.globalAlpha = 0.7;
    ctx.fillText(layer.name.length > 14 ? layer.name.slice(0, 13) + '…' : layer.name, x, 8);
    ctx.globalAlpha = 1;
    // Column separator line (subtle)
    const layerNodes = nodesByLayer.get(layer.name) ?? [];
    if (layerNodes.length > 1) {
      ctx.strokeStyle = layer.color || /* --text-muted */ '#636a80';
      ctx.globalAlpha = 0.08;
      ctx.lineWidth = colWidth - 8;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H);
      ctx.lineTo(x, H - 8);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Draw edges as quadratic bezier curves
  const getNodeLayer = (id) => nodeMap.get(id)?.layer ?? '';
  for (const edge of edges) {
    const src = nodePositions.get(edge.source);
    const tgt = nodePositions.get(edge.target);
    if (!src || !tgt) continue;
    const isCrossLayer = getNodeLayer(edge.source) !== getNodeLayer(edge.target);
    ctx.beginPath();
    // Control point: midpoint with vertical offset
    const cpX = (src.x + tgt.x) / 2;
    const cpY = (src.y + tgt.y) / 2 - Math.abs(tgt.x - src.x) * 0.15;
    ctx.moveTo(src.x, src.y);
    ctx.quadraticCurveTo(cpX, cpY, tgt.x, tgt.y);
    ctx.strokeStyle = isCrossLayer ? /* --warning (nearest) */ '#EF9F27' : /* --text-muted (nearest) */ '#888780';
    ctx.globalAlpha = isCrossLayer ? 0.3 : 0.2;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Draw nodes
  for (const node of nodes) {
    const pos = nodePositions.get(node.id);
    if (!pos) continue;
    const layerColor = layers.find(l => l.name === node.layer)?.color || /* --text-muted */ '#636a80';

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, NODE_RADIUS, 0, Math.PI * 2);

    if (node.changed) {
      ctx.fillStyle = /* --accent */ '#6c8cff';
    } else if ((node.violation_count ?? 0) > 0) {
      ctx.fillStyle = /* --danger */ '#ff6b6b';
    } else {
      ctx.fillStyle = layerColor;
    }
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Violation ring
    if ((node.violation_count ?? 0) > 0) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, NODE_RADIUS + 2, 0, Math.PI * 2);
      ctx.strokeStyle = /* --danger */ '#ff6b6b';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Layer legend (inject into legend div)
  for (const layer of sortedLayers) {
    const chip = document.createElement('span');
    chip.style.cssText = `
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; color: var(--text-muted);
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 4px; padding: 2px 8px; cursor: pointer;
    `;
    chip.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${layer.color};"></span>${layer.name}`;
    chip.title = `${layer.file_count} files`;
    legend.appendChild(chip);
  }

  // Also add legend items for changed and violation nodes if applicable
  const hasChanged = nodes.some(n => n.changed);
  const hasViolations = nodes.some(n => (n.violation_count ?? 0) > 0);
  if (hasChanged) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted);background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:2px 8px;';
    chip.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + /* --accent */ '#6c8cff' + ';"></span>changed';
    legend.appendChild(chip);
  }
  if (hasViolations) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted);background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:2px 8px;';
    chip.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + /* --danger */ '#ff6b6b' + ';"></span>violations';
    legend.appendChild(chip);
  }

  // Hover tooltip
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let found = null;
    for (const node of nodes) {
      const pos = nodePositions.get(node.id);
      if (!pos) continue;
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= NODE_RADIUS + 4) {
        found = node;
        break;
      }
    }
    if (found) {
      tooltip.textContent = found.id;
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY - 8) + 'px';
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  });
  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
})();
```

### 4.6 Insights panel

A collapsible section (`<details open>`) with title "Insights". Only render sub-sections that
have data — omit any sub-section with an empty array.

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
Title: "Files with Violations ({violationNodeCount})".

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

Implement inline (do not import):

```javascript
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

## Step 6 — Write output

Write the complete, self-contained HTML to:
  ${WORKSPACE}/artifacts/codebase-graph.html

The file must be fully self-contained (no external stylesheets, no JavaScript imports, no CDN
links). All CSS is inline in the `<style>` tag. The canvas rendering script is inline before
`</body>`.

Return when the file is written. Do not modify the worktree.
````

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- `${DIFF_BASE}` and `${SOURCE_DIRS}` are both optional — the renderer must handle empty strings gracefully
- This template requires the `codebase_graph` MCP tool call (hence `model: sonnet` — Haiku cannot make MCP tool calls reliably for large graphs)
- The canvas script uses a deterministic layered column layout — no force simulation, no physics iterations
- Node coloring priority: changed (blue #6c8cff) > violation (red #ff6b6b) > layer color
- Edge coloring: cross-layer edges amber (#EF9F27 at 0.3 opacity), same-layer edges gray (#888780 at 0.2 opacity)
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If `codebase_graph` returns no nodes (empty graph), write a minimal informational page and stop
- The layer legend is injected into the DOM by JavaScript — do not pre-render it in static HTML
