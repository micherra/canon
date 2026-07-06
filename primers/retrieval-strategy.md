---
title: Retrieval Strategy
description: Choosing the right codebase retrieval tool along the exact-match-to-semantic spectrum.
---

# Retrieval Strategy

## Mental Models

**The Retrieval Spectrum** -- Retrieval tools form a spectrum from exact-match to semantic.
At one end: Grep and Glob find exact strings and file patterns with zero ambiguity.
At the other: semantic_search finds conceptual matches by meaning, tolerating paraphrasing.
In between: graph_query and get_file_context provide structural relationships (callers, callees, imports, blast radius) that neither text search nor semantic search can answer.

**Lexical Search Dominates for Known Identifiers** -- When you can name the exact function,
class, variable, import path, or error message, Grep will find it faster and with higher
precision than semantic_search. This holds across all model strengths -- research shows Grep
exceeds vector search for literal span recovery in every harness-model combination.

**Semantic Search Wins for Unknown Naming** -- When you cannot predict the exact string --
"where is authentication handled?", "which files do input validation?" -- semantic_search
finds conceptually related code by embedding similarity. Grep would require you to guess
the exact function or variable name.

**Noise Scales with Session Length** -- Long sessions accumulate search results, prior
context, and intermediate outputs. This noise degrades the effectiveness of subsequent
searches. Prefer narrow, targeted searches over broad sweeps. Read top-N results, not all.

## Decision Frameworks

**Tool Selection by Query Shape**:

| Query shape | Tool | Example |
|------------|------|---------|
| Exact identifier (function, class, variable) | Grep | `grep "parseMarkdown"` |
| Exact string (error message, config key, literal) | Grep | `grep "SQLITE_BUSY"` |
| File pattern or extension | Glob | `glob "src/**/*.test.ts"` |
| Directory structure discovery | Glob | `glob "features/*/tools/*.ts"` |
| Import path or module reference | Grep | `grep "from \"@shared/lib"` |
| Conceptual query (what does X?) | semantic_search | "authentication middleware" |
| Paraphrased intent (where is X handled?) | semantic_search | "error recovery logic" |
| Callers/callees of a function | graph_query | `graph_query({ query_type: "callers", target: "initWorkspace" })` |
| Blast radius of a file change | graph_query | `graph_query({ query_type: "blast_radius", target: "src/foo.ts" })` |
| File role, imports, exports, metrics | get_file_context | `get_file_context({ file_path: "src/foo.ts" })` |
| Dead code detection | graph_query | `graph_query({ query_type: "dead_code" })` |

**When Unsure**: If you can quote the exact string, use Grep. If you are describing a concept, use semantic_search.

**File Discovery Before Content Search**: When looking for files, always try Glob first. Glob is cheaper (no content scanning) and answers "which files match this pattern?" directly. Use Grep only after Glob does not provide enough specificity.

## Failure Modes

**Semantic search for exact identifiers** -- Using semantic_search with query
"initWorkspace" when Grep would return the exact definition. Semantic search
introduces embedding noise and may rank unrelated files higher than the definition site.

**Grep for conceptual queries** -- Using Grep with query "error handling" will only
find files containing that literal string, missing files that handle errors via
Result types, try/catch, or named error classes without the phrase "error handling."

**Sequential Grep narrowing** -- Calling Grep 5 times with progressively specific
queries when a single semantic_search would have found the right files. Each Grep
call consumes context; chaining many is expensive.

**Ignoring graph_query for structural questions** -- Using Grep to find "who calls
this function" by searching for the function name. This misses dynamic calls, re-exports,
and aliased imports. graph_query traverses the actual dependency graph.

**Reading all results** -- Consuming 50 search results when the top 5 contain the
answer. Extra results are noise that degrades subsequent work quality.

## Guardrails

**Grep-first for identifiers** -- If the query is a camelCase, PascalCase, or
snake_case identifier, or contains dots/slashes (a path), use Grep.

**Limit result consumption** -- Read the top 5-10 results from any search.
If the answer is not there, refine the query rather than reading more results.

**Glob before Grep for file discovery** -- Glob is O(directory traversal), Grep is
O(file content scan). For "find files named X" or "find files in directory Y",
Glob is always cheaper.

**One search, then act** -- Avoid search-search-search chains. Make one well-formed
query, read the results, then act on what you found. If the first search misses,
switch tools (Grep to semantic_search or vice versa) rather than repeating the same tool.

**Graph for dependencies** -- Any question containing "depends on", "imports",
"callers", "callees", "blast radius", or "impact" should use graph_query or
get_file_context, not text search.
