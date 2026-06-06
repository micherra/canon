# UI Snippets — Agent Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->
<!-- last-updated: 2026-06-04 -->

## Purpose

HTML/CSS/JS component recipes emitted verbatim into renderer-generated artifacts. Each snippet is a self-contained fragment that renderer agents read and copy into HTML output. `DESIGN-SYSTEM.md` is the authoritative token reference for all artifact rendering and also the canonical home for the build-time renderer helpers (`escapeHtml`, `markdownToHtml`).

## Snippets Inventory

| File | What it provides |
|------|-----------------|
| `DESIGN-SYSTEM.md` | Authoritative dark-palette token reference — Canvas hex values, CSS vars, typography; **Section E** is the canonical home for `escapeHtml` and `markdownToHtml`; all artifact renderers read this first |
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

## Canonical Renderer Helpers

**`DESIGN-SYSTEM.md` Section E is the single canonical home for the build-time renderer helpers `escapeHtml` and `markdownToHtml`.**

- Renderer templates reference Section E; they never re-inline these function definitions.
- `escapeHtml` — null-safe `String(s ?? "")` form + 5-replace chain.
- `markdownToHtml` — behavior-preserving union: code fences, h1–h4, ul/ol, bold/italic (`**`, `__`), code-span protection tokens (`\x00CODE{n}\x00`), `file:line` auto-linking, GFM tables (pipe-delimited rows → `<table class="requirement-table">` in `.table-scroll-wrapper`; header-only tables render a muted "None" empty-state row), block-grouped paragraph wrapping. Calls `escapeHtml` internally (escape-first) — do NOT pre-escape input.
- `inlineFormat` token ordering (must not reorder): escape → tokenize code spans → tokenize `file:line` refs → bold → italic → restore tokens. Both code spans and `file:line` refs are replaced with `\x00CODEn\x00` placeholder tokens before bold/italic runs, so underscored path segments (e.g., `src/foo_bar.ts:42`) are never matched by the `_..._` italic pass.
- The runtime `escHtml` inside `renderer-codebase-graph.md`'s Canvas force-sim IIFE is a separate, deliberate escaper scoped to that IIFE; it is NOT covered by this convention.

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
- **No inline renderer helpers**: `escapeHtml`, `markdownToHtml`, and `inlineFormat` must never be redefined inline in a renderer template — they live only in `DESIGN-SYSTEM.md` Section E. See "Canonical Renderer Helpers" above.
