---
description: Generate all Canon dashboard data and open the unified UI
argument-hint: [--open] [--diff-base main]
allowed-tools: [Bash, Read, Glob, Write]
model: haiku
---

Generate data for all Canon dashboard views and open the UI in a browser.

## Instructions

### Step 1: Deploy dashboard UI

Call the `deploy_dashboard` MCP tool. This copies the Canon dashboard HTML/JS files to `.canon/dashboard/` in the project directory. Note the `dashboard_path` and `serve_hint` from the result.

### Step 2: Generate graph data

Call the `codebase_graph` MCP tool to scan the codebase and generate the dependency graph with compliance overlay.

If `--diff-base` is provided, get changed files first:
```bash
git diff {diff_base}..HEAD --name-only
```
Pass these as `changed_files` to the tool.

Save the result to `.canon/graph-data.json`.

### Step 3: Generate principles data

Call the `list_principles` MCP tool to get all principles. Then call `get_compliance` to get compliance stats.

Merge the results into a single object:
```json
{
  "principles": [ /* list_principles output with compliance_rate added */ ],
  "generated_at": "ISO timestamp"
}
```

Save to `.canon/principles-data.json`.

### Step 4: Generate orchestration data

Call the `get_orchestration_data` MCP tool to get pipeline status, Ralph loop state, and event timeline.

Save the result to `.canon/orchestration-data.json`.

### Step 5: Present summary and open

```
Canon Dashboard Ready:
  Graph: {N} nodes, {M} edges
  Principles: {P} loaded
  Orchestration: {E} events

Dashboard: .canon/dashboard/index.html
```

To serve the dashboard (required for data loading), start a local server:
```bash
cd .canon && python3 -m http.server 8080 &
```

Then open in a browser:
```bash
open http://localhost:8080/dashboard/ || xdg-open http://localhost:8080/dashboard/ || echo "Open http://localhost:8080/dashboard/ in your browser"
```

**Important:** The dashboard uses `fetch()` to load data files, which requires HTTP serving — opening the HTML file directly via `file://` won't load data due to browser security restrictions.
