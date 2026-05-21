---
template: renderer-review
description: Renderer spawn prompt for converting the review markdown + live MCP data into review.html
used-by: [orchestrator]
read-by: [renderer-agent]
output-path: ${WORKSPACE}/artifacts/review.html
model: sonnet
---

# Template: Renderer — Review Dashboard

Use this template when spawning the renderer agent after the reviewer step completes.

The orchestrator reads this template, fills in the variable placeholders, and passes the
result as the renderer agent's spawn prompt.

> **Model note**: Spawn this renderer with `model: "sonnet"` (not Haiku). This template
> requires MCP tool calls + snippet composition + complex HTML assembly — Haiku exhausts
> its context budget before reaching the Graph Context sections.

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

## SNIPPET FIDELITY RULE

For file-summary-card sections: read the snippet file, substitute {{PLACEHOLDER}} values,
and use the result verbatim. For file-detail-card sections: use the simplified inline HTML
template defined in Step 5 (the full 790-line snippet has too many placeholders for reliable
substitution — the inline template captures the same visual pattern with ~50 lines).

## Step 1 — Read source files

Read these files:
1. ${WORKSPACE}/reviews/REVIEW.md — the reviewer's output (your primary narrative source)
2. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — the design system reference
3. mcp-server/src/ui/snippets/file-summary-card.html — compact card HTML + CSS for standard files
4. mcp-server/src/ui/snippets/blast-radius-tree.html — dependency tree HTML + CSS

Read all sections of DESIGN-SYSTEM.md before composing. You will use:
- Section A (CSS tokens) — copy verbatim into your <style> tag
- Section F (Review Dashboard Patterns) — full layout, all subsections F.1–F.14
- Section G (Graph Context Patterns) — file detail and summary card patterns

Do NOT duplicate the patterns inline. Read them from DESIGN-SYSTEM.md and the snippet files
and apply them. For file-detail-card, use the inline template in Step 5 instead of the
790-line snippet file.

## Step 2 — Call MCP tools for live graph data

Call these two MCP tools immediately after reading source files, before parsing the review
markdown. Calling them early keeps the data fresh in context throughout composition.

### 2a. show_pr_impact

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

### 2b. get_context (all changed files, batched)

From the REVIEW.md you already read, identify the changed files list (Stage 1), then make
a single batched call:

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

## Step 3 — Parse the review markdown

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
3. **Graph Context section** (Section G) — full-width collapsible card with file detail and
   summary cards (moved up from position 5 so MCP data is still fresh in context)
4. **Blast Radius Dependency Tree** — full-width collapsible card (see below) — **omit entirely
   if blast radius data is empty**
5. **Stats row** (Section F.4) — 4 stat cards
6. **Dashboard grid** (Section F.5) — 2-column grid, conditional cards:
   - Row 1 left: "Fix Before Merge" (Section F.6) — **omit entirely if 0 violations**; instead
     render a compact "No violations — looking good." success banner below the stats row
   - Row 1 right: "Violations by Principle" (Section F.7) + "Compliance Score" (Section F.8)
     stacked — **omit "Violations by Principle" if 0 violations**
   - Row 2 left: "Highest Blast Radius" (Section F.9) — **omit entirely if blast radius data
     is empty** (all files are leaf nodes with 0 downstream deps; `blastFiles` is empty or all
     have depCount === 0)
   - Row 2 right: "Changes by Layer" (Section F.10) — **omit if layerData is empty**;
     "New Subsystems" (Section F.11) stacked below — **omit if subsystemData is empty**

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

Place it as a full-width panel immediately after the verdict banner, before the Graph Context
section:

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

Implement `markdownToHtml` inline in your rendering script. This function handles the reviewer
narrative section only — headings, lists, paragraphs, and inline formatting. Tables and fenced
code blocks in other review sections (violation tables, acceptance criteria grids) are rendered
by their own dedicated section handlers, not by this function. The function must convert:

```javascript
function markdownToHtml(md) {
  const lines = String(md ?? "").split("\n");
  const output = [];
  let listType = null; // "ul" | "ol" | null

  function closeList() {
    if (listType) { output.push(`</${listType}>`); listType = null; }
  }

  for (const raw of lines) {
    const line = raw;

    // Blank line — close open list
    if (line.trim() === "") {
      closeList();
      continue;
    }

    // ### heading
    if (line.startsWith("### ")) {
      closeList();
      output.push(`<h3>${escapeHtml(line.slice(4).trim())}</h3>`);
      continue;
    }

    // #### heading
    if (line.startsWith("#### ")) {
      closeList();
      output.push(`<h4>${escapeHtml(line.slice(5).trim())}</h4>`);
      continue;
    }

    // - list item (unordered)
    if (/^[-*] /.test(line)) {
      if (listType !== "ul") { closeList(); output.push("<ul>"); listType = "ul"; }
      output.push(`<li>${inlineFormat(line.slice(2).trim())}</li>`);
      continue;
    }

    // Numbered list item (1. item)
    if (/^\d+\. /.test(line)) {
      if (listType !== "ol") { closeList(); output.push("<ol>"); listType = "ol"; }
      output.push(`<li>${inlineFormat(line.replace(/^\d+\. /, "").trim())}</li>`);
      continue;
    }

    // Regular paragraph line
    closeList();
    output.push(`<p>${inlineFormat(line.trim())}</p>`);
  }

  closeList();
  return output.join("\n");
}

// Apply inline formatting: **bold**, `code`, and file:line references
function inlineFormat(text) {
  let s = escapeHtml(text);
  // Protect code spans first — replace with tokens to prevent bold/file-ref inside them
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (_, content) => {
    codeSpans.push(`<code>${content}</code>`);
    return `\x00CODE${codeSpans.length - 1}\x00`;
  });
  // **bold** — safe now, won't match inside code tokens
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // file paths with :line — safe now, won't match inside code tokens
  s = s.replace(/([\w./\-]+\.(?:ts|js|py|go|rs|md):\d+)/g, "<code>$1</code>");
  // Restore code spans
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeSpans[i]);
  return s;
}
```

### Graph Context section

Include the changed files as a Graph Context section (Section G). Place it immediately after
the reviewer narrative panel.

> **Fallback rule**: If `fileContextMap` is empty (MCP data unavailable), render the
> Section G.6 empty state from DESIGN-SYSTEM.md. Do NOT skip the section entirely — always
> render either full file cards or the empty state.

Wrap the entire section per Section G.3:

```html
<div class="grid-card" style="grid-column: 1 / -1; margin-top: 8px;">
  <details class="collapsible-section" open>
    <summary class="collapsible-summary">
      <span class="collapsible-arrow">&#9654;</span>
      <span class="collapsible-title">Graph Context — Changed Files (N files)</span>
    </summary>
    <div class="collapsible-body">
      <!-- file cards go here -->
    </div>
  </details>
</div>
```

Classify each file using Section G.2 — `isHighImpact(fileContext)` → hub shape OR
violations > 0 OR blast_radius total > 5.

**High-impact files** get a simplified detail card (inline template below — do NOT read
`file-detail-card.html` for this). Render one card per high-impact file:

```html
<div class="fdc-card" id="fdc-{CARD_ID}" style="border: 1px solid var(--border); border-radius: 6px; margin-bottom: 12px; overflow: hidden;">
  <!-- Header -->
  <div style="display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-subtle);">
    <span style="font-family: monospace; font-size: 12px; font-weight: 600; color: var(--text-bright); flex: 1;">{FILE_PATH}</span>
    <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: {LAYER_COLOR}22; color: {LAYER_COLOR}; border: 1px solid {LAYER_COLOR}44;">{LAYER}</span>
    <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; {VIOLATION_BADGE_STYLE}">{VIOLATION_BADGE_TEXT}</span>
  </div>
  <!-- Stat row: 4 metric cards -->
  <div style="display: flex; gap: 8px; padding: 10px 14px; background: var(--bg-card); border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap;">
    <div style="flex: 1; min-width: 80px; text-align: center; padding: 6px; border: 1px solid var(--border-subtle); border-radius: 4px;">
      <div style="font-size: 18px; font-weight: 700; color: var(--text-bright);">{IMPORT_COUNT}</div>
      <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Imports</div>
    </div>
    <div style="flex: 1; min-width: 80px; text-align: center; padding: 6px; border: 1px solid var(--border-subtle); border-radius: 4px;">
      <div style="font-size: 18px; font-weight: 700; color: var(--text-bright);">{IMPORTED_BY_COUNT}</div>
      <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Referenced by</div>
    </div>
    <div style="flex: 1; min-width: 80px; text-align: center; padding: 6px; border: 1px solid var(--border-subtle); border-radius: 4px;">
      <div style="font-size: 18px; font-weight: 700; color: var(--text-bright);">{EXPORT_COUNT}</div>
      <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Exports</div>
    </div>
    <div style="flex: 1; min-width: 80px; text-align: center; padding: 6px; border: 1px solid var(--border-subtle); border-radius: 4px;">
      <div style="font-size: 18px; font-weight: 700; color: var(--text-bright);">{IMPACT_SCORE}</div>
      <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Impact score</div>
    </div>
  </div>
  <!-- Canvas dependency graph -->
  <div style="padding: 10px 14px; background: var(--bg-card);">
    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">
      <span style="display: inline-flex; align-items: center; gap: 4px; margin-right: 12px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #7F77DD; display: inline-block;"></span>this file
      </span>
      <span style="display: inline-flex; align-items: center; gap: 4px; margin-right: 12px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #888780; display: inline-block;"></span>depends on
      </span>
      <span style="display: inline-flex; align-items: center; gap: 4px; margin-right: 12px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #1D9E75; display: inline-block;"></span>used by
      </span>
      <span style="display: inline-flex; align-items: center; gap: 4px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #EF9F27; display: inline-block;"></span>cross-layer
      </span>
    </div>
    <canvas id="fdc-canvas-{CARD_ID}" width="600" height="160"
      data-graph="{GRAPH_DATA_JSON}"
      style="width: 100%; height: 160px; display: block; border-radius: 4px; background: var(--bg-secondary);"></canvas>
  </div>
  <!-- Shape badge -->
  <div style="padding: 6px 14px 10px; font-size: 11px; color: var(--text-muted);">
    <strong>{SHAPE_LABEL}</strong> — {SHAPE_DESCRIPTION}
  </div>
</div>
```

Placeholder values for the inline card template:
- `{FILE_PATH}` — `escapeHtml(filePath)`
- `{CARD_ID}` — file path with non-alphanumeric chars replaced by `-` (no escaping)
- `{LAYER}` — `escapeHtml(fileContext.layer)`
- `{LAYER_COLOR}` — CSS color constant from DESIGN-SYSTEM.md layer color table (no escaping)
- `{VIOLATION_BADGE_STYLE}` — `"background: #fdf2f2; color: #c0392b; border: 1px solid #e74c3c;"` if violations > 0; else `"background: #eafaf1; color: #27ae60; border: 1px solid #27ae60;"`
- `{VIOLATION_BADGE_TEXT}` — `"N violations"` if violations > 0; else `"no violations"`
- `{IMPORT_COUNT}` — `fileContext.imports.length ?? 0` (numeric, no escaping)
- `{IMPORTED_BY_COUNT}` — `fileContext.imported_by.length ?? 0` (numeric, no escaping)
- `{EXPORT_COUNT}` — `fileContext.exports.length ?? 0` (numeric, no escaping)
- `{IMPACT_SCORE}` — `(fileContext.impact_score ?? 0).toFixed(2)` (string, no escaping)
- `{GRAPH_DATA_JSON}` — JSON-stringified object `{ imports, imported_by, exports, layer, crossLayerImports: [], crossLayerDependents: [], fileName }` then HTML-attribute-escaped (`&` → `&amp;`, then `"` → `&quot;`)
- `{SHAPE_LABEL}` — `escapeHtml(fileContext.shape?.label ?? "Standard")`
- `{SHAPE_DESCRIPTION}` — `escapeHtml(fileContext.shape?.description ?? "")`

The canvas graph initialization script uses the same pattern as `file-detail-card.html` —
include the `<script>` block from `mcp-server/src/ui/snippets/file-detail-card.html` ONCE
before `</body>` (it reads `data-graph` attributes from all `fdc-canvas-*` canvases).

**Standard files** get compact **summary cards** from the `file-summary-card.html` snippet:

- Read the snippet from `mcp-server/src/ui/snippets/file-summary-card.html`
- Substitute: `{{FILE_PATH}}`, `{{LAYER}}`, `{{LAYER_COLOR}}`, `{{SHAPE_LABEL}}`
- Extract and include the `<style>` block from the snippet once in the page `<style>` tag

Both card types: high-impact cards start expanded (`<details open>`); summary cards start
collapsed (`<details>`).

> **Fallback**: If you cannot produce a file card (MCP data absent for that file or snippet
> unreadable), render a minimal row:
> ```html
> <div style="padding: 8px 14px; font-family: monospace; font-size: 12px; color: var(--text-muted); border-bottom: 1px solid var(--border-subtle);">{FILE_PATH} — graph data unavailable</div>
> ```
> Do NOT skip the file entirely — always render at minimum this fallback row.

### Blast radius dependency tree

Render the blast radius as a **dependency tree/graph view** instead of concentric rings.
Place it immediately after the Graph Context section (before stats row).

> **Fallback rule**: If blast radius data is empty (all changed files are leaf nodes), omit
> this section entirely — do NOT render an empty tree. If the snippet cannot be read, render
> the Section G.6 empty state from DESIGN-SYSTEM.md. Do NOT skip silently.

Use **per-file blast radius data from `fileContextMap`** (Step 2b) — NOT the global
`show_pr_impact blastRadius.affected` array, which lacks source attribution and cannot map
affected files back to specific changed-file roots.

Read the snippet from `mcp-server/src/ui/snippets/blast-radius-tree.html` and substitute
placeholders:

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
- File summary card styles (extracted from `file-summary-card.html` snippet `<style>` block)
- Dependency tree CSS (extracted from `blast-radius-tree.html` snippet `<style>` block)
- Narrative content typography (copy verbatim):

```css
.narrative-content h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; color: var(--text); }
.narrative-content h4 { font-size: 13px; font-weight: 600; margin: 12px 0 6px; color: var(--text-secondary); }
.narrative-content p { margin: 8px 0; font-size: 12px; line-height: 1.6; color: var(--text); }
.narrative-content ul, .narrative-content ol { margin: 8px 0; padding-left: 20px; }
.narrative-content li { font-size: 12px; line-height: 1.6; color: var(--text); margin: 4px 0; }
.narrative-content code { background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
```

Include the `<script>` block from `file-detail-card.html` **ONCE** before `</body>` (Canvas
graph initialization for all `fdc-canvas-*` elements).

## Step 7 — Security

Apply `escapeHtml` to ALL content extracted from REVIEW.md or returned by MCP tools before
embedding in HTML. This includes: file paths, principle IDs, violation messages, layer names,
subsystem directories, and entity names.

**Exception**: The reviewer narrative is processed through `markdownToHtml()` (Step 3), which
escapes raw text internally before wrapping in HTML tags. Do not double-escape by calling
`escapeHtml()` on the narrative before passing it to `markdownToHtml()`.

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

- **Model**: Spawn this renderer with `model: "sonnet"` (not Haiku). MCP tool calls + complex
  HTML assembly exceed Haiku's practical context budget, causing Graph Context sections to be
  silently dropped.
- Variable substitution is the orchestrator's responsibility before passing to Agent()
- This is the ONLY renderer template that requires MCP tool calls (show_pr_impact, get_context)
- MCP tools are called in Step 2 (before parsing) so data stays fresh through composition
- The reviewer narrative is NOT optional — the template explicitly marks it as REQUIRED
- **Composition order**: verdict banner → reviewer narrative → Graph Context → Blast Radius Tree → stats row → dashboard grid. Graph Context and Blast Radius Tree come immediately after the narrative so MCP data is still in active context.
- For high-impact files: use the simplified inline card template in Step 5 (NOT the 790-line `file-detail-card.html` snippet which has 20+ placeholders — too complex for reliable substitution)
- For standard files: use the `file-summary-card.html` snippet (only 4 placeholders — simple enough)
- `file-detail-card.html` canvas `<script>` block must still be included ONCE before `</body>` (reads `data-graph` attributes from inline card canvases)
- The blast radius visualization uses a dependency tree (per-file roots), NOT concentric SVG rings
- Dependency tree uses per-file `get_context` blast_radius data for source-aware root→dependent mapping
- Do NOT reference Section H of DESIGN-SYSTEM.md — it describes the old rings pattern which is no longer used
- Every section with complex data has an explicit fallback instruction — always render the empty state rather than skipping the section silently
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If REVIEW.md does not exist at `${WORKSPACE}/reviews/REVIEW.md`, report failure and stop
- Do NOT render empty sections — only render sections that have data to display
