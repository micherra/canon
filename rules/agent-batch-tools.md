---
id: agent-batch-tools
severity: strong-opinion
tags: [agent-behavior, efficiency, mcp]
scope:
  agents: all
---

# Prefer Batch MCP Tools for Multi-File Operations

When working with 3 or more files, prefer `get_context` over N sequential single-file lookups.

## Batching context lookups

`get_context` accepts a `file_paths[]` array and batches principles, file_context, drift, and graph data into one MCP round-trip. Use it instead of calling `get_file_context` or `get_principles` individually for each file.

**Prefer:**
```
get_context({ file_paths: ["src/a.ts", "src/b.ts", "src/c.ts"], include: ["principles", "file_context"] })
```

**Avoid:**
```
get_file_context("src/a.ts")
get_file_context("src/b.ts")
get_file_context("src/c.ts")
```

Sequential calls for N files require N round-trips. The batch call requires one. The observable impact is significant: agents using sequential lookups for dependency analysis may issue 50+ individual tool calls where 1–3 batch calls would suffice.

## Dependency graph queries

Prefer `codebase_graph` for dependency graph queries over manual `Grep`-based import tracing. `codebase_graph` returns a pre-computed dependency graph with layer data, violations, and blast radius — grep-based tracing reconstructs this from raw text, misses transitive dependencies, and has no layer awareness.

## Natural skip condition

This rule applies when working with 3 or more files. Agents fixing one specific file naturally work with a single-file scope and skip batching.
