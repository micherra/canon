---
description: Generate all Canon dashboard data and open the unified UI
argument-hint: [--open] [--diff-base main]
allowed-tools: [Bash, Read, Glob]
model: haiku
---

Generate data for all Canon dashboard views and optionally open the UI in a browser.

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

### Step 4: Present summary

```
Canon Dashboard Data Generated:
  Graph: {N} nodes, {M} edges
  Principles: {P} loaded
  Orchestration: {E} events

View: Open ui/index.html in a browser
```

### Step 5: Open UI (if --open)

If `--open` is provided:
```bash
open ui/index.html || xdg-open ui/index.html || echo "Open ui/index.html in your browser"
```
