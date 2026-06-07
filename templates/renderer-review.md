---
template: renderer-review
description: Renderer spawn prompt for converting the review markdown + live MCP data into review.html
used-by: [orchestrator]
read-by: [renderer-agent]
output-path: ${WORKSPACE}/artifacts/review.html
---

# Template: Renderer — Review Dashboard

Use this template when spawning the renderer agent after the reviewer step completes.

The orchestrator reads this template, fills in the variable placeholders, and passes the
result as the renderer agent's spawn prompt.

## Variables

- `${WORKSPACE}` — absolute path to the Canon workspace (not the worktree)
- `${SLUG}` — the build slug (e.g., `add-dark-mode`)
- `${BASE_COMMIT}` — the git commit hash to diff against (e.g., `abc1234`); used to scope
  `show_pr_impact` to the correct change set
- `${WORKTREE_PATH}` — absolute path to the build worktree (`${WORKSPACE}/worktree`); scopes
  `show_pr_impact` diff resolution to the build's checkout

## Prompt

````
You are a renderer agent. Your sole job is to convert the review markdown and live graph
data into a self-contained HTML dashboard and write it to ${WORKSPACE}/artifacts/review.html.
Do NOT modify the worktree.

## SNIPPET FIDELITY RULE

Do NOT compose your own HTML for any section that has a corresponding snippet file in `mcp-server/src/ui/snippets/`. You MUST:
1. Read the snippet file using the Read tool
2. Substitute {{PLACEHOLDER}} values into the literal file content
3. Use the substituted result verbatim in the artifact

Writing your own HTML for a section with an existing snippet is a violation of the snippet contract and will require re-spawn. There are no exceptions.

## Step 1 — Read source files

Read these files:
1. ${WORKSPACE}/reviews/REVIEW.md — the reviewer's output (your primary narrative source)
2. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — the design system reference

Read all sections of DESIGN-SYSTEM.md before composing. You will use:
- Section A (CSS tokens) — copy verbatim into your <style> tag
- Section F (Review Dashboard Patterns) — full layout, all subsections F.1–F.14
- Section G (Graph Context Patterns) — file detail and summary cards

Also read this snippet file for file card HTML and CSS:
- mcp-server/src/ui/snippets/file-detail-card.html — full card HTML + CSS used for all changed files (both high-impact and standard)

Note: `file-summary-card.html` is no longer used in this template. All files now use the expandable
`<details>` pattern (Step 5) with `file-detail-card.html` in the expanded body.

Do NOT duplicate the patterns inline. Read them from DESIGN-SYSTEM.md and the snippet files and apply them.

## Step 2 — Parse the review markdown

Extract these sections from REVIEW.md:

- **Verdict**: Look for `VERDICT: BLOCKING`, `VERDICT: WARNING`, or `VERDICT: CLEAN`
  (or equivalent phrasing near the top). Required.
- **Violations**: The violations table or list — each entry has: file path, principle ID,
  severity (rule / strong-opinion / convention), line numbers, explanation.
- **Compliance summary**: Principles checked vs. violations by severity tier. May appear as
  a table or summary line like "4 rules checked, 0 violations."
- **Honored principles**: List of principles explicitly checked and found compliant.
- **Reviewer narrative**: ALL of Stage 2 — code quality analysis, advisory items, gotcha
  documentation. This is the full free-text analysis section. Preserve it verbatim.
  Do NOT truncate or omit the narrative. It is the most valuable part of the review.
- **Changed files list**: Stage 1 — the list of files in the diff with their layer assignments.
- **Stage 5 acceptance criteria**: If present, the `## Stage 5` section — AC verification table.
- **Recommendations**: Any structured recommendation list (when present, use for "Fix Before
  Merge" instead of raw violations).

## Step 3 — Call MCP tools for live graph data

Call these two MCP tools to enrich the HTML with structural context:

### 3a. show_pr_impact

```
mcp__canon__show_pr_impact({
  diff_base: "${BASE_COMMIT}",
  worktree_path: "${WORKTREE_PATH}"
})
```

> **Limitation**: without `worktree_path`, `show_pr_impact` diffs against the main repo checkout
> (`projectDir`), not the build worktree; when the main checkout has advanced past `${BASE_COMMIT}`,
> returned stats may include unrelated changes, and KG-derived enrichment always reflects
> project-root state. Servers that predate the `worktree_path` parameter ignore it harmlessly.
> On any contradiction, the changed-file list in REVIEW.md Stage 1 is authoritative — fall back
> to it and treat `show_pr_impact` stats as approximate.

From the result, extract:
- `filesChanged` — total files changed count
- `blastRadius.affected` — array of `{ entity_name, entity_kind, file_path, depth }`
- `blastRadius.by_depth` — record of depth → file count
- `layers` — breakdown of changes by layer
- `subsystems` — new or removed subsystems
- `pr_metrics` — any PR-level metrics (lines added/removed, etc.)

### 3b. get_context (all changed files, batched)

Collect the full list of changed files from Stage 1 of REVIEW.md, then make a single batched call:

```
mcp__canon__get_context({
  file_paths: ["{file1}", "{file2}", ...],
  include: ["file_context"]
})
```

The response has the shape:
```json
{
  "file_paths": ["path/to/file.ts", ...],
  "include": ["file_context"],
  "file_context": {
    "path/to/file.ts": { "layer": "...", "shape": { "label": "...", "description": "..." }, "imports": [...], "imported_by": [...], ... },
    ...
  }
}
```

The `file_context` map is keyed by file path. For each entry, extract:
- `layer` — the layer this file belongs to
- `shape.label` — graph shape (e.g., "Central hub", "High fan-out hub", "Sink", "Standard")
- `shape.description` — shape description
- `imports` — list of files this file imports
- `imported_by` — list of files that import this file
- `imports_by_layer` — map of layer → files imported from that layer
- `imported_by_layer` — map of layer → files that import from that layer
- `exports` — list of exported symbol names
- `in_degree` — number of files that import this file
- `impact_score` — normalized impact score (0–1)
- `project_max_impact` — max impact score in the project (for "out of N" display)
- `graph_metrics` — `{ impact_score, is_hub, in_cycle }`
- `blast_radius.summary.total_files` — total downstream files affected
- `blast_radius.summary.severity` — "contained" | "low" | "moderate" | "high" | "critical"
- `blast_radius.by_depth` — record of depth string → BlastRadiusFile[]
- `blast_radius.affected` — per-file array of downstream dependents (used for dependency tree roots)
- `entities` — array of `{ name, kind, is_exported, line_start, line_end }`
- `computed_tags` — computed tags for this file
- `violation_count` — number of active violations on this file (if available)

Collect results into a map: `fileContextMap[filePath] = result.file_context[filePath]`.

If a file is absent from the response's `file_context` map, skip it — do not block rendering.

## Step 4 — Compute derived values

Using extracted data:

```javascript
// Verdict color (from Section F.1)
const VERDICT_COLORS = { BLOCKING: "#e74c3c", CLEAN: "#27ae60", WARNING: "#f39c12" };
const accentColor = VERDICT_COLORS[verdict] ?? "#f39c12";

// Violation counts by severity
const violations = /* extracted from REVIEW.md */;
const violationCount = violations.length;
const ruleCount = violations.filter(v => v.severity === "rule").length;

// Sort violations: rule first, then strong-opinion, then convention (Section F.6)
const SEVERITY_ORDER = { rule: 0, "strong-opinion": 1, convention: 2 };
const sortedViolations = [...violations].sort((a, b) =>
  (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
);
const top5 = sortedViolations.slice(0, 5);

// Blast radius: top files by downstream dep count
const blastFiles = /* from show_pr_impact blastRadius.affected, aggregated to file-level */;
const maxDepCount = Math.max(...blastFiles.map(f => f.depCount), 1);

// Changed files for the stats row "highest blast radius" card
const highestBlastFile = blastFiles[0] ?? null;

// Compliance bar data
const rulesPassed = /* rules checked - rule violations */;
const rulesTotal = /* rules checked */;
const opinionsPassed = /* strong-opinions checked - strong-opinion violations */;
const opinionsTotal = /* strong-opinions checked */;
const conventionsPassed = /* conventions checked - convention violations */;
const conventionsTotal = /* conventions checked */;

// Layer chart data
const layerData = /* from show_pr_impact layers or from fileContextMap */;

// Subsystems data
const subsystemData = /* from show_pr_impact subsystems */;

// Headline text (Section F.3)
const fileCount = filesChanged;
const layerCount = Object.keys(layerData).length;
let headline;
if (violationCount === 0) {
  headline = `${fileCount} files across ${layerCount} layers — no violations. Ready to merge.`;
} else if (ruleCount === 0) {
  headline = `${fileCount} files — ${violationCount} violations. No blocking issues, but ${violationCount} violations need addressing.`;
} else {
  headline = `${fileCount} files across ${layerCount} layers — ${ruleCount} violations to fix before merge.`;
}
```

## Step 5 — Compose the HTML

Follow the full-width layout from Section F.2 (NOT the `.container` wrapper from Section B).

**General rule: Do NOT render a section if it has no data. Empty cards with "No data" messages
waste space. Only render sections that have meaningful content to display.**

Assemble in this order:

1. **Verdict banner** (Section F.3) — full-width, no container
2. **Reviewer narrative panel** — full-width card immediately after the verdict banner (see below)
3. **Stats row** (Section F.4) — 3 stat cards (files changed, violations, blast radius).
4. **Dashboard grid** (Section F.5) — 2-column grid, conditional cards:
   - Row 1 left: "Fix Before Merge" (Section F.6) — **omit entirely if 0 violations**; instead
     render a compact "No violations — looking good." success banner below the stats row
   - Row 1 right: "Violations by Principle" (Section F.7) + "Compliance Score" (Section F.8)
     stacked — **omit "Violations by Principle" if 0 violations**
   - Row 2 left: "Highest Blast Radius" (Section F.9) — **omit entirely if blast radius data
     is empty** (all files are leaf nodes with 0 downstream deps; `blastFiles` is empty or all
     have depCount === 0)
   - Row 2 right: "Changes by Layer" (Section F.10) — **omit if layerData is empty**;
     "New Subsystems" (Section F.11) stacked below — **omit if subsystemData is empty**
5. **Graph Context section** (Section G) — full-width collapsible card with file-detail-card and file-summary-card snippets
6. **Blast Radius Dependency Tree** — full-width collapsible card (see "Blast radius dependency tree" below) — **omit entirely if blast radius data is empty**

### Conditional rendering rules

Apply these rules to avoid empty-section clutter:

- **0 violations**: Replace the "Fix Before Merge" grid card with a compact success banner:
  ```html
  <div class="no-violations-banner" style="grid-column: 1 / -1; padding: 12px 16px;
    background: #eafaf1; border: 1px solid #27ae60; border-radius: 6px; color: #27ae60;
    font-weight: 600; margin-bottom: 8px;">
    No violations — looking good.
  </div>
  ```
  Also omit the "Violations by Principle" card (only render "Compliance Score" in that column).

- **Empty blast radius** (blastFiles.length === 0 OR all depCount === 0): Omit both the
  "Highest Blast Radius" grid card and the entire Blast Radius Dependency Tree section. Do not
  render them at all — not even collapsed.

- **Empty subsystems** (subsystemData is empty or absent): Omit the "New Subsystems" card
  entirely.

- **Empty layer data** (layerData is empty): Omit the "Changes by Layer" card entirely.

### Reviewer narrative panel

This panel is REQUIRED. Do not omit it.

Place it as a full-width panel immediately after the verdict banner, before the stats row:

```html
<div class="grid-card" style="grid-column: 1 / -1; margin-top: 8px;">
  <details class="collapsible-section" open>
    <summary class="collapsible-summary">
      <span class="collapsible-arrow">&#9654;</span>
      <span class="collapsible-title">Reviewer Narrative</span>
    </summary>
    <div class="collapsible-body narrative-content">
      {markdownToHtml(reviewerNarrative)}
    </div>
  </details>
</div>
```

The narrative starts open (`<details open>`). Render ALL narrative text — code quality analysis,
advisory items, gotcha documentation. Do not summarize or truncate.

**Note**: Do NOT use `escapeHtml()` directly on the narrative or set `white-space: pre-wrap`.
Instead, convert markdown formatting to proper HTML elements using `markdownToHtml()` (defined
below). All user-supplied text content within the converted elements must still be escaped for
security — the conversion function handles this by escaping raw text before inserting it into
HTML tags.

This function handles the reviewer narrative section only — headings, lists, paragraphs, and
inline formatting. Tables and fenced code blocks in other review sections (violation tables,
acceptance criteria grids) are rendered by their own dedicated section handlers, not by this
function.

Use the canonical `escapeHtml` and `markdownToHtml` defined in
`mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` Section E (Security Requirements) — which you read
in Step 1. Copy those definitions verbatim into your build-time rendering script (use the runtime
null-safe `escapeHtml` form noted there). The canonical `markdownToHtml` already includes the
code-span protection tokens and `file:line` auto-linking this dashboard relies on. Do NOT redefine
or re-implement them here.

### Dependency subgraph

At the top of the Graph Context section (inside the collapsible body, before the file cards),
conditionally render a Canvas-based dependency subgraph showing only the changed files and their
mutual connections.

**Render only when:** there are 2+ changed files AND at least 1 edge between them (where both
endpoints are in the changed files set). If all changed files are disconnected from each other,
omit the subgraph entirely — it would just show scattered dots with no edges.

Build the subgraph data from the `fileContextMap` (populated in Step 3b):

```javascript
const changedFiles = /* files from Stage 1 of REVIEW.md */;
const subgraphNodes = [];
const subgraphEdges = [];
const changedSet = new Set(changedFiles);

for (const filePath of changedFiles) {
  const ctx = fileContextMap[filePath];
  subgraphNodes.push({
    id: filePath,
    layer: ctx?.layer ?? 'unknown',
    changed: true,
    violation_count: ctx?.violation_count ?? 0
  });
}

// Edges between changed files only
for (const filePath of changedFiles) {
  const ctx = fileContextMap[filePath];
  if (!ctx) continue;
  for (const imp of (ctx.imports ?? [])) {
    if (changedSet.has(imp)) {
      subgraphEdges.push({ source: filePath, target: imp });
    }
  }
}

const showSubgraph = subgraphEdges.length >= 1 && subgraphNodes.length >= 2;
```

When `showSubgraph` is true, render this HTML block at the top of the Graph Context collapsible body, before the file cards:

```html
<div class="review-subgraph-section">
  <div class="review-subgraph-label">Changed Files — Dependency Map</div>
  <canvas id="review-subgraph-canvas"
          data-subgraph="{subgraphDataJson}"
          style="display: block; width: 100%; height: 300px; background: var(--bg);"></canvas>
</div>
```

Where `{subgraphDataJson}` is `JSON.stringify({ nodes: subgraphNodes, edges: subgraphEdges })` then
HTML-attribute-escaped (`&` → `&amp;`, then `"` → `&quot;`).

Each node uses `id: filePath` — this is the key used to link click events to the file card `<details>` elements below.

The subgraph renders via the shared `mcp-server/src/ui/snippets/force-graph.html` engine
(`renderForceGraph`, see Step 6 CSS + script section): it runs the force simulation (100 iterations),
normalizes the settled layout to fill the canvas, de-collides the filename labels, then draws
nodes/edges with click + hover handling. Review supplies its options (arrow edges, blue changed-node
fill, violation ring, and click-a-node → expand+scroll the matching file card).

### Changed files list

Include the changed files as part of the Graph Context section (Section G). Use the Graph Context
patterns from Section G of DESIGN-SYSTEM.md exactly:

- Wrap the entire section per Section G.3 — `<div class="grid-card" style="grid-column: 1 / -1;">` with a `<details>` collapsible wrapper
- Classify each file using Section G.2 — `isHighImpact(fileContext)` → hub shape OR violations > 0 OR blast_radius > 5
- **ALL files** use a click-to-expand `<details>` pattern:
  - **High-impact files**: `<details open id="file-card-{encodedId}">` — starts expanded
  - **Standard files**: `<details id="file-card-{encodedId}">` — starts collapsed (click to expand)
  - Where `encodedId` = collision-safe encoding of file path: replace each non-alphanumeric character `c` with `-` + `c.charCodeAt(0)` + `-` (e.g. `/` → `-47-`, `.` → `-46-`, `-` → `-45-`); alphanumeric chars pass through unchanged. This encoding is injective — different paths always produce different IDs.
  - The `<summary>` for both types shows a compact header row:
    ```html
    <summary class="file-expandable-summary">
      <span class="file-expand-arrow">&#9654;</span>
      <span class="file-summary-path">{escapeHtml(filePath)}</span>
      <span class="layer-badge" style="background: {layerColor}22; color: {layerColor}; border-color: {layerColor}44;">{escapeHtml(layer)}</span>
      <span class="file-summary-shape">{escapeHtml(shapeLabel)}</span>
    </summary>
    ```
  - The expanded body for ALL files contains the full `file-detail-card.html` snippet content
- **High-impact and standard file detail cards** use the `file-detail-card.html` snippet (Section G.4):
  - Read the snippet from `mcp-server/src/ui/snippets/file-detail-card.html`
  - Substitute all placeholders as documented in Section G.4 of DESIGN-SYSTEM.md:
    - `{{FILE_PATH}}`, `{{LAYER}}`, `{{SHAPE_LABEL}}`, `{{SHAPE_DESCRIPTION}}` — through `escapeHtml`
    - `{{LAYER_COLOR}}` — CSS color constant, no escaping
    - `{{IMPORT_COUNT}}`, `{{IMPORTED_BY_COUNT}}`, `{{IMPORT_LAYER_COUNT}}` — numeric, no escaping
    - `{{EXPORT_COUNT}}`, `{{ENTITY_TYPE_COUNT}}`, `{{ENTITY_FN_COUNT}}` — numeric, no escaping
    - `{{IMPACT_SCORE}}`, `{{IMPACT_RANK}}` — string/number, no escaping
    - `{{VIOLATION_COUNT}}` — numeric; `{{VIOLATION_BADGE_CLASS}}` = "clean" | "danger"; `{{VIOLATION_BADGE_TEXT}}` = "no violations" | "N violations"
    - `{{BLAST_RADIUS_SEVERITY}}` — severity string, no escaping; `{{BLAST_RADIUS_TOTAL}}` — numeric
    - `{{CARD_ID}}` — collision-safe encoding of file path: replace each non-alphanumeric char `c` with `-` + `c.charCodeAt(0)` + `-` (e.g. `/` → `-47-`, `.` → `-46-`, `-` → `-45-`); alphanumeric chars pass through unchanged; no HTML escaping
    - `{{GRAPH_DATA_JSON}}` — JSON-stringified GraphData object, then HTML-attribute-escaped (`&` → `&amp;`, then `"` → `&quot;`). Leaf files (0 imports AND 0 dependents) are handled automatically — the snippet script collapses the graph area to a compact empty-state. Do not omit the canvas or alter the snippet markup for leaf files.
    - `{{ENTITIES_HTML}}` — pre-rendered `<tr>` rows (see G.4 for format, limit 15 rows); when the file has no entities, emit exactly: `<tr><td colspan="4" class="fdc-empty-note">No exports detected</td></tr>`
    - `{{BLAST_RADIUS_DEPTH1_HTML}}` — pre-rendered depth-chip spans (see G.4 for format, limit 8 chips); when there are no depth-1 dependents, emit exactly: `<span class="fdc-empty-note">No dependents</span>`
  - Extract the `<style>` block from the snippet and include it in the page `<style>` tag (once)
  - Extract the `<script>` block from the snippet and include it **ONCE** before `</body>` (not per card)
- **Note**: `file-summary-card.html` is no longer used for the card body — the `<summary>` row above replaces it. The `.file-summary-path` and `.file-summary-shape` styles from that snippet are included in the expandable pattern CSS (Step 6). You do NOT need to read `file-summary-card.html`.
- This means the renderer now prepares `file-detail-card.html` data for EVERY changed file (not just high-impact ones). The data is already fetched in Step 3b.

### Blast radius dependency tree

Render the blast radius as a **dependency tree/graph view** instead of concentric rings. Use
**per-file blast radius data from `get_file_context`** (Step 3b) — NOT the global
`show_pr_impact blastRadius.affected` array, which lacks source attribution and cannot map
affected files back to specific changed-file roots.

Place it as a full-width row after the Graph Context section. Read the snippet from
`mcp-server/src/ui/snippets/blast-radius-tree.html` and substitute placeholders:

- `{{TOTAL_AFFECTED}}` — total count of affected files (number, no escaping needed)
- `{{TREE_GROUPS_HTML}}` — pre-rendered group HTML (escapeHtml all text content within)

Extract the `<style>` block from the snippet and include it in the page `<style>` tag.

**Data aggregation rules:**
- Root nodes = the changed files from the diff (from Stage 1 of REVIEW.md)
- Per-root dependents come from `fileContextMap[changedFile].blast_radius.affected` — this is
  source-aware data that maps each affected file back to its specific changed-file root
- Depth-1 dependents = entries with `depth === 1` in the per-file blast radius
- Show up to 8 depth-1 dependents per changed file; if more, show the 8 with highest depth-count, then add "+N more at depth 1"
- Count depth-2+ files per root and add a single summary row "+N more at depth 2+"
- The last edge connector in each group uses `└──` (&#9492;&#9472;&#9472;) instead of `├──` (&#9500;&#9472;&#9472;)
- Use the global `show_pr_impact blastRadius` for aggregate stats only (total affected count in the section title)
- When a changed file has no blast radius data (leaf node), omit it from the tree entirely
- When ALL changed files are leaf nodes, omit the entire dependency tree section

## Step 6 — Apply Section F.14 CSS verbatim

Copy the full CSS from Section F.14 into the `<style>` tag, after the Section A design tokens.
Do not abbreviate or omit any CSS rule.

Also add CSS for:
- Reviewer narrative panel and collapsible section (from Section C)
- File detail card styles (extracted from `file-detail-card.html` snippet `<style>` block)
- Dependency tree CSS (extracted from `blast-radius-tree.html` snippet `<style>` block)
- Narrative content typography (copy verbatim):

```css
.narrative-content h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; color: var(--text); }
.narrative-content h4 { font-size: 13px; font-weight: 600; margin: 12px 0 6px; color: var(--text-secondary); }
.narrative-content p { margin: 8px 0; font-size: 12px; line-height: 1.6; color: var(--text); }
.narrative-content ul, .narrative-content ol { margin: 8px 0; padding-left: 20px; }
.narrative-content li { font-size: 12px; line-height: 1.6; color: var(--text); margin: 4px 0; }
.narrative-content code { background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.narrative-content .table-scroll-wrapper { margin: 12px 0; }
.narrative-content .requirement-table td, .narrative-content .requirement-table th { font-size: 11px; padding: 6px 10px; }
```

- Expandable file card pattern CSS (copy verbatim):

```css
.file-expandable-summary {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  cursor: pointer; list-style: none; user-select: none;
  background: var(--bg-surface); border-radius: 4px; margin-bottom: 4px;
}
.file-expandable-summary::-webkit-details-marker { display: none; }
.file-expand-arrow {
  font-size: 8px; color: var(--text-muted); transition: transform 0.15s; flex-shrink: 0;
}
details[open] > .file-expandable-summary .file-expand-arrow { transform: rotate(90deg); }
.file-expandable-summary .file-summary-path {
  flex: 1; font-family: monospace; font-size: 11px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.file-expandable-summary .file-summary-shape {
  font-size: 10px; color: var(--text-muted); font-style: italic; flex-shrink: 0;
}
.review-subgraph-section {
  margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 12px;
}
.review-subgraph-label {
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em; padding: 0 0 8px;
}
```

Include before `</body>` (in this order):
1. The `<script>` block from `file-detail-card.html` (Canvas graph initialization for detail cards)
2. The shared force-directed-graph engine and the subgraph init call — only when `showSubgraph` is true:

**2a. Emit the shared engine snippet `<script>` verbatim (ONCE).** Read
`mcp-server/src/ui/snippets/force-graph.html` and include its `<script>` block verbatim exactly
once, immediately after the `file-detail-card.html` script and before `</body>`. Do NOT re-implement
the force-simulation math inline — it now lives only in `force-graph.html`. Mirror how the
`file-detail-card.html` snippet `<script>` is already emitted (read the snippet, paste its `<script>`
verbatim, do not edit it). If `force-graph.html` has a `<style>` block, include it once in the page
`<style>` tag as well.

**2b. Emit the subgraph init script** that adapts the already-built subgraph data to the engine and
calls `renderForceGraph` with review's options (copy verbatim):

```javascript
(function () {
  // ── Design token mapping (Canvas 2D cannot use CSS custom properties) ──
  // The hex values below correspond to DESIGN-SYSTEM.md Section A tokens:
  //   #6c8cff  → var(--accent)  — changed file nodes (review's nodeFill)
  // The remaining Canvas colors (edges, labels, violation ring, tooltip) live in the
  // shared force-graph.html engine and carry their own /* --token */ comments there.
  var canvas = document.getElementById('review-subgraph-canvas');
  if (!canvas) return;
  // The subgraph data may be provided via the data-subgraph attribute or as an inline
  // object; read whichever the page emitted. Node `id` keys are file paths — the same
  // keys onNodeClick uses to find the matching <details id="file-card-{encodedId}"> card.
  var raw = canvas.getAttribute('data-subgraph');
  var data;
  try { data = raw ? JSON.parse(raw) : { nodes: [], edges: [] }; } catch (e) { return; }
  var nodes = data.nodes || [];
  var edges = data.edges || [];
  if (nodes.length === 0) return;

  renderForceGraph(
    canvas,
    { nodes: nodes, edges: edges },
    {
      height: 300,
      iterations: 100,
      edgeStyle: 'arrow',
      drawLabels: true,
      showViolationRing: true,
      nodeFill: function (n) { return /* --accent */ '#6c8cff'; },
      onNodeClick: function (n) {
        var encodedId = n.id.replace(/[^a-zA-Z0-9]/g, function (c) { return '-' + c.charCodeAt(0) + '-'; });
        var cardEl = document.getElementById('file-card-' + encodedId);
        if (cardEl) {
          cardEl.open = true;
          cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  );
})();
```

This preserves review's existing behaviors — blue changed-node fill, violation red ring, straight
arrow edges, and click-a-node → expand+scroll the matching `<details id="file-card-{encodedId}">` —
while inheriting the engine's balanced gravity, normalize-to-fit framing, and label de-collision.

IMPORTANT: Canvas 2D does not support CSS variables. Every hex color value in any Canvas script
MUST be preceded by a comment naming the design token it maps to:
  nodeFill: function (n) { return /* --accent */ '#6c8cff'; };
This satisfies the design-tokens-as-style-contract convention for Canvas contexts. The shared
`force-graph.html` engine already annotates all of its own Canvas hex literals.

## Step 7 — Security

Apply `escapeHtml` to ALL content extracted from REVIEW.md or returned by MCP tools before
embedding in HTML. This includes: file paths, principle IDs, violation messages, layer names,
subsystem directories, and entity names.

**Exception**: The reviewer narrative is processed through `markdownToHtml()` (Step 4), which
escapes raw text internally before wrapping in HTML tags. Do not double-escape by calling
`escapeHtml()` on the narrative before passing it to `markdownToHtml()`.

Use the canonical `escapeHtml` and `markdownToHtml` defined in
`mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` Section E (Security Requirements) — which you read
in Step 1. Copy those definitions verbatim into your build-time rendering script (use the runtime
null-safe `escapeHtml` form noted there). Do NOT redefine or re-implement them here.

Color constants, CSS property values, and numeric values do not need escaping.

## Step 8 — Write output

Write the complete, self-contained HTML to:
  ${WORKSPACE}/artifacts/review.html

The file must be fully self-contained (no external stylesheets, no JavaScript, no CDN links).
All CSS is inline in the `<style>` tag. Proceed to Step 9 before returning.

## Step 9 — Structural self-check (MANDATORY)

After writing the file in Step 8, run these checks before returning. These checks verify the
output because instruction-following alone has failed before (style block silently omitted →
garbled cards). This converts the fidelity contract from trust-based to verified.

Run each grep command against the written `${WORKSPACE}/artifacts/review.html` and verify the
expected result. The variable `N` in check 1 equals the number of changed files in the diff.

> Note: `grep -c` counts *lines* containing a match, not total occurrences. For exact-once
> assertions (checks 3 and 4) use `grep -o ... | wc -l` so that a multi-occurrence line cannot
> slip through as a single count.

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | One card per changed file | `grep -c 'class="file-detail-card"' review.html` | equals changed-file count |
| 2 | Snippet CSS present | `grep -c '\.fdc-metric-card' review.html` | >= 1 |
| 3 | Card script present exactly once | `grep -o 'function drawFileGraph(' review.html \| wc -l` | == 1 |
| 4a | Force-graph engine not duplicated (always) | `grep -o 'function renderForceGraph(' review.html \| wc -l` | <= 1 |
| 4b | Force-graph engine present when subgraph rendered | `grep -o 'function renderForceGraph(' review.html \| wc -l` | == 1 if `showSubgraph` was true; == 0 if `showSubgraph` was false |
| 5 | Design token defined | `grep -c -- '--bg-card:' review.html` | >= 1 |

The trailing `(` in checks 3 and 4a/4b anchors the match to the function declaration form.
Narrative text that mentions a function name in prose (e.g. "calls `drawFileGraph`") does NOT
carry the open-paren immediately after the name and therefore does not match. The rare case where
a reviewer narrative includes a complete function signature with arguments (e.g.,
`` `function drawFileGraph(canvas)` `` inside a code span) will match — this is a true collision,
not a false positive. Resolve it by entity-escaping only the narrative occurrence (e.g.,
`&#102;unction drawFileGraph(`) while leaving the `<script>` block untouched.

**Failure protocol**: If ANY check fails, the composed HTML violated the snippet fidelity
contract. Fix the composed HTML (re-read the snippet file, re-extract the missing block) and
re-write the file, then re-run ALL checks. For check 4b specifically: only trigger the repair
loop when `showSubgraph` was true and the count is 0 (missing engine), or when the count
exceeds 1 (duplicated engine). A count of 0 when `showSubgraph` was false is correct — do NOT
inject the engine. Never alter the `<script>` block to satisfy a count; resolve narrative
collisions in the narrative text. Do NOT return until every check passes.

Return when all checks pass. Do not modify the worktree.
````

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- This is the ONLY renderer template that requires MCP tool calls (show_pr_impact, get_context)
- The reviewer narrative is NOT optional — the template explicitly marks it as REQUIRED
- The reviewer narrative appears immediately after the verdict banner (before stats row)
- Read Sections F and G from DESIGN-SYSTEM.md; do not reconstruct patterns from memory
- Read `file-detail-card.html` and `blast-radius-tree.html` for snippet HTML/CSS — do NOT write your own card markup
- `file-summary-card.html` is no longer used in the Graph Context section — the expandable `<summary>` row replaces it
- `file-detail-card.html` is used for ALL changed files (not just high-impact ones) in the expanded `<details>` body
- `file-detail-card.html` uses a Canvas-based dependency graph — include its `<script>` block once before `</body>`
- The subgraph Canvas script (Step 6) goes after the file-detail-card script, also before `</body>`
- The Graph Context section dependency subgraph is conditional: only rendered when 2+ changed files have at least 1 mutual edge
- Click a subgraph node → expands and scrolls to the corresponding `<details id="file-card-{encodedId}">` element
- The blast radius visualization uses a dependency tree (per-file roots), NOT concentric SVG rings
- Dependency tree uses per-file `get_file_context().blast_radius` data for source-aware root→dependent mapping
- Do NOT reference Section H of DESIGN-SYSTEM.md — it describes the old rings pattern which is no longer used
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If REVIEW.md does not exist at `${WORKSPACE}/reviews/REVIEW.md`, report failure and stop
- Do NOT render empty sections — only render sections that have data to display
