---
template: renderer-design
description: Renderer spawn prompt for converting the PRD + architect design document + task DAG into a unified design.html
used-by: [orchestrator]
read-by: [renderer-agent]
output-path: ${WORKSPACE}/artifacts/design.html
---

# Template: Renderer — Design Document

Use this template when spawning the renderer agent after the architect step completes.

The orchestrator reads this template, fills in the variable placeholders, and passes the
result as the renderer agent's spawn prompt.

## Variables

- `${WORKSPACE}` — absolute path to the Canon workspace (not the worktree)
- `${SLUG}` — the build slug (e.g., `add-dark-mode`)
- `${DESIGN_PATH}` — absolute path to the design document markdown file
  (typically `${WORKSPACE}/plans/${SLUG}/DESIGN.md` or `${WORKSPACE}/plans/${SLUG}/INDEX.md`)
- `${DAG_PATH}` — absolute path to the task DAG YAML file
  (typically `${WORKSPACE}/plans/${SLUG}/task-dag.yaml`); leave empty if no DAG exists
- `${PRD_PATH}` — absolute path to the PRD markdown file
  (typically `${WORKSPACE}/plans/${SLUG}/prd.md`); leave empty if no PRD exists
- `${RUNBOOK_PATH}` — absolute path to the runbook markdown file
  (typically `${WORKSPACE}/plans/${SLUG}/runbook.md`); leave empty if no runbook exists

## Prompt

````
You are a renderer agent. Your sole job is to convert the architect design document,
optional task DAG, and optional PRD into a self-contained HTML file and write it to
${WORKSPACE}/artifacts/design.html.
Do NOT modify the worktree. Do NOT call Canon MCP tools.

## Step 1 — Read source files

Read these files:
1. ${DESIGN_PATH} — the design document markdown (your primary data source)
2. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — the design system reference
3. ${DAG_PATH} — the task DAG YAML (if the path is non-empty and the file exists)
4. ${PRD_PATH} — the PRD markdown (if the path is non-empty and the file exists)
5. ${RUNBOOK_PATH} — the runbook markdown (if the path is non-empty and the file exists)

If ${DAG_PATH} is empty or the file does not exist, treat this as a single-task build
(no DAG) and skip all DAG-specific rendering.

If ${PRD_PATH} is empty or the file does not exist, treat this as a design-only build
(no PRD) and skip all PRD-specific rendering.

## Step 2 — Parse the design document

Extract these sections from the markdown:

- **Title**: The document's `# Title` heading or the first H1.
- **Scope summary**: A short subtitle or scope statement near the top of the document.
- **Architecture overview**: The `## Architecture` or `## Approach` or `## Overview` section.
- **Design decisions**: The `## Design Decisions` or `## Decisions` section — may be a table
  or a list of `### Decision: …` sub-sections.
- **Tradeoffs**: Any `## Tradeoffs` or `## Alternatives` section, or tradeoff notes within
  design decisions.
- **Assumptions**: The `## Assumptions` section — list of assumptions made during design.
- **Brief coverage**: The `### Brief Coverage` table — maps runbook requirements to task elements
  with dispositions (`covered`, `descoped`, `partial`).
- **Runbook**: Runbook data is parsed from the runbook file read in Step 1 (`${RUNBOOK_PATH}`),
  not from the design document. Skip this extraction if no runbook file was loaded.

## Step 2b — Parse the PRD (if present)

If the PRD file was read, extract these fields:

- **Outcome badge**: The value on the `## Outcome` line — `GREENLIGHT`, `CAUTION`, or `NO-GO`.
  Default to `GREENLIGHT` if absent.
- **Effort estimate**: The value on the `## Effort Estimate` line — e.g., `small`, `medium`,
  `large`. Omit if absent.
- **Value estimate**: The value on the `## Value Estimate` line — e.g., `low`, `medium`, `high`.
  Extract just the level word before the dash separator. Omit if absent.
- **Problem statement**: The body of the `## Problem Statement` section, including the
  `**Evidence:**` sub-field if present.
- **Acceptance criteria**: The `## Acceptance Criteria` table rows — columns are `#`,
  `Criterion`, `Verification`, `Type`.
- **Requirement coverage map**: The `## Requirement Coverage Map` table rows — columns are
  `#`, `Requirement`, `Disposition`, `Runbook step or rationale`.
- **Scope & Constraints**: The `## Scope & Constraints` section body — in-scope items, out-of-scope
  items, and constraints. Omit if absent.
- **Alternatives considered**: The `## Alternatives Considered` section — may contain multiple
  `### Alternative:` sub-sections. Omit if absent.
- **Open questions**: The `## Open Questions` numbered list. Omit if absent or empty.

## Step 3 — Parse the task DAG (if present)

If ${DAG_PATH} exists, read and parse the YAML. Each entry has:
- `task_id` — unique identifier string
- `depends_on` — array of task_id strings (may be empty)
- `files` — array of file paths owned by this task

Build an adjacency list from `depends_on` edges. Identify:
- **Root tasks**: tasks with empty `depends_on` (no dependencies)
- **Leaf tasks**: tasks with no other task depending on them
- **Depth of each task**: longest path from any root (BFS/topological sort)

If there is no DAG, the design has a single implicit task. Show its summary from the
design document instead.

## Step 4 — Compose the HTML

Use the design system (Section A tokens, Section B page boilerplate, Section C components).

### Page structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Design — ${SLUG}</title>
  <style>
    /* Section A: CSS design tokens (paste verbatim) */
    /* Section B: reset + body + .container */
    /* Component styles below */
  </style>
</head>
<body>
  <div class="container">
    <!-- Header panel (unified: title + scope + slug badge + outcome badge if PRD present) -->
    <!-- PRD: Problem Statement panel (if PRD present) -->
    <!-- PRD: Acceptance Criteria panel (if PRD present) -->
    <!-- PRD: Requirement Coverage Map panel (if PRD present) -->
    <!-- PRD: Scope & Constraints panel (if PRD present and non-empty) -->
    <!-- Architecture overview panel (from design doc) -->
    <!-- Task DAG visualization panel (or single-task summary) -->
    <!-- Per-task cards -->
    <!-- Design decisions panel -->
    <!-- PRD: Alternatives panel (collapsible, if PRD present and non-empty) -->
    <!-- Tradeoffs panel (collapsible, from design doc) -->
    <!-- PRD: Open Questions panel (if PRD present and questions exist) -->
    <!-- Assumptions panel -->
    <!-- Runbook overview panel -->
  </div>
</body>
</html>
```

### Header panel

**When PRD is present**, render a unified header showing PRD signals alongside design identity:

```html
<div class="section-card" style="margin-bottom: 16px;">
  <div class="section-card-header" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
    <div>
      <h1 style="font-size: 18px; font-weight: 700; color: var(--text-bright);">{title}</h1>
      <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">{scope summary}</p>
    </div>
    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
      <span style="background: {badgeColor}22; color: {badgeColor}; border: 1px solid {badgeColor}44; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 10px; letter-spacing: 0.04em;">{OUTCOME}</span>
      <span style="font-size: 11px; font-family: monospace; color: var(--text-muted); background: var(--bg-surface); padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border);">${SLUG}</span>
    </div>
  </div>
  <div class="section-card-body" style="display: flex; gap: 12px; flex-wrap: wrap; padding-top: 8px;">
    <span style="font-size: 12px; color: var(--text-muted);">Effort: {effort}</span>
    <span style="font-size: 12px; color: var(--text-muted);">Value: {value}</span>
  </div>
</div>
```

Outcome badge color mapping:
- `GREENLIGHT` → `var(--success)` (use `#34d399` for the `{badgeColor}22` / `{badgeColor}44` fill pattern)
- `CAUTION` → `var(--warning)` (use `#fbbf24`)
- `NO-GO` → `var(--danger)` (use `#ff6b6b`)

Omit the effort/value row if neither value is present in the PRD.

**When no PRD exists**, render the design-only header (no outcome badge, no effort/value chips):

```html
<div class="section-card" style="margin-bottom: 16px;">
  <div class="section-card-header" style="display: flex; align-items: center; justify-content: space-between;">
    <div>
      <h1 style="font-size: 18px; font-weight: 700; color: var(--text-bright);">{title}</h1>
      <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">{scope summary}</p>
    </div>
    <span style="font-size: 11px; font-family: monospace; color: var(--text-muted); background: var(--bg-surface); padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border);">${SLUG}</span>
  </div>
</div>
```

### PRD: Problem Statement panel

**Only render if PRD data exists.**

Use `.section-card` with title "Problem Statement". Render the section body using
`markdownToHtml()` inside `.section-card-body` — the body may contain bold, italic, lists,
or inline code. If an `**Evidence:**` sub-field is present, render it as a separate block
with `color: var(--text-muted)`, also processed through `markdownToHtml()`.

### PRD: Acceptance Criteria panel

**Only render if PRD data exists.**

Use `.section-card` with title "Acceptance Criteria". Render the table using `.table-scroll-wrapper`
and `.requirement-table` from Section C. Columns: `#`, `Criterion`, `Verification`, `Type`.

If no table rows exist in the PRD, render an `.empty-note` paragraph: "No acceptance criteria defined."

### PRD: Requirement Coverage Map panel

**Only render if PRD data exists.**

Use `.section-card` with title "Requirement Coverage". Render the table using `.table-scroll-wrapper`
and `.requirement-table`. Add a Disposition column rendered with `.disposition` badges from Section C:
- `covered` → `.disposition--covered`
- `descoped` → `.disposition--descoped`
- `partial` → `.disposition--partial`

If no table rows exist, render an `.empty-note`: "No requirement coverage map defined."

### PRD: Scope & Constraints panel

**Only render if PRD data exists and the section is non-empty.**

Use `.section-card` with title "Scope & Constraints". Render the in-scope items as a `<ul>` list
under a sub-label, out-of-scope items under a second sub-label, and constraints under a third.
Use `font-size: 11px; font-weight: 600; color: var(--text-muted)` for sub-labels. Omit
sub-sections that have no items. Use `markdownToHtml()` for item text (items may contain
inline code or bold emphasis); use `escapeHtml()` for sub-label text only.

### Architecture overview panel

Use `.section-card` with title "Architecture Overview". Render the section body using
`markdownToHtml()` inside `.section-card-body` — this section commonly contains code blocks,
inline code, bold terms, and sub-headings. `markdownToHtml()` handles heading conversion to
`<h3>`/`<h4>` tags automatically.

### Task DAG visualization panel

**When a DAG exists:**

Render a `.section-card` with title "Task DAG". Show the dependency graph as a CSS-based
visual — no JavaScript or SVG required. Use a wave/column layout:

1. Group tasks by depth (column = depth level)
2. Render each column as a vertical stack of task chips
3. Connect dependent tasks with a simple arrow indicator in the chip

```html
<div class="section-card" style="margin-bottom: 16px;">
  <div class="section-card-header"><h2 class="section-title">Task DAG</h2></div>
  <div class="section-card-body">
    <div style="display: flex; gap: 24px; overflow-x: auto; padding-bottom: 8px;">
      <!-- One column per depth level -->
      <div style="display: flex; flex-direction: column; gap: 8px; min-width: 160px;">
        <div style="font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;">Wave {depth}</div>
        <!-- Task chip -->
        <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px;">
          <div style="font-size: 12px; font-weight: 600; color: var(--accent); font-family: monospace;">{task_id}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">{file count} files</div>
          <!-- Dependencies (when depends_on is non-empty) -->
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 6px; border-top: 1px solid var(--border); padding-top: 4px;">
            Depends on: {depends_on joined by ", "}
          </div>
        </div>
      </div>
    </div>
    <!-- Summary stats row -->
    <div style="display: flex; gap: 16px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
      <span style="font-size: 12px; color: var(--text-muted);">{taskCount} tasks</span>
      <span style="font-size: 12px; color: var(--text-muted);">{waveCount} waves</span>
      <span style="font-size: 12px; color: var(--text-muted);">{rootCount} parallel roots</span>
    </div>
  </div>
</div>
```

**When no DAG exists (single-task build):**

Render a `.section-card` with title "Implementation Plan". Show a summary from the design
document's implementation section — step names, files affected, key decisions. Use a simple
numbered list.

### Per-task cards

**When a DAG exists**, render one card per task in a 2-column grid:

```html
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
  <div class="section-card">
    <div class="section-card-header" style="display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 12px; font-weight: 700; font-family: monospace; color: var(--accent);">{task_id}</span>
      <!-- Dependency indicator -->
      {depends_on.length > 0 ? '<span style="font-size: 10px; color: var(--text-muted);">← depends on ' + deps + '</span>' : ''}
    </div>
    <div class="section-card-body">
      <!-- Files list -->
      <div style="margin-bottom: 8px;">
        <div style="font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Files</div>
        <ul style="list-style: none; display: flex; flex-direction: column; gap: 2px;">
          <li style="font-size: 11px; font-family: monospace; color: var(--text-bright);">{file}</li>
        </ul>
      </div>
      <!-- Brief coverage (if task plan has a Brief Coverage table) -->
      {briefCoverageRows}
    </div>
  </div>
</div>
```

If a task plan file exists at `${WORKSPACE}/plans/${SLUG}/{task_id}-PLAN.md`, read it to
extract the `### Brief Coverage` table rows and render them with `.disposition` badges.

**When no DAG exists**, skip this section.

### Design decisions panel

Use `.section-card` with title "Design Decisions". Render as a list of decision entries.
Each entry shows:
- Decision title (bold) — use `escapeHtml()` (atomic value)
- Choice made — use `escapeHtml()` (short phrase)
- Rationale (muted text) — use `markdownToHtml()` (may contain inline code, lists, emphasis)
- Tradeoffs / alternatives rejected (muted, smaller) — use `markdownToHtml()`

If decisions are in a table, render using `.requirement-table` with `escapeHtml()` on cell
values. If in sub-sections, render each `### Decision: …` as a card within the panel,
applying `markdownToHtml()` to the body text.

### PRD: Alternatives panel (collapsible)

**Only render if PRD data exists and the Alternatives Considered section is non-empty.**

Use `<details class="collapsible-section">` from Section C. Title: "Alternatives Considered".
Start collapsed (`<details>` without `open`). Render each `### Alternative:` sub-section as
a titled block (title with `escapeHtml()`) with its description and "Why not chosen" rationale
rendered using `markdownToHtml()` — these bodies may contain lists, code, and emphasis.

### Tradeoffs panel (collapsible)

Use `<details class="collapsible-section">`. Title: "Tradeoffs & Alternatives Considered".
Start collapsed. Render tradeoff content from the design document using `markdownToHtml()` —
this section typically contains lists, inline code, and emphasis. If the design document has
no tradeoffs section, omit this panel.

### PRD: Open Questions panel

**Only render if PRD data exists and the Open Questions list is non-empty.**

Use `.section-card` with title "Open Questions". Render as a numbered `<ol>` list, one
question per `<li>`. Use `markdownToHtml()` for each question — questions may reference
inline code or use emphasis.

### Assumptions panel

Use `.section-card` with title "Assumptions". Render as a `<ul>` list. Use `markdownToHtml()`
for each assumption item — items may reference code or use emphasis. If absent, omit.

### Runbook overview panel

**Only render if `${RUNBOOK_PATH}` is non-empty and the file exists.**

Use `.section-card` with title "Runbook". Extract runbook steps from the runbook file read in
Step 1 (`${RUNBOOK_PATH}`). Parse the numbered steps — each step typically has a name, agent
type, and expected artifacts listed. Render each step as a numbered row with:
- Step number (large, `var(--accent)` colored)
- Step name / description
- Agent type as a small badge
- Expected artifacts (if listed)

```html
<div class="section-card">
  <div class="section-card-header"><h2 class="section-title">Runbook</h2></div>
  <div class="section-card-body">
    <ol style="list-style: none; display: flex; flex-direction: column; gap: 10px;">
      <li style="display: flex; gap: 12px; align-items: flex-start;">
        <span style="font-size: 20px; font-weight: 700; color: var(--accent); min-width: 28px;">{N}</span>
        <div>
          <div style="font-weight: 600; color: var(--text-bright); font-size: 13px;">{step name}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Agent: {agent type}</div>
          <div style="font-size: 11px; color: var(--text-muted);">Artifacts: {artifacts}</div>
        </div>
      </li>
    </ol>
  </div>
</div>
```

If `${RUNBOOK_PATH}` is empty or the file does not exist, omit the Runbook panel entirely.

## Step 5 — Security and Markdown Conversion

Use the two helper functions below to embed content safely. The key rule:

- **Prose / body content** (sections, rationale, descriptions, assumptions) → `markdownToHtml()`
- **Atomic values** (slugs, task IDs, file paths, badge text, table cell values, step names, agent types) → `escapeHtml()`

`markdownToHtml` calls `escapeHtml` on text runs internally (escape-first, wrap-second), so
do NOT pre-escape text before passing it to `markdownToHtml` — that would double-escape.

Color constants, CSS property values, and numeric values do not need escaping.

Use the canonical `escapeHtml` and `markdownToHtml` defined in
`mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` Section E (Security Requirements) — which you read
in Step 1. Copy those definitions verbatim into your build-time rendering script (use the runtime
null-safe `escapeHtml` form noted there). Do NOT redefine or re-implement them here.

## Step 6 — Write output

Write the complete, self-contained HTML to:
  ${WORKSPACE}/artifacts/design.html

The file must be fully self-contained (no external stylesheets, no JavaScript, no CDN links).
All CSS is inline in the `<style>` tag.

Return when the file is written. Do not call any MCP tools. Do not modify the worktree.
````

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- The DAG path variable may be empty — renderer must handle that gracefully
- The PRD path variable may be empty — renderer must handle that gracefully; all PRD panels
  are omitted when no PRD file exists
- The runbook path variable may be empty — renderer must handle that gracefully; the Runbook
  panel is omitted when `${RUNBOOK_PATH}` is empty or the file does not exist
- Task plan files are read opportunistically — if absent, skip the brief coverage sub-section
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If `${DESIGN_PATH}` does not exist, check for `INDEX.md` in the same directory before
  reporting failure
