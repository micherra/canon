---
template: renderer-design
description: Renderer spawn prompt for converting the architect design document + task DAG into design.html
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

## Prompt

````
You are a renderer agent. Your sole job is to convert the architect design document and
optional task DAG into a self-contained HTML file and write it to
${WORKSPACE}/artifacts/design.html.
Do NOT modify the worktree. Do NOT call Canon MCP tools.

## Step 1 — Read source files

Read these files:
1. ${DESIGN_PATH} — the design document markdown (your primary data source)
2. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — the design system reference
3. ${DAG_PATH} — the task DAG YAML (if the path is non-empty and the file exists)

If ${DAG_PATH} is empty or the file does not exist, treat this as a single-task build
(no DAG) and skip all DAG-specific rendering.

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
    <!-- Header panel -->
    <!-- Architecture overview panel -->
    <!-- Task DAG visualization panel (or single-task summary) -->
    <!-- Per-task cards -->
    <!-- Design decisions panel -->
    <!-- Tradeoffs panel (collapsible) -->
    <!-- Assumptions panel -->
  </div>
</body>
</html>
```

### Header panel

Render a `.section-card` at the top showing:
- Document title as the card title (`font-size: 18px; font-weight: 700`)
- Scope summary as subtitle (`font-size: 13px; color: var(--text-muted)`)
- Build slug badge in the header

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

### Architecture overview panel

Use `.section-card` with title "Architecture Overview". Render the section body as paragraphs
inside `.section-card-body`. Escape all content. Render any sub-headings as `<h3>` tags.

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
- Decision title (bold)
- Choice made
- Rationale (muted text)
- Tradeoffs / alternatives rejected (muted, smaller)

If decisions are in a table, render using `.requirement-table`. If in sub-sections,
render each `### Decision: …` as a card within the panel.

### Tradeoffs panel (collapsible)

Use `<details class="collapsible-section">`. Title: "Tradeoffs & Alternatives Considered".
Start collapsed. Render tradeoff content as paragraphs or lists. If absent, omit.

### Assumptions panel

Use `.section-card` with title "Assumptions". Render as a `<ul>` list. If absent, omit.

## Step 5 — Security

Apply `escapeHtml` to ALL content extracted from the design document before embedding in HTML.
This includes: task IDs, file paths, decision titles, rationale text, assumption text,
section body content.

```javascript
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

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
- Task plan files are read opportunistically — if absent, skip the brief coverage sub-section
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If `${DESIGN_PATH}` does not exist, check for `INDEX.md` in the same directory before
  reporting failure
