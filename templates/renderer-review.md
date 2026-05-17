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

```
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
- Section H (Blast Radius Rings Patterns) — concentric rings visualization

Do NOT duplicate the patterns inline. Read them from DESIGN-SYSTEM.md and apply them.

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
  base_commit: "${BASE_COMMIT}"
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

Assemble in this order:

1. **Verdict banner** (Section F.3) — full-width, no container
2. **Stats row** (Section F.4) — 4 stat cards
3. **Dashboard grid** (Section F.5) — 2-column grid, 4 cards:
   - Row 1 left: "Fix Before Merge" (Section F.6)
   - Row 1 right: "Violations by Principle" (Section F.7) + "Compliance Score" (Section F.8) stacked
   - Row 2 left: "Highest Blast Radius" (Section F.9)
   - Row 2 right: "Changes by Layer" (Section F.10) + "New Subsystems" (Section F.11) stacked
4. **Reviewer narrative panel** — full-width card below the grid (see below)
5. **Graph Context section** (Section G) — full-width collapsible card
6. **Blast Radius Rings section** (Section H) — full-width card

### Reviewer narrative panel

This panel is REQUIRED. Do not omit it.

Place it as a full-width row below the dashboard grid:

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

Include the changed files as part of the Graph Context section (Section G). Each file gets:
- Layer badge
- Shape label
- in_degree count
- blast_radius total_files count
- impact_score (rendered as a percentage or 0–100 score)

High-impact files (from Section G.2 classification: hub shape OR violations > 0 OR blast_radius > 5)
get full detail cards (Section G.4). Other files get compact summary cards (Section G.5).

### Blast radius rings

Render using Section H geometry patterns. Data comes from `show_pr_impact blastRadius.affected`.
Group by depth (H.2), compute ring positions (H.3), emit SVG (H.4). Apply crowding strategy when
a ring has >12 files (H.6).

## Step 6 — Apply Section F.14 CSS verbatim

Copy the full CSS from Section F.14 into the `<style>` tag, after the Section A design tokens.
Do not abbreviate or omit any CSS rule.

Also add CSS for the reviewer narrative panel, collapsible section, and rings (from Sections C and H).

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
```

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- This is the ONLY renderer template that requires MCP tool calls (show_pr_impact, get_file_context)
- The reviewer narrative is NOT optional — the template explicitly marks it as REQUIRED
- Read all of Sections F, G, and H from DESIGN-SYSTEM.md; do not reconstruct patterns from memory
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If REVIEW.md does not exist at `${WORKSPACE}/reviews/REVIEW.md`, report failure and stop
