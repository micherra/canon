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

## Prompt

````
You are a renderer agent. Your sole job is to convert the review markdown and live graph
data into a self-contained HTML dashboard and write it to ${WORKSPACE}/artifacts/review.html.
Do NOT modify the worktree.

## Step 1 — Read source files

Read these files:
1. ${WORKSPACE}/reviews/REVIEW.md — the reviewer's output (your primary narrative source)
2. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — the design system reference

Read all sections of DESIGN-SYSTEM.md before composing. You will use:
- Section A (CSS tokens) — copy verbatim into your <style> tag
- Section F (Review Dashboard Patterns) — full layout, all subsections F.1–F.14
- Section G (Graph Context Patterns) — file detail and summary cards

Also read these snippet files for file card HTML and CSS:
- mcp-server/src/ui/snippets/file-detail-card.html — full card HTML + CSS for high-impact files
- mcp-server/src/ui/snippets/file-summary-card.html — compact card HTML + CSS for standard files

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
  diff_base: "${BASE_COMMIT}"
})
```

From the result, extract:
- `filesChanged` — total files changed count
- `blastRadius.affected` — array of `{ entity_name, entity_kind, file_path, depth }`
- `blastRadius.by_depth` — record of depth → file count
- `layers` — breakdown of changes by layer
- `subsystems` — new or removed subsystems
- `pr_metrics` — any PR-level metrics (lines added/removed, etc.)

### 3b. get_file_context (per changed file)

For each file in the diff (from Stage 1 of REVIEW.md), call:

```
mcp__canon__get_file_context({ file_path: "{file}" })
```

From each result, extract:
- `layer` — the layer this file belongs to
- `shape.label` — graph shape (e.g., "Central hub", "High fan-out hub", "Sink", "Standard")
- `shape.description` — shape description
- `imports` — list of files this file imports
- `imported_by` — list of files that import this file
- `in_degree` — number of files that import this file
- `impact_score` — normalized impact score (0–1)
- `blast_radius.summary.total_files` — total downstream files affected
- `blast_radius.affected` — per-file array of downstream dependents (used for dependency tree roots)
- `computed_tags` — computed tags for this file
- `violation_count` — number of active violations on this file (if available)

Collect results into a map: `fileContextMap[filePath] = fileContextResult`.

If `get_file_context` fails for a file, skip it — do not block rendering.

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
3. **Stats row** (Section F.4) — 4 stat cards
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
    <div class="collapsible-body" style="white-space: pre-wrap; font-size: 12px; color: var(--text); line-height: 1.6;">
      {escapeHtml(reviewerNarrative)}
    </div>
  </details>
</div>
```

The narrative starts open (`<details open>`). Render ALL narrative text — code quality analysis,
advisory items, gotcha documentation. Do not summarize or truncate.

### Changed files list

Include the changed files as part of the Graph Context section (Section G). Use the Graph Context
patterns from Section G of DESIGN-SYSTEM.md exactly:

- Wrap the entire section per Section G.3 — `<div class="grid-card" style="grid-column: 1 / -1;">` with a `<details>` collapsible wrapper
- Classify each file using Section G.2 — `isHighImpact(fileContext)` → hub shape OR violations > 0 OR blast_radius > 5
- **High-impact files** get full **detail cards** from the `file-detail-card.html` snippet (Section G.4):
  - Read the snippet from `mcp-server/src/ui/snippets/file-detail-card.html`
  - Substitute: `{{FILE_PATH}}`, `{{LAYER}}`, `{{LAYER_COLOR}}`, `{{SHAPE_LABEL}}`, `{{SHAPE_DESCRIPTION}}`, `{{IMPORT_COUNT}}`, `{{IMPORTED_BY_COUNT}}`, `{{ENTITY_COUNT}}`, `{{BLAST_RADIUS_TOTAL}}`, `{{IMPORTS_HTML}}`, `{{IMPORTED_BY_HTML}}`, `{{ENTITIES_HTML}}`
  - All string placeholders through `escapeHtml`; `{{LAYER_COLOR}}` is a CSS color constant — no escaping needed
  - Extract and include the `<style>` block from the snippet
- **Standard files** get compact **summary cards** from the `file-summary-card.html` snippet (Section G.5):
  - Read the snippet from `mcp-server/src/ui/snippets/file-summary-card.html`
  - Substitute: `{{FILE_PATH}}`, `{{LAYER}}`, `{{LAYER_COLOR}}`, `{{SHAPE_LABEL}}`
  - Extract and include the `<style>` block from the snippet (deduplicate `.layer-badge` if both snippets used)
- Both card types are expandable via `<details>` elements wrapping the card body content — high-impact cards should use `<details open>` so they start expanded; summary cards use `<details>` (closed by default)

### Blast radius dependency tree

Render the blast radius as a **dependency tree/graph view** instead of concentric rings. Use
**per-file blast radius data from `get_file_context`** (Step 3b) — NOT the global
`show_pr_impact blastRadius.affected` array, which lacks source attribution and cannot map
affected files back to specific changed-file roots.

Place it as a full-width row after the Graph Context section:

```html
<div class="grid-card" style="grid-column: 1 / -1; margin-top: 8px;">
  <details class="collapsible-section">
    <summary class="collapsible-summary">
      <span class="collapsible-arrow">&#9654;</span>
      <span class="collapsible-title">Blast Radius — Dependency Tree ({totalAffected} affected files)</span>
    </summary>
    <div class="collapsible-body">
      <div class="dep-tree">
        <!-- For each changed file as a root node: -->
        <div class="dep-tree-group">
          <div class="dep-tree-root">{escapeHtml(changedFile)}</div>
          <div class="dep-tree-edges">
            <!-- For each depth-1 dependent (from fileContextMap[changedFile].blast_radius.affected): -->
            <div class="dep-tree-edge">
              <div class="dep-tree-connector">&#9500;&#9472;&#9472;</div>
              <div class="dep-tree-node">
                <span class="dep-tree-name">{escapeHtml(basename(dependent.file_path))}</span>
                <span class="layer-badge" style="background: {layerColor}22; color: {layerColor}; border-color: {layerColor}44;">{escapeHtml(dependent.layer)}</span>
              </div>
            </div>
            <!-- If depth-2+ dependents exist, summarize: -->
            <div class="dep-tree-edge">
              <div class="dep-tree-connector">&#9492;&#9472;&#9472;</div>
              <div class="dep-tree-node dep-tree-node--summary">+{depth2Count} more at depth 2+</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </details>
</div>
```

CSS for the dependency tree (add to the `<style>` tag):

```css
/* Dependency tree */
.dep-tree { display: flex; flex-direction: column; gap: 16px; }
.dep-tree-group { display: flex; flex-direction: column; gap: 4px; }
.dep-tree-root {
  font-family: monospace;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-bright);
  padding: 6px 10px;
  background: var(--accent-soft, rgba(108,140,255,0.12));
  border: 1px solid var(--accent, #6c8cff);
  border-radius: 6px;
  display: inline-block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dep-tree-edges { display: flex; flex-direction: column; gap: 3px; padding-left: 16px; margin-top: 4px; }
.dep-tree-edge { display: flex; align-items: center; gap: 6px; }
.dep-tree-connector { font-family: monospace; font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
.dep-tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 3px 8px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  min-width: 0;
}
.dep-tree-name {
  font-family: monospace;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dep-tree-node--summary {
  color: var(--text-muted);
  font-style: italic;
  background: transparent;
  border-color: transparent;
}
```

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
- File detail and summary card styles (extracted from `file-detail-card.html` and `file-summary-card.html` snippet `<style>` blocks)
- Dependency tree CSS (from the "Blast radius dependency tree" section above)

## Step 7 — Security

Apply `escapeHtml` to ALL content extracted from REVIEW.md or returned by MCP tools before
embedding in HTML. This includes: file paths, principle IDs, violation messages, narrative text,
layer names, subsystem directories, and entity names.

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

Color constants, CSS property values, and numeric values do not need escaping.

## Step 8 — Write output

Write the complete, self-contained HTML to:
  ${WORKSPACE}/artifacts/review.html

The file must be fully self-contained (no external stylesheets, no JavaScript, no CDN links).
All CSS is inline in the `<style>` tag.

Return when the file is written. Do not modify the worktree.
````

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- This is the ONLY renderer template that requires MCP tool calls (show_pr_impact, get_file_context)
- The reviewer narrative is NOT optional — the template explicitly marks it as REQUIRED
- The reviewer narrative appears immediately after the verdict banner (before stats row)
- Read Sections F and G from DESIGN-SYSTEM.md; do not reconstruct patterns from memory
- Read `file-detail-card.html` and `file-summary-card.html` for file card HTML/CSS — do NOT write your own card markup
- The blast radius visualization uses a dependency tree (per-file roots), NOT concentric SVG rings
- Dependency tree uses per-file `get_file_context().blast_radius` data for source-aware root→dependent mapping
- Do NOT reference Section H of DESIGN-SYSTEM.md — it describes the old rings pattern which is no longer used
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If REVIEW.md does not exist at `${WORKSPACE}/reviews/REVIEW.md`, report failure and stop
- Do NOT render empty sections — only render sections that have data to display
