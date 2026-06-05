# UI Snippets — Agent Guidelines

<!-- last-updated: 2026-06-04 -->

## Purpose

HTML/CSS/JS component recipes emitted verbatim into renderer-generated artifacts. Each snippet is a self-contained fragment that renderer agents read and copy into HTML output. `DESIGN-SYSTEM.md` is the authoritative token reference for all artifact rendering.

## Snippets Inventory

| File | What it provides |
|------|-----------------|
| `DESIGN-SYSTEM.md` | Authoritative dark-palette token reference — Canvas hex values, CSS vars, typography; all artifact renderers read this first |
| `force-graph.html` | **Canonical force-directed-graph engine** — exposes `renderForceGraph(canvasEl, { nodes, edges }, options)`; shared by `renderer-review.md` and `renderer-codebase-graph.md`; single source of truth for force-sim constants and normalize-to-fit pass |
| `file-detail-card.html` | Per-file expandable detail card with columnar `drawFileGraph` (deterministic left=imports/center/right=imported-by layout); used by review and file-context renderers |
| `node-detail-panel.html` | Click-to-inspect side panel for the codebase-graph renderer |
| `bar-chart-row.html` | Horizontal bar chart row component |
| `blast-radius-rings.html` | Concentric-ring blast-radius visualization |
| `blast-radius-tree.html` | Tree-list blast-radius display |
| `compliance-bars.html` | Compliance score bar display |
| `file-summary-card.html` | Compact file summary card |
| `severity-badge.html` | Severity level badge |
| `stats-card.html` | Key-metric stat card |
| `verdict-banner.html` | Review verdict banner |

## Contracts

**`renderForceGraph(canvasEl, { nodes, edges }, options)`** (`force-graph.html`) — canonical force-directed layout engine. Options: `height`, `iterations`, `nodeFill(node)` (required), `edgeStyle: 'arrow'|'curve'`, `showViolationRing`, `drawLabels`, `onNodeClick(node)`, `onHover`; force constants override known-good defaults (K_REPEL=5000, K_SPRING=0.01, REST_LENGTH=50, K_GRAVITY=0.3, DAMPING=0.85, MAX_FORCE=10). Returns `{ redraw(highlightId) }`. Runs force-sim + normalize-to-fit + label de-collision + draw.

**`drawFileGraph`** (`file-detail-card.html`) — deterministic columnar layout for single-file import/export neighborhoods; NOT force-directed; different data contract from `renderForceGraph`; do NOT substitute one for the other.

## Invariants

- **Adopt, never copy**: Any renderer template that needs a force-directed graph MUST emit `force-graph.html` verbatim and call `renderForceGraph(...)`. Copying the force-sim inline into a renderer template is prohibited — it reintroduces the divergent-copies bug class that caused the clustered-at-center regression.
- **Emit verbatim, exactly once**: Each snippet's `<script>` block is emitted verbatim before `</body>`, exactly once per page.
- **No inline force-sim in renderer templates**: `grep` for `K_REPEL`/`K_SPRING`/`REST_LENGTH`/`K_GRAVITY`/`ITERATIONS`/`MAX_FORCE` in any renderer template is a violation — these constants belong only in `force-graph.html`.
- **Token comments on all Canvas hex literals**: every `#RRGGBB` in executable Canvas code carries a `/* --token */` comment; no new theme colors without a token.
- **`file-detail-card.html` is deliberately separate**: the columnar `drawFileGraph` engine in `file-detail-card.html` is a different algorithm with a different data contract; it serves file-context and review per-file cards; do NOT unify it with `force-graph.html`.
- **Docblock format**: every snippet must have a 5-tag docblock (`@snippet`, `@description`, `@data`, `@tokens`, `@usage`) — enforced by `agent-composition.test.ts`.
