# UI Snippets

HTML/CSS/JS component recipes used by Canon renderer agents to compose HTML artifacts. Each file is a self-contained fragment emitted verbatim into the generated HTML output.

## Design System

`DESIGN-SYSTEM.md` is the authoritative token reference. All renderer agents read it before composing artifacts. It defines the dark-palette CSS variables and Canvas hex values used across all snippets.

## Snippets

| File | Purpose |
|------|---------|
| `force-graph.html` | Canonical force-directed-graph engine (`renderForceGraph`). Shared by the review and codebase-graph renderers. |
| `file-detail-card.html` | Per-file expandable detail card with columnar import/export neighborhood graph (`drawFileGraph`). |
| `node-detail-panel.html` | Click-to-inspect side panel for the codebase-graph view. |
| `bar-chart-row.html` | Horizontal bar chart row. |
| `blast-radius-rings.html` | Concentric-ring blast-radius visualization. |
| `blast-radius-tree.html` | Tree-list blast-radius display. |
| `compliance-bars.html` | Compliance score bar display. |
| `file-summary-card.html` | Compact file summary card. |
| `severity-badge.html` | Severity level badge. |
| `stats-card.html` | Key-metric stat card. |
| `verdict-banner.html` | Review verdict banner. |

## Using `force-graph.html`

The `force-graph.html` snippet is the **only** source for force-directed graph layout. Renderer templates that need a force-directed graph must:

1. Read `mcp-server/src/ui/snippets/force-graph.html` and emit its `<script>` block verbatim, exactly once before `</body>`.
2. Call `renderForceGraph(canvasEl, { nodes, edges }, options)` from their own init script.

Do not copy the force-simulation math inline into a renderer template — that recreates the divergent-copies problem that caused the layout regression this snippet was introduced to fix.

`file-detail-card.html` provides a separate `drawFileGraph` function for single-file import/export neighborhood display. It is not interchangeable with `renderForceGraph`.

## Adding a New Snippet

1. Follow the 5-tag docblock format: `@snippet`, `@description`, `@data`, `@tokens`, `@usage` — enforced by `agent-composition.test.ts`.
2. Annotate every Canvas hex literal with a `/* --token */` comment.
3. Do not add new theme colors; use existing design-system tokens.
4. Update the inventory table above.
5. Update `mcp-server/src/ui/snippets/.claude/CLAUDE.md` inventory table.
