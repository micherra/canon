---
description: Generate rich contextual summaries for all source files in the codebase graph
argument-hint: [--batch-size 10] [--layer api] [--file src/path.ts]
allowed-tools: [Bash, Read, Glob, Grep]
model: sonnet
---

Generate detailed, contextual summaries for each source file in the codebase. Summaries explain a file's role in the project architecture, its key relationships, and what it does.

## Instructions

### Step 1: Generate the codebase graph

Call the `codebase_graph` MCP tool to get the current graph data. Save the output to `.canon/graph-data.json`.

### Step 2: Determine files to summarize

By default, summarize all files in the graph. Apply filters:
- If `--layer` is provided, only summarize files in that layer
- If `--file` is provided, only summarize that single file
- Skip files that already have summaries in `.canon/summaries.json` unless `--force` is passed

### Step 3: Generate summaries in batches

For each file (or batch of files):

1. Call `get_file_context` with the file path to get:
   - File source code (up to 200 lines)
   - Architectural layer
   - Import dependencies (what it imports)
   - Reverse dependencies (what imports it)
   - Exported names (functions, classes, constants)
   - Compliance data (violations, last verdict)

2. Write a rich, holistic summary that covers:
   - **What the file does** — its purpose and responsibility in the system
   - **How it fits in the architecture** — which layer it belongs to and why
   - **Key relationships** — what it depends on, what depends on it, and why those relationships matter
   - **What it exports** — the public API surface and what consumers use
   - **Any concerns** — violations, high coupling, or architectural issues

   The summary should read like documentation written by someone who deeply understands the project. It should help a new developer understand not just *what* the code does, but *why* it exists and how it connects to everything else.

3. Call `store_summaries` with the batch of generated summaries.

Use a batch size of 10 files (or the `--batch-size` value). Show progress after each batch.

### Step 4: Deploy dashboard

After all summaries are generated:
1. Call `deploy_dashboard` to rebuild the dashboard with summaries embedded in graph nodes
2. Report results:

```
Summaries Generated:
  Files summarized: {N}
  Total summaries stored: {T}
  Stored at: .canon/summaries.json

Dashboard updated at .canon/dashboard.html
Click any node in the graph to see its summary.
```
