# Canon Dashboard

VS Code / Cursor extension that visualizes your codebase as an interactive graph and feeds context into Claude via Canon's MCP server.

## Features

- **Codebase graph** — D3-powered interactive visualization showing files, dependencies, and architectural layers (api, ui, domain, data, infra, shared)
- **Git overlay** — Live changed files highlighted on the graph
- **MCP integration** — Clicking a node persists selection to `.canon/dashboard-state.json`, which the MCP server reads to provide context-aware principles
- **Active file tracking** — Tracks the currently open editor file for principle matching
- **File watcher** — Auto-refreshes when graph data, summaries, or git branch change

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
| `Canon: Refresh Graph` | Reload graph data and git changes |

## How It Works

1. The extension activates when a `.canon` directory is detected in the workspace
2. Opens a webview panel rendering graph data from `.canon/graph-data.json`
3. Merges file summaries from `.canon/summaries.json` into graph nodes
4. Overlays git changed files (vs main branch) onto the graph
5. On node click, persists selection to `.canon/dashboard-state.json`
6. The MCP tool `get_dashboard_selection` reads this state to provide Claude with context about what the user is viewing

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
- **Path validation** — Security checks for webview file access requests
