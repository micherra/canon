# Canon Dashboard Extension — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
VS Code/Cursor extension that visualizes a project's dependency graph as an interactive Sigma.js graph and feeds architectural insights to Claude via the Canon MCP server.

## Architecture
<!-- last-updated: 2026-03-23 -->

Two-part architecture: Node.js extension host + Svelte/Sigma.js webview.

```
src/
├── extension.ts              # Entry point — command registration, active file tracking
├── dashboard-panel.ts        # Webview panel lifecycle, file watcher, message routing
├── constants.ts              # Shared constants (CANON_DIR, file names, timeouts)
├── messages.ts               # Typed message protocol definitions
├── services/
│   ├── graph.ts              # Graph data loading & summary merging
│   └── git.ts                # Git branch & changed file detection
├── webview/
│   ├── main.ts               # Webview entry point
│   ├── App.svelte            # Root component
│   ├── stores/               # Svelte stores (graphData, filters, selection, bridge)
│   ├── components/           # UI: GraphCanvas, Toolbar, DetailPanel, InsightsPanel, etc.
│   └── lib/
│       ├── sigmaGraph.ts     # Sigma.js/Graphology graph rendering
│       ├── graph.ts          # Graph utilities (cascade, filtering)
│       └── constants.ts      # Layer colors, node styling
├── __tests__/                # Vitest tests (path validation, git, graph loading)
media/
└── dashboard.html            # HTML shell with data placeholders
```

**Extension host** manages panel lifecycle, spawns Claude CLI for graph generation, watches `.canon/graph-data.json` and `.canon/summaries.json`, persists node selection to `.canon/dashboard-state.json`.

**Webview** renders the Sigma.js/Graphology graph with layer coloring, changed-file highlighting, PR review scope filtering, and impact cascade visualization.

## Contracts
<!-- last-updated: 2026-03-22 -->

**Commands:**
- `canon.openDashboard` — Opens the graph visualization panel
- `canon.refreshGraph` — Triggers graph data regeneration

**Message protocol (Extension <-> Webview):**

Extension → Webview: `graphData`, `graphStatus`, `prReviews`, `summaryProgress`
Webview → Extension: `webviewReady`, `getBranch`, `getFile`, `getSummary`, `nodeSelected`, `refreshGraph`

**Activation:** Triggers when `.canon` directory exists in workspace.

## Dependencies
<!-- last-updated: 2026-03-23 -->

| Package | Purpose |
|---------|---------|
| `sigma` | Graph rendering (WebGL/Canvas) |
| `graphology` | Graph data structure |
| `graphology-layout-forceatlas2` | ForceAtlas2 layout algorithm |
| `graphology-communities-louvain` | Community detection |
| `svelte` ^5.54.0 | Webview UI framework |
| `esbuild` + `esbuild-svelte` | Build tooling (dev) |
| `vitest` | Testing (dev) |
| `vsce` | VS Code packaging (dev) |

## Invariants
<!-- last-updated: 2026-03-22 -->

- Path traversal protection via `safeResolvePath` — rejects `..`, absolute paths, validates within workspace
- CSP with per-render nonce on all script tags
- Graph data embedded in `<script type="application/json">` with `</` escaping to prevent XSS
- File watcher debounced at 500ms; fallback polling at 2s intervals (5min timeout)
- Node selection persisted to `.canon/dashboard-state.json` for MCP access

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install              # Install dependencies
npm run build            # Full build (extension + webview)
npm run build:extension  # Build extension only (esbuild)
npm run build:webview    # Build webview only (Svelte)
npm run watch            # Watch mode (both in parallel)
npm run package          # Package as .vsix
npm test                 # Run vitest tests
```
