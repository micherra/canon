---
description: Generate and view the codebase dependency graph with Canon compliance overlay
argument-hint: [--diff-base main] [--open] [--violations-only]
allowed-tools: [Bash, Read, Glob, Grep]
model: haiku
---

Generate a visual dependency graph of the codebase with Canon principle compliance data overlaid.

## Instructions

### Step 1: Generate graph data

Call the `codebase_graph` MCP tool to scan the codebase:
- Scans all source files (ts, js, tsx, jsx, py, go, rs)
- Extracts import/dependency edges
- Infers architectural layers per file
- Overlays violation data from reviews.jsonl

If `--diff-base` is provided, also get the list of changed files:
```bash
git diff {diff_base}..HEAD --name-only
```
Pass these as `changed_files` to the tool.

### Step 2: Write the data

Save the JSON output to `.canon/graph-data.json`.

### Step 3: Present summary

Display a summary:
```
Codebase Graph Generated:
  Nodes: {N} files across {L} layers
  Edges: {M} import dependencies
  Hotspots: {K} files with violations

Layers:
  api: {N} files (blue)
  domain: {N} files (purple)
  ...

Top Hotspots:
  src/api/orders.ts — 5 violations (thin-handlers, validate-at-trust-boundaries)
  ...

View: Open ui/graph.html in a browser (data at .canon/graph-data.json)
```

If `--open` is provided, try to open the viewer:
```bash
# Try common browser commands
open ui/graph.html || xdg-open ui/graph.html || echo "Open ui/graph.html in your browser"
```

If `--violations-only` is provided, mention that the UI can be filtered to show only files with violations.
