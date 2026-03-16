---
description: Generate all Canon dashboard data and open the unified UI
argument-hint: [--open] [--diff-base main]
allowed-tools: [Bash, Read, Glob, Write]
model: haiku
---

Generate data for all Canon dashboard views and open a self-contained HTML dashboard.

## Instructions

### Step 1: Generate graph data

Call the `codebase_graph` MCP tool to scan the codebase and generate the dependency graph with compliance overlay.

If `--diff-base` is provided, get changed files first:
```bash
git diff {diff_base}..HEAD --name-only
```
Pass these as `changed_files` to the tool.

Save the result to `.canon/graph-data.json`.

### Step 2: Generate principles data

Call the `list_principles` MCP tool to get all principles. Then call `get_compliance` to get compliance stats.

Merge the results into a single object:
```json
{
  "principles": [ /* list_principles output with compliance_rate added */ ],
  "generated_at": "ISO timestamp"
}
```

Save to `.canon/principles-data.json`.

### Step 3: Generate orchestration data

Call the `get_orchestration_data` MCP tool to get pipeline status, Ralph loop state, and event timeline.

Save the result to `.canon/orchestration-data.json`.

### Step 4: Deploy dashboard

Call the `deploy_dashboard` MCP tool. This reads the data files from `.canon/`, embeds them into a self-contained HTML file, and writes it to `.canon/dashboard.html`. No web server needed — it opens directly in any browser.

### Step 5: Present summary and open

```
Canon Dashboard Ready:
  Graph: {N} nodes, {M} edges
  Principles: {P} loaded
  Orchestration: {E} events

Open: .canon/dashboard.html
```

Open in browser:
```bash
open .canon/dashboard.html || xdg-open .canon/dashboard.html || echo "Open .canon/dashboard.html in your browser"
```
