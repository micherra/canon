---
description: Generate all Canon dashboard data including file summaries and open the UI
argument-hint: [--open] [--diff-base main] [--skip-summaries]
allowed-tools: [Bash, Read, Glob, Write]
model: sonnet
---

Generate data for all Canon dashboard views — codebase graph, insights, file summaries — and open a self-contained HTML dashboard.

## Instructions

### Step 1: Generate graph data

Call the `codebase_graph` MCP tool to scan the codebase and generate the dependency graph with compliance overlay and structural insights.

If `--diff-base` is provided, get changed files first:
```bash
git diff {diff_base}..HEAD --name-only
```
Pass these as `changed_files` to the tool.

Save the result to `.canon/graph-data.json`.

### Step 2: Generate file summaries

Unless `--skip-summaries` is provided, generate summaries for all files in the graph that don't already have one in `.canon/summaries.json`.

For each file (in batches of 10):

1. Call `get_file_context` with the file path to get its source code, graph context (imports, dependents, exports, layer), and compliance data.

2. Write a rich, contextual summary that explains:
   - What the file does and its responsibility in the system
   - How it fits in the architecture (layer, relationships)
   - What it exports and what depends on it
   - Any concerns (violations, high coupling)

   The summary should read like documentation written by someone who deeply understands the project.

3. Call `store_summaries` with the batch.

Show progress: "Summarized {N}/{T} files..."

### Step 3: Deploy dashboard

Call the `deploy_dashboard` MCP tool. This reads graph data and summaries from `.canon/`, embeds them into a self-contained HTML file, and writes it to `.canon/dashboard.html`.

### Step 4: Present summary and open

```
Canon Dashboard Ready:
  Graph: {N} nodes, {M} edges across {L} layers
  Insights: {C} cycles, {V} layer violations, {O} orphans
  Summaries: {S} files summarized

Open: .canon/dashboard.html
```

Open in browser:
```bash
open .canon/dashboard.html || xdg-open .canon/dashboard.html || echo "Open .canon/dashboard.html in your browser"
```
