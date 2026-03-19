# Canon Dashboard

VS Code / Cursor extension that visualizes your codebase as an interactive dependency graph, shows violations with graph-aware impact context, and feeds structural data into Claude via Canon's MCP server.

## Features

- **Codebase graph** — D3-powered force-directed visualization showing files, dependencies, and architectural layers (api, ui, domain, data, infra, shared)
- **Git overlay** — Changed files highlighted on the graph with pulse animation
- **Graph-aware violations** — Violations enriched with fan-in, hub status, cycle membership, and impact scores
- **Summary progress** — Real-time progress bar during file summary generation
- **Message-based updates** — Graph data pushed via postMessage (no HTML re-render), preserving D3 state across refreshes
- **Refresh UX** — "Refreshing graph..." indicator while keeping the current graph visible
- **Loading states** — Differentiated states: "Mapping your codebase" (generating), "No graph data" (empty), "Failed to load" (error)
- **MCP integration** — Node selection persisted to `.canon/dashboard-state.json` for context-aware principles
- **Active file tracking** — Tracks the currently open editor file for principle matching
- **File watcher** — Auto-refreshes when graph data, summaries, or git branch change
- **Canvas resize** — Graph reflows via ResizeObserver when panel is resized
- **Search & filter** — Search by filename, filter by layer, changed files, violations, or PR review scope

## Installation

Install from the pre-built `.vsix`:

```
code --install-extension canon-dashboard-0.1.0.vsix
```

Or build from source:

```bash
npm install
npm run build
npm run package
```

## Commands

| Command | Description |
|---------|-------------|
| `Canon: Open Dashboard` | Open the codebase graph visualization |
| `Canon: Refresh Graph` | Push updated graph data without page reload |

## How It Works

1. The extension activates when a `.canon` directory is detected in the workspace
2. Renders the HTML shell once, embedding graph data if `graph-data.json` already exists
3. If no graph exists, sends `graphStatus: "generating"` and spawns graph generation via Claude CLI
4. File watcher and polling detect when `graph-data.json` appears or changes
5. Graph data is pushed via `postMessage({ type: "graphData" })` — no HTML teardown
6. Svelte stores update reactively; GraphCanvas `$effect` destroys old D3 simulation and rebuilds
7. Summaries generated incrementally with poll-based progress tracking
8. On node click, persists selection to `.canon/dashboard-state.json`
9. MCP tool `get_dashboard_selection` reads this state to provide graph metrics and downstream impact

## Architecture

```
Extension Host                          Webview (Svelte + D3)
─────────────                          ─────────────────────
dashboard-panel.ts                      App.svelte
├── pushGraphData()  ──postMessage──>   stores/graphData.ts
├── pushPrReviews()  ──postMessage──>     ├── graphData (writable)
├── postToWebview()                       ├── graphStatus (writable)
├── onWebviewReady() <──request────      ├── edgeIn, edgeOut (derived)
├── onGetFile()      <──request────      └── nodeMap, layerMap (derived)
├── onGetSummary()   <──request────
└── setupFileWatcher()                  GraphCanvas.svelte
    ├── .canon/graph-data.json            └── $effect: rebuild D3 on data change
    ├── .canon/summaries.json
    └── .git/HEAD                       d3Graph.ts (buildD3Graph)
                                          ├── ResizeObserver
constants.ts                              ├── Force simulation
├── CANON_DIR                             ├── Node/edge rendering
├── FILES                                 └── Filter engine
└── TIMEOUTS
                                        stores/bridge.ts
messages.ts                               └── Request/response protocol
├── ExtensionPushMessage
└── WebviewRequest
```

## Development

```bash
npm install
npm run watch    # rebuild on changes
npm test         # run tests
```

### Testing

Tests use Vitest and cover:

- **Graph data loading** — Reading, validating, and merging graph data with summaries
- **Git operations** — Branch detection and changed file tracking using real temporary git repos
- **Path validation** — Security checks for webview file access requests (safeResolvePath, isValidRelativePath)
