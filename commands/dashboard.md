---
description: "Canon dashboard — generate graph, summarize files, deploy UI, or serve live. Subcommands: graph | summarize | ui | serve (default: full pipeline)"
argument-hint: "[graph|summarize|ui|serve] [--diff-base main] [--skip-summaries] [--open]"
allowed-tools: [Bash, Read, Glob, Write]
model: sonnet
---

Canon dashboard with subcommands. Parse the first positional argument to determine the mode:

- **No subcommand** → run the full pipeline (graph → summarize → ui)
- **`graph`** → generate the dependency graph only
- **`summarize`** → generate file summaries only (graph must exist)
- **`ui`** → deploy the HTML dashboard and open it (graph must exist)
- **`serve`** → deploy + start a live HTTP server with API endpoints

## Subcommand: `graph`

Generate the codebase dependency graph with Canon compliance overlay.

1. If `--diff-base` is provided, get changed files:
```bash
git diff {diff_base}..HEAD --name-only
```
Pass these as `changed_files` to the tool.

2. Call the `codebase_graph` MCP tool. This scans source files, resolves imports, infers layers, and attaches compliance data.

3. Print the summary:
```
Canon Graph Generated:
  {N} nodes, {M} edges across {L} layers
  Insights: {C} cycles, {V} layer violations, {O} orphans
  Hotspots: {list top 3 hotspot files}
  Saved to .canon/graph-data.json
```

## Subcommand: `summarize`

Generate rich file summaries for all graph nodes missing a summary.

1. Check that `.canon/graph-data.json` exists. If not, tell the user to run `/canon:dashboard graph` first.

2. Call `deploy_dashboard` to get the `unsummarized_files` list (this also refreshes graph data).

3. For each unsummarized file (in batches of 10):
   a. Call `get_file_context` with the file path to get source, graph context, and compliance data.
   b. Write a rich, contextual summary that explains:
      - What the file does and its responsibility
      - How it fits in the architecture (layer, relationships)
      - What it exports and what depends on it
      - Any concerns (violations, high coupling)
   c. Call `store_summaries` with the batch.

4. Print progress: "Summarized {N}/{T} files..."

## Subcommand: `ui`

Deploy the self-contained HTML dashboard and open it.

1. Call the `deploy_dashboard` MCP tool. This reads graph data and summaries from `.canon/`, embeds them into `.canon/dashboard.html`.

2. If there are unsummarized files, mention it:
   `{N} files still need summaries — run /canon:dashboard summarize to enrich.`

3. Open in browser:
```bash
open .canon/dashboard.html || xdg-open .canon/dashboard.html || echo "Open .canon/dashboard.html in your browser"
```

## Subcommand: `serve`

Deploy and start a live HTTP server with API endpoints for interactive querying.

1. Call the `deploy_dashboard` MCP tool to generate the dashboard HTML.

2. If there are unsummarized files, mention it:
   `{N} files still need summaries — run /canon:dashboard summarize to enrich.`

3. Print the URL:
```
Canon Dashboard serving at {url}
  Live API: /api/ask, /api/file, /api/branch
  Open: {url}
```

## No subcommand (full pipeline)

Run the complete pipeline: graph → summarize → ui.

1. **Graph**: Run the `graph` subcommand logic above.

2. **Summarize**: Unless `--skip-summaries` is passed, run the `summarize` subcommand logic above.

3. **UI**: Run the `ui` subcommand logic above.

4. Print final summary:
```
Canon Dashboard Ready:
  Graph: {N} nodes, {M} edges across {L} layers
  Insights: {C} cycles, {V} layer violations, {O} orphans
  Summaries: {S} files summarized

Open: .canon/dashboard.html
```
