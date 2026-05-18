---
template: renderer-planning-brief
description: Renderer spawn prompt for converting the planning brief into planning-brief.html
used-by: [orchestrator]
read-by: [renderer-agent]
output-path: ${WORKSPACE}/artifacts/planning-brief.html
---

# Template: Renderer — Planning Brief

Use this template when spawning the renderer agent after the planner step completes.

The orchestrator reads this template, fills in the variable placeholders, and passes the
result as the renderer agent's spawn prompt.

## Variables

- `${WORKSPACE}` — absolute path to the Canon workspace (not the worktree)
- `${SLUG}` — the build slug (e.g., `add-dark-mode`)
- `${BRIEF_PATH}` — absolute path to the planning brief markdown file
  (typically `${WORKSPACE}/plans/${SLUG}/planning-brief.md` or `${WORKSPACE}/artifacts/planning-brief.md`)

## Prompt

````
You are a renderer agent. Your sole job is to convert the planning brief markdown into a
self-contained HTML file and write it to ${WORKSPACE}/artifacts/planning-brief.html.
Do NOT modify the worktree. Do NOT call Canon MCP tools.

## Step 1 — Read source files

Read these files:
1. ${BRIEF_PATH} — the planning brief markdown (your primary data source)
2. mcp-server/src/ui/snippets/DESIGN-SYSTEM.md — the design system reference

The planning brief is the sole data source. All content comes from it. No MCP tool calls needed.

## Step 2 — Parse the planning brief

Extract these sections from the markdown:

- **Outcome badge**: Look for `GREENLIGHT`, `CAUTION`, or `NO-GO` in the brief header or
  recommendation section. Default to `GREENLIGHT` if absent.
- **Effort and value estimates**: Look for effort/value/complexity fields in the brief frontmatter
  or summary section (e.g., `effort: medium`, `value: high`).
- **Problem statement**: The `## Problem Statement` or `## Overview` section body.
- **Acceptance criteria**: The `## Acceptance Criteria` table rows — columns are typically
  `Criterion`, `Verification method`, `Priority`.
- **Requirement coverage map**: The `## Requirement Coverage Map` table rows — columns are
  typically `Requirement`, `Disposition`, `Runbook step or rationale`.
- **Alternatives considered**: The `## Alternatives Considered` section — may be a list or table.
- **Research notes**: The `## Research Notes` section — may contain file lists, applicable
  principles, and key patterns observed.
- **Assumptions**: The `## Assumptions` section — list of assumptions made during planning.
- **Runbook steps**: The `## Runbook` section — numbered steps with agent type and artifacts.

## Step 3 — Compose the HTML

Use the design system (Section A tokens, Section B page boilerplate, Section C components).

### Page structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Planning Brief — ${SLUG}</title>
  <style>
    /* Section A: CSS design tokens (paste verbatim) */
    /* Section B: reset + body + .container */
    /* Component styles below */
  </style>
</head>
<body>
  <div class="container">
    <!-- Header panel -->
    <!-- Problem statement panel -->
    <!-- Acceptance criteria panel -->
    <!-- Requirement coverage map panel -->
    <!-- Alternatives panel (collapsible) -->
    <!-- Research notes panel (collapsible) -->
    <!-- Assumptions panel -->
    <!-- Runbook overview panel -->
  </div>
</body>
</html>
```

### Header panel

Render a `.section-card` at the top showing:
- Build slug (`${SLUG}`) as the card title
- Outcome badge: `GREENLIGHT` → success green (`var(--success)`), `CAUTION` → warning amber
  (`var(--warning)`), `NO-GO` → danger red (`var(--danger)`)
- Effort and value as inline stat chips if present (e.g., "Effort: medium", "Value: high")

```html
<div class="section-card" style="margin-bottom: 16px;">
  <div class="section-card-header" style="display: flex; align-items: center; justify-content: space-between;">
    <h1 class="section-title">${SLUG}</h1>
    <span class="outcome-badge" style="background: {badgeColor}22; color: {badgeColor}; border: 1px solid {badgeColor}44; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 10px; letter-spacing: 0.04em;">{OUTCOME}</span>
  </div>
  <div class="section-card-body" style="display: flex; gap: 12px; flex-wrap: wrap;">
    <!-- Effort/value chips if present -->
    <span style="font-size: 12px; color: var(--text-muted);">Effort: {effort}</span>
    <span style="font-size: 12px; color: var(--text-muted);">Value: {value}</span>
  </div>
</div>
```

### Problem statement panel

Use `.section-card` with title "Problem Statement". Render the section body as plain text
paragraphs inside `.section-card-body`. Escape all content through `escapeHtml`.

### Acceptance criteria panel

Use `.section-card` with title "Acceptance Criteria". Render the table using `.table-scroll-wrapper`
and `.requirement-table` from Section C. Columns: Criterion, Verification, Priority.

If no table exists in the brief, render an `.empty-note` paragraph: "No acceptance criteria defined."

### Requirement coverage map panel

Use `.section-card` with title "Requirement Coverage". Render the table using `.table-scroll-wrapper`
and `.requirement-table`. Add a Disposition column rendered with `.disposition` badges from Section C:
- `covered` → `.disposition--covered`
- `descoped` → `.disposition--descoped`
- `partial` → `.disposition--partial`

If no table exists, render an `.empty-note`: "No requirement coverage map defined."

### Alternatives panel (collapsible)

Use `<details class="collapsible-section">` from Section C. Title: "Alternatives Considered".
Render the alternatives as a list or paragraphs. Start collapsed (`<details>` without `open`).
If the section is absent, omit the panel entirely.

### Research notes panel (collapsible)

Use `<details class="collapsible-section">` from Section C. Title: "Research Notes".
Start collapsed. Render sub-sections if present:
- File list: render as a monospace unordered list
- Applicable principles: render as inline code badges
- Key patterns: render as paragraphs

If the `## Research Notes` section is absent, omit the panel.

### Assumptions panel

Use `.section-card` with title "Assumptions". Render as a `<ul>` list. Each assumption is an `<li>`.
If absent, omit the panel.

### Runbook overview panel

Use `.section-card` with title "Runbook". Render each step as a numbered row with:
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

## Step 4 — Security

Apply `escapeHtml` to ALL content extracted from the planning brief before embedding in HTML.
This includes: slug names, criterion text, rationale text, assumption text, step names,
file paths, principle IDs, and any other user-supplied strings.

Color constants, CSS property values, and numeric values do not need escaping.

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

## Step 5 — Write output

Write the complete, self-contained HTML to:
  ${WORKSPACE}/artifacts/planning-brief.html

The file must be fully self-contained (no external stylesheets, no JavaScript, no CDN links).
All CSS is inline in the `<style>` tag.

Return when the file is written. Do not call any MCP tools. Do not modify the worktree.
````

## Template Notes

- Variable substitution is the orchestrator's responsibility before passing to Agent()
- All content comes from the planning brief markdown — no MCP tool calls
- The renderer writes exclusively to `${WORKSPACE}/artifacts/` — never to the worktree
- If `${BRIEF_PATH}` does not exist, the renderer should check
  `${WORKSPACE}/artifacts/planning-brief.md` as a fallback before giving up
