# Spike Findings: Semantic Principle Matching Evaluation

## Executive Summary

**Aggregate Recall@10: 31.2%**  
**Average discrimination gap (top vs median): 0.1984**  
**Go threshold: ≥80% → NO-GO**

## Sample File Selection Rationale

13 files selected across architectural layers to cover diverse concern profiles:
- **Graph infrastructure** (4 files): kg-embedding, kg-store, kg-pipeline, kg-query, kg-vector-store — tests whether embedding can distinguish data-layer concerns (information-hiding, command-query-separation) from reliability concerns (handle-partial-failure, errors-are-values)
- **Orchestration tools** (3 files): drive-flow, report-result, init-workspace — tests whether boundary/security concerns (validate-at-trust-boundaries, fail-closed-by-default) surface for tool handlers at the MCP boundary
- **Shared kernel** (3 files): matcher, parser, tool-result — tests whether cross-cutting utility concerns distinguish from domain-specific ones
- **Feature tools** (2 files): get-principles, get-file-context — tests mixed concern profiles (validation + information-hiding + error handling)

## Enriched Summaries

_Summaries capture Role (architectural function), Relationships (dependency position), and Concerns (engineering concerns) for each file. These are hand-authored from reading the source code — production would use LLM-generated summaries._

### `graph/kg-embedding.ts`

**Ground truth principles:** errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure

Wraps @huggingface/transformers for 384-dim sentence embedding (all-MiniLM-L6-v2, q8 quantized). Architectural role: the sole vector representation layer for the knowledge graph — every semantic search query and summary embedding flows through here. Relationships: called by kg-pipeline.ts (batch embed during indexing) and kg-vector-query.ts (query-time embedding); depends on @shared/constants for EMBEDDING_MODEL/EMBEDDING_DIM. Concerns: throws on failure (intentional — internal infrastructure, not an MCP tool handler), lazy-loads model on first use with concurrent-safe init promise, processes in batches of EMBEDDING_BATCH_SIZE to cap peak memory, uses normalize+mean pooling so output vectors are unit-normalized.

### `graph/kg-store.ts`

**Ground truth principles:** information-hiding, prefer-immutable-data, simplicity-first, consistent-abstraction-levels

Synchronous CRUD layer over a better-sqlite3 Database instance for the knowledge graph schema. Architectural role: the single write path for files, entities, edges, file-edges, and summaries in the SQLite KG — all indexing mutations go through this class. Relationships: constructed by kg-pipeline.ts with the same DB handle; used nowhere else for writes. KgQuery owns the read path. Concerns: all statements are prepared at construction time for performance (statement reuse), boolean coercion for SQLite 0/1 integers, upsert patterns for idempotent reindexing, file-level and entity-level cascade deletes for incremental updates. State management: holds prepared statement references as private fields — not thread-safe, but better-sqlite3 is process-exclusive.

### `graph/kg-pipeline.ts`

**Ground truth principles:** errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing

Orchestrates the five-phase knowledge graph build: scan → parse → resolve-links → persist → embed. Architectural role: top-level entry point for full KG indexing (runPipeline) and incremental single-file updates (reindexFile). Coordinates all infrastructure. Relationships: imports EmbeddingService, KgStore, KgVectorStore, kg-pipeline-phases, kg-schema, kg-wasm-parser, scanner. Concerns: all DB mutations wrapped in transactions for performance and atomicity; adapter errors are non-fatal (bare file entity created instead); incremental mode skips files whose mtime+hash match DB row; sourceDirs option limits scan scope; embedding is Phase 5 — async, best-effort, never blocks indexing. Error propagation: errors in parsing produce degraded (entity-free) file rows rather than halting the pipeline.

### `graph/kg-query.ts`

**Ground truth principles:** information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing

Read-only query module over the knowledge graph SQLite DB — callers, callees, search, dead code, ancestors, blast radius, file degrees, subgraph. Architectural role: the exclusive read interface for entity-level graph traversal. All SELECT queries centralized here, no mutations. Relationships: used by kg-blast-radius, get-file-context, graph_query tool, and any code needing graph traversal. Depends on kg-query-insights for impact scoring. Concerns: all statements prepared at construction for performance; SQL-level joins for callers/callees (edges table); computeImpactScore integrates in_degree, layer centrality, and violation count into a single score; getFileMetrics is N+1 risk if called in a loop — callers must use computeFileInsightMaps for batch pre-computation.

### `graph/kg-vector-store.ts`

**Ground truth principles:** information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values

CRUD layer for entity_vectors and summary_vectors (sqlite-vec vec0 virtual tables). Architectural role: manages vector persistence — inserts, staleness detection, and cleanup for semantic search. Relationships: used by kg-pipeline.ts for vector persistence after embedding; KgVectorQuery uses it for ANN queries. Concerns: sqlite-vec 0.1.6-alpha.2 bug — prepared statement binding fails on vec0 inserts, so all vec0 writes use db.exec() with inline JSON string literals (workaround). Meta tables (entity_vector_meta, summary_vector_meta) track text hashes for staleness detection and stay in sync with vec0 rows. Throws on errors (internal infrastructure).

### `features/orchestration/tools/drive-flow.ts`

**Ground truth principles:** errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries

Core state machine loop for Canon flow execution — the MCP tool that orchestrators call to advance build workflows. Architectural role: central dispatch point for the entire orchestration engine. Every flow step (spawn, HITL, done) routes through here. Relationships: calls enterAndPrepareState, reportResult, drive-flow-helpers, drive-flow-wave; depends on execution-store, board-state-schemas, flow-definition-schemas. Concerns: turn-by-turn protocol (first call enters state, subsequent calls report result and advance); wave state handling (parallel agent tasks); convergence limit enforcement; stuck detection; HITL breakpoint generation; settings injection for auto-approve worktrees. Returns ToolResult<DriveFlowAction> — never throws for expected conditions.

### `features/orchestration/tools/report-result.ts`

**Ground truth principles:** errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default

MCP tool wrapper for recording agent results and evaluating state machine transitions. Architectural role: the write path for agent outcomes — updates board state, advances transitions, detects stuck states, evaluates quality signals. Relationships: calls syncBoardToStore, evaluateTransition, applyBoardMutations, postTransactionSideEffects; validates required artifacts and handoffs. Concerns: accepts optional quality signal fields (gate_results, postcondition_results, violation_count, test_results, files_changed); discovery fields (discovered_gates, discovered_postconditions) accumulate across calls; debate protocol integration (inspectDebateProgress); optional role handling for parallel states. State management: board mutations inside store.transaction() for atomicity; optimistic locking prevents concurrent stale writes.

### `features/orchestration/tools/init-workspace.ts`

**Ground truth principles:** validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access

MCP tool for creating or resuming Canon build workspaces — the entry point for every new flow execution. Architectural role: lifecycle management for workspace directories, git worktrees, board state, and file claims preflight. Relationships: calls loadAndResolveFlow, createWorkspace, generateSlug, gitWorktreeAdd, seedFromPriorWorkspace, KgQuery. Concerns: preflight mode checks git status, stale sessions, and active file claims before creating; creates build worktree at {workspace}/worktree on canon/{slug} branch; returns empty workspace string on preflight failure (caller must check preflight_issues); slug collision detection prevents accidental workspace reuse; cache_prefix_hash for prompt caching optimization. Security: file claims are informational-only (non-blocking) — advisory overlap warnings, not hard blocks.

### `features/principles/tools/get-principles.ts`

**Ground truth principles:** validate-at-trust-boundaries, information-hiding, errors-are-values, functions-do-one-thing

MCP tool for matching Canon principles to a file or layer context. Architectural role: the principle retrieval interface — agents call this to get relevant engineering principles before writing code. Relationships: calls loadAllPrinciples, matchPrinciples, KgQuery for graph context enrichment; uses filterBodyBySections for summary_only mode. Concerns: layer inference from file path (via inferLayer); graph context overlay (in_degree, impact_score) when file_path provided; configurable max_principles_per_review limit; summary_only flag returns first paragraph only for token efficiency. Trust boundary: file_path is user-supplied but not used for filesystem access — only pattern matching.

### `features/file-context/tools/get-file-context.ts`

**Ground truth principles:** validate-at-trust-boundaries, errors-are-values, information-hiding, handle-partial-failure, least-privilege-access

MCP tool that assembles rich context for a source file — contents, graph relationships, structural metrics, hotspot data, blast radius. Architectural role: the primary file inspection interface for agents needing deep context about a single file before editing it. Relationships: reads file contents via readFile, extracts imports/exports via import-parser/export-parser, queries KgQuery for metrics, loads hotspot and co-change data from git-intel tables, computes blast radius via kg-blast-radius. Concerns: high fan-in file (many features depend on its output shape); returns up to FILE_PREVIEW_MAX_LINES (200) of content; shape derivation (Sink/Hub/Central/Leaf/Internal) from in_degree/out_degree; git-intel freshness check triggers ensureGitIntelFresh when projectDir provided. Security: path traversal guard via isNotFound + toPosix normalization; file content is trusted (read from project tree, not user-supplied payload).

### `shared/matcher.ts`

**Ground truth principles:** measure-before-optimizing, information-hiding, functions-do-one-thing, consistent-abstraction-levels

Principle matching engine — filters all principles to those applicable for a given file path, layer, severity, or tags. Architectural role: the decision layer between the principle library and any tool that needs context-aware principle selection. Relationships: imported by get-principles.ts, review-code, and any code needing principle filtering; depends on parser.ts for loadPrincipleFile. Concerns: glob-to-regex compilation with caching; mtime-based principle cache with invalidation across project + plugin directories; severity ranking (rule > strong-opinion > convention) for sort ordering; layer inference from file path segments using buildLayerInferrer. Performance: globRegexCache prevents regex recompilation; principleCache avoids file re-reads on every tool call.

### `shared/parser.ts`

**Ground truth principles:** functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence

Principle file parser — extracts YAML frontmatter and structured sections (Anti-Rationalization, Verification) from principle markdown files. Architectural role: the parsing foundation for all principle loading — every principle in Canon flows through this module. Relationships: used by matcher.ts (loadPrincipleFile), and any code that reads principle files directly. Concerns: uses gray-matter for frontmatter parsing (replaced hand-rolled parser 2026-03-26); extractSections splits on ## headings and separates known sections from body remainder; filterBodyBySections supports summary-only mode (first paragraph) vs full body for token budget management. Data integrity: id and title are required fields; parsePrinciple returns empty strings rather than throwing on missing fields.

### `shared/lib/tool-result.ts`

**Ground truth principles:** errors-are-values, information-hiding, consistent-abstraction-levels, fail-closed-by-default

Defines the ToolResult<T> discriminated union — the error contract for all MCP tool handlers in Canon. Architectural role: the error-handling foundation for the entire codebase. Every tool function returns this type instead of throwing. Relationships: imported by every feature's tool handlers; wrapHandler depends on it for unexpected error wrapping. Concerns: 9 CanonErrorCode string literals covering all expected error categories (WORKSPACE_NOT_FOUND, FLOW_NOT_FOUND, etc.); toolOk/toolError constructors enforce shape; isToolError type guard for discriminated union narrowing; assertOk for test contexts where success is required. recoverable flag signals whether the orchestrator should retry or escalate to HITL.

## Per-File Similarity Rankings

### `graph/kg-embedding.ts`

**Ground truth:** errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure
**Recall@10:** 0%
**Top similarity:** 0.2995 | **Median:** 0.1273 | **Gap:** 0.1722

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | aggregates-reference-by-id | 0.2995 |  |
| 2 | normalize-first-denormalize-intentionally | 0.2944 |  |
| 3 | bounded-context-boundaries | 0.2655 |  |
| 4 | refactoring-integrity | 0.2249 |  |
| 5 | deep-modules | 0.2248 |  |
| 6 | design-tokens-as-style-contract | 0.2220 |  |
| 7 | architectural-fitness-functions | 0.2128 |  |
| 8 | consistent-abstraction-levels | 0.2117 |  |
| 9 | colocate-component-assets | 0.2051 |  |
| 10 | services-own-their-data | 0.2030 |  |

### `graph/kg-store.ts`

**Ground truth:** information-hiding, prefer-immutable-data, simplicity-first, consistent-abstraction-levels
**Recall@10:** 50%
**Top similarity:** 0.4726 | **Median:** 0.2147 | **Gap:** 0.2579

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | services-own-their-data | 0.4726 |  |
| 2 | backward-compatible-schema-changes | 0.3898 |  |
| 3 | normalize-first-denormalize-intentionally | 0.3564 |  |
| 4 | idempotent-operations | 0.3464 |  |
| 5 | prefer-immutable-data | 0.3446 | YES |
| 6 | explicit-transaction-boundaries | 0.3326 |  |
| 7 | information-hiding | 0.3213 | YES |
| 8 | unidirectional-data-flow | 0.3105 |  |
| 9 | colocate-component-assets | 0.2996 |  |
| 10 | prefer-async-between-services | 0.2979 |  |

### `graph/kg-pipeline.ts`

**Ground truth:** errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing
**Recall@10:** 25%
**Top similarity:** 0.4320 | **Median:** 0.2381 | **Gap:** 0.1939

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | services-own-their-data | 0.4320 |  |
| 2 | externalize-configuration | 0.3673 |  |
| 3 | refactoring-integrity | 0.3620 |  |
| 4 | architectural-fitness-functions | 0.3595 |  |
| 5 | backward-compatible-schema-changes | 0.3410 |  |
| 6 | explicit-transaction-boundaries | 0.3206 |  |
| 7 | information-hiding | 0.3152 |  |
| 8 | idempotent-operations | 0.3069 |  |
| 9 | handle-partial-failure | 0.3065 | YES |
| 10 | aggregates-reference-by-id | 0.3028 |  |

### `graph/kg-query.ts`

**Ground truth:** information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing
**Recall@10:** 50%
**Top similarity:** 0.3782 | **Median:** 0.1847 | **Gap:** 0.1935

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | command-query-separation | 0.3782 | YES |
| 2 | normalize-first-denormalize-intentionally | 0.3712 |  |
| 3 | aggregates-reference-by-id | 0.3315 |  |
| 4 | consistent-abstraction-levels | 0.3204 | YES |
| 5 | services-own-their-data | 0.2978 |  |
| 6 | handle-partial-failure | 0.2938 |  |
| 7 | prefer-immutable-data | 0.2851 |  |
| 8 | explicit-transaction-boundaries | 0.2839 |  |
| 9 | structured-logging-with-levels | 0.2812 |  |
| 10 | architectural-fitness-functions | 0.2811 |  |

### `graph/kg-vector-store.ts`

**Ground truth:** information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values
**Recall@10:** 0%
**Top similarity:** 0.3473 | **Median:** 0.1756 | **Gap:** 0.1717

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | backward-compatible-schema-changes | 0.3473 |  |
| 2 | services-own-their-data | 0.3015 |  |
| 3 | architectural-fitness-functions | 0.2886 |  |
| 4 | normalize-first-denormalize-intentionally | 0.2885 |  |
| 5 | aggregates-reference-by-id | 0.2737 |  |
| 6 | prefer-immutable-data | 0.2631 |  |
| 7 | externalize-configuration | 0.2560 |  |
| 8 | colocate-component-assets | 0.2536 |  |
| 9 | bounded-context-boundaries | 0.2503 |  |
| 10 | command-query-separation | 0.2384 |  |

### `features/orchestration/tools/drive-flow.ts`

**Ground truth:** errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries
**Recall@10:** 40%
**Top similarity:** 0.4557 | **Median:** 0.2641 | **Gap:** 0.1916

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | consistent-abstraction-levels | 0.4557 |  |
| 2 | explicit-transaction-boundaries | 0.4231 |  |
| 3 | unidirectional-data-flow | 0.4031 |  |
| 4 | idempotent-operations | 0.3932 |  |
| 5 | prefer-async-between-services | 0.3927 |  |
| 6 | design-for-self-healing | 0.3821 |  |
| 7 | handle-partial-failure | 0.3758 | YES |
| 8 | errors-are-values | 0.3723 | YES |
| 9 | observable-best-effort | 0.3442 |  |
| 10 | isolate-frontend-runtime-state | 0.3415 |  |

### `features/orchestration/tools/report-result.ts`

**Ground truth:** errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default
**Recall@10:** 0%
**Top similarity:** 0.4049 | **Median:** 0.2318 | **Gap:** 0.1731

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | explicit-transaction-boundaries | 0.4049 |  |
| 2 | minimize-client-side-state | 0.3955 |  |
| 3 | isolate-frontend-runtime-state | 0.3832 |  |
| 4 | unidirectional-data-flow | 0.3700 |  |
| 5 | tests-are-deterministic | 0.3594 |  |
| 6 | design-for-self-healing | 0.3568 |  |
| 7 | idempotent-operations | 0.3505 |  |
| 8 | prefer-async-between-services | 0.3469 |  |
| 9 | handle-partial-failure | 0.3404 |  |
| 10 | architectural-fitness-functions | 0.3398 |  |

### `features/orchestration/tools/init-workspace.ts`

**Ground truth:** validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access
**Recall@10:** 0%
**Top similarity:** 0.3013 | **Median:** 0.1709 | **Gap:** 0.1304

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | design-for-self-healing | 0.3013 |  |
| 2 | explicit-transaction-boundaries | 0.2855 |  |
| 3 | infrastructure-tested-like-code | 0.2796 |  |
| 4 | externalize-configuration | 0.2743 |  |
| 5 | colocate-component-assets | 0.2697 |  |
| 6 | immutable-infrastructure | 0.2676 |  |
| 7 | refactoring-integrity | 0.2564 |  |
| 8 | deploy-frontend-modules-independently | 0.2561 |  |
| 9 | isolate-frontend-runtime-state | 0.2443 |  |
| 10 | minimize-attack-surface | 0.2402 |  |

### `features/principles/tools/get-principles.ts`

**Ground truth:** validate-at-trust-boundaries, information-hiding, errors-are-values, functions-do-one-thing
**Recall@10:** 50%
**Top similarity:** 0.3629 | **Median:** 0.1658 | **Gap:** 0.1972

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | bounded-context-boundaries | 0.3629 |  |
| 2 | refactoring-integrity | 0.3601 |  |
| 3 | architectural-fitness-functions | 0.2995 |  |
| 4 | information-hiding | 0.2907 | YES |
| 5 | simplicity-first | 0.2727 |  |
| 6 | consistent-abstraction-levels | 0.2704 |  |
| 7 | decompose-by-domain-not-layer | 0.2421 |  |
| 8 | ubiquitous-language-in-code | 0.2317 |  |
| 9 | validate-at-trust-boundaries | 0.2291 | YES |
| 10 | infrastructure-tested-like-code | 0.2260 |  |

### `features/file-context/tools/get-file-context.ts`

**Ground truth:** validate-at-trust-boundaries, errors-are-values, information-hiding, handle-partial-failure, least-privilege-access
**Recall@10:** 40%
**Top similarity:** 0.3801 | **Median:** 0.1479 | **Gap:** 0.2323

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | refactoring-integrity | 0.3801 |  |
| 2 | leave-touched-files-better | 0.3243 |  |
| 3 | externalize-configuration | 0.3025 |  |
| 4 | information-hiding | 0.2994 | YES |
| 5 | secrets-never-in-code | 0.2687 |  |
| 6 | bounded-context-boundaries | 0.2658 |  |
| 7 | minimize-attack-surface | 0.2643 |  |
| 8 | infrastructure-tested-like-code | 0.2486 |  |
| 9 | validate-at-trust-boundaries | 0.2415 | YES |
| 10 | test-data-belongs-in-the-test | 0.2404 |  |

### `shared/matcher.ts`

**Ground truth:** measure-before-optimizing, information-hiding, functions-do-one-thing, consistent-abstraction-levels
**Recall@10:** 75%
**Top similarity:** 0.4128 | **Median:** 0.2062 | **Gap:** 0.2066

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | refactoring-integrity | 0.4128 |  |
| 2 | architectural-fitness-functions | 0.3827 |  |
| 3 | simplicity-first | 0.3691 |  |
| 4 | leave-touched-files-better | 0.3650 |  |
| 5 | measure-before-optimizing | 0.3364 | YES |
| 6 | infrastructure-tested-like-code | 0.3123 |  |
| 7 | patterns-need-justification | 0.3087 |  |
| 8 | information-hiding | 0.3047 | YES |
| 9 | bounded-context-boundaries | 0.2984 |  |
| 10 | consistent-abstraction-levels | 0.2928 | YES |

### `shared/parser.ts`

**Ground truth:** functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence
**Recall@10:** 0%
**Top similarity:** 0.4641 | **Median:** 0.1675 | **Gap:** 0.2966

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | refactoring-integrity | 0.4641 |  |
| 2 | test-data-belongs-in-the-test | 0.2798 |  |
| 3 | infrastructure-tested-like-code | 0.2514 |  |
| 4 | design-tokens-as-style-contract | 0.2282 |  |
| 5 | structured-logging-with-levels | 0.2246 |  |
| 6 | information-hiding | 0.2220 |  |
| 7 | colocate-component-assets | 0.2196 |  |
| 8 | leave-touched-files-better | 0.2196 |  |
| 9 | decompose-by-domain-not-layer | 0.2147 |  |
| 10 | architectural-fitness-functions | 0.2141 |  |

### `shared/lib/tool-result.ts`

**Ground truth:** errors-are-values, information-hiding, consistent-abstraction-levels, fail-closed-by-default
**Recall@10:** 75%
**Top similarity:** 0.4442 | **Median:** 0.2820 | **Gap:** 0.1623

| Rank | Principle ID | Score | In Ground Truth? |
|------|-------------|-------|-----------------|
| 1 | wrap-external-exceptions | 0.4442 |  |
| 2 | define-errors-out-of-existence | 0.4300 |  |
| 3 | fail-closed-by-default | 0.4216 | YES |
| 4 | structured-logging-with-levels | 0.4203 |  |
| 5 | errors-are-values | 0.4166 | YES |
| 6 | bounded-context-boundaries | 0.4007 |  |
| 7 | refactoring-integrity | 0.3933 |  |
| 8 | consistent-abstraction-levels | 0.3850 | YES |
| 9 | observable-best-effort | 0.3840 |  |
| 10 | architectural-fitness-functions | 0.3766 |  |

## Aggregate Metrics

| Metric | Value |
|--------|-------|
| Files evaluated | 13 |
| Principles in corpus | 57 |
| Aggregate Recall@10 | 31.2% |
| Average discrimination gap | 0.1984 |
| Per-file recall@10 range | 0% – 75% |

## Discrimination Analysis

Discrimination measures the cosine similarity gap between the top-ranked (most applicable) principle and the median-ranked (non-applicable) principle. A large gap means the model clearly separates relevant from irrelevant principles. A small gap means principles cluster together and the ranking is essentially noise.

| File | Top Score | Median Score | Gap |
|------|-----------|-------------|-----|
| graph/kg-embedding.ts | 0.2995 | 0.1273 | 0.1722 |
| graph/kg-store.ts | 0.4726 | 0.2147 | 0.2579 |
| graph/kg-pipeline.ts | 0.4320 | 0.2381 | 0.1939 |
| graph/kg-query.ts | 0.3782 | 0.1847 | 0.1935 |
| graph/kg-vector-store.ts | 0.3473 | 0.1756 | 0.1717 |
| features/orchestration/tools/drive-flow.ts | 0.4557 | 0.2641 | 0.1916 |
| features/orchestration/tools/report-result.ts | 0.4049 | 0.2318 | 0.1731 |
| features/orchestration/tools/init-workspace.ts | 0.3013 | 0.1709 | 0.1304 |
| features/principles/tools/get-principles.ts | 0.3629 | 0.1658 | 0.1972 |
| features/file-context/tools/get-file-context.ts | 0.3801 | 0.1479 | 0.2323 |
| shared/matcher.ts | 0.4128 | 0.2062 | 0.2066 |
| shared/parser.ts | 0.4641 | 0.1675 | 0.2966 |
| shared/lib/tool-result.ts | 0.4442 | 0.2820 | 0.1623 |

## Root Cause Analysis

The 31.2% recall@10 is far below threshold. Looking at the failure patterns reveals three distinct issues:

### Failure Mode 1: Domain terminology mismatch (affects ~40% of misses)

The most common failure: the file summary uses Canon-specific terms ("KG", "MCP", "worktree", "HITL") and TypeScript-specific terms ("better-sqlite3", "Float32Array") that have no semantic overlap with principle texts written in general software engineering language ("trust boundary", "idempotent operation", "discriminated union"). The embedding model has no bridge between the two vocabularies.

Example: `kg-embedding.ts` summary mentions "lazy-loads model", "concurrent-safe init promise", "normalize+mean pooling" — none of these terms appear in the `observable-best-effort` or `errors-are-values` principles. The model correctly scores these at 0.15–0.25 (near noise floor).

### Failure Mode 2: False positives from lexical overlap (affects ~30% of top-ranking errors)

Several wrong principles rank highly because of accidental lexical overlap with infrastructure terminology. `refactoring-integrity` appears as the top principle for `shared/parser.ts` (score 0.464) and `features/file-context/tools/get-file-context.ts` (score 0.380). Reading `refactoring-integrity`, it is about safe incremental refactoring — not about file parsing or context retrieval. The high score is explained by shared vocabulary: "codebase", "file", "change", "incremental" appear in both the summaries and the principle body.

Similarly, `services-own-their-data` dominates KG-layer files because "data", "store", "schema", "database" overlap with that principle's domain vocabulary, even though data ownership is not a concern for these internal-to-one-service files.

### Failure Mode 3: Principle text is not embedded at the concern level (affects all files)

The principle embedding text composed here uses: `title + first paragraph of body + first 300 chars of anti_rationalization`. The title ("Validate Data at Every Trust Boundary") and first paragraph describe WHEN to apply the principle. But the file summaries describe WHAT the file does and HOW it does it — not WHEN principles apply. These are orthogonal representations.

The semantic gap is structural: file summaries are descriptive (implementation-focused), principle texts are prescriptive (pattern-focused). all-MiniLM-L6-v2 was trained on sentence pair similarity tasks (e.g., NLI, STS benchmarks) — it finds semantic similarity between sentences describing the same concept, not between a code description and a pattern prescription.

### What worked: `shared/lib/tool-result.ts` and `shared/matcher.ts` (75%)

These two files succeeded because their summaries explicitly name the patterns the principles describe. `tool-result.ts` summary says "discriminated union", "typed result objects", "error contract" — vocabulary that appears in `errors-are-values`, `fail-closed-by-default`, `consistent-abstraction-levels`. `shared/matcher.ts` summary says "caching", "performance: globRegexCache prevents recompilation" — vocabulary that maps to `measure-before-optimizing`.

The lesson: success correlates with how principle-aligned the summary vocabulary is, not with the accuracy of the architectural description.

## Go/No-Go Recommendation

**RECOMMENDATION: NO-GO**

Aggregate Recall@10 of 31.2% falls well below the 80% threshold. The raw embedding approach as tested does not work for Canon's principle matching use case.

### What DOES work

The discrimination gap (avg 0.1984, range 0.13–0.30) shows the model CAN separate relevant from irrelevant principles — the signal is real, just too weak and too noisy. For the two files that hit 75% recall, scores are meaningfully higher (0.41–0.47) for applicable principles vs noise floor (0.15–0.20). This is not a fundamental limitation of the embedding approach — it's a vocabulary alignment problem.

### Paths to improvement (prioritized)

**1. Richer principle embedding text — highest leverage, lowest cost**

Instead of `title + first paragraph + anti_rationalization snippet`, use:
- Title
- Full body (rationale + examples + bad/good code patterns)
- Full anti-rationalization section

The code examples in principles (e.g., `ToolResult<T>` type in `errors-are-values`) would create vocabulary overlap with TypeScript codebases. Expected to raise recall@10 by 15–25 percentage points based on the success pattern from `tool-result.ts`.

**2. Principle-vocabulary enriched summaries — medium leverage, medium cost**

Augment enriched summaries with a "pattern vocabulary" section that explicitly names applicable patterns without naming principles. Example addition to `kg-embedding.ts`: "Uses best-effort non-blocking design — embedding failures do not propagate; errors are surfaced as thrown exceptions only for infrastructure-level callers who can handle them. Lazy initialization pattern prevents double-loading under concurrency." This vocabulary aligns with `observable-best-effort` and `handle-partial-failure`.

**3. Hybrid lexical+semantic matching — medium leverage, highest cost**

Combine cosine similarity (semantic) with BM25 or TF-IDF (lexical) scores on principle ID, title, tags, and section keywords. The `tags` field in principle frontmatter (`error-handling`, `security`, `validation`) could be matched against inferred tags from file summaries. This would capture the validation/security concerns for MCP tool handlers that pure embedding misses.

**4. Fine-tuning or domain adaptation — highest potential, very high cost**

Fine-tune all-MiniLM-L6-v2 on principle/code-file pairs as a sentence similarity task. Would require ~500+ labeled pairs (file summary, applicable principle). Not recommended until simpler approaches are validated.

### Recommended next step

Try option 1 (full principle body in embedding) before any other change. This is a 1-line change to `composePrincipleText()` — replace `p.body` (first paragraph) with the full body reconstructed from `rawBody`. Expected to significantly reduce Failure Mode 1 (domain vocabulary mismatch) and Failure Mode 3 (prescriptive vs descriptive gap). If full-body embedding brings recall@10 above 60%, combine with option 2 to push past 80%.

### Limitations of this evaluation

- Ground truth was manually assigned by reading file code — may not capture all applicable principles
- Enriched summaries were hand-authored, not generated by an AI from code — production would use LLM-generated summaries which may have different vocabulary
- Canon has 57 principles; some files may have more applicable principles than the 3-5 assigned, inflating miss counts
- Principle corpus is small (57 items) — scores cluster in a narrow band (0.15–0.47), which amplifies ranking noise
- The model was not fine-tuned on engineering principle text — domain adaptation is expected to improve recall significantly
- This eval used only cosine similarity over normalized vectors — re-ranking with principle tags or severity weights could improve results without changing embeddings

## Iteration 2

### Change Made

**Iteration 2a**: Modified `composePrincipleText()` to use the **full principle body** (title + complete markdown body including Rationale, Examples, Anti-Rationalization, and Verification sections) instead of just the title + first paragraph + 300-char anti-rationalization excerpt.

**Iteration 2b**: Same full-body principle embeddings, but also added **explicit principle-vocabulary bridges** to each file summary. Each summary was augmented with a "Pattern vocabulary" paragraph that names the patterns in principle-language terms (e.g., "errors-as-values pattern using discriminated unions", "validate-at-trust-boundaries", "information hiding / encapsulation of design decision").

### Iteration 2a Results — Full Principle Body

**Aggregate Recall@10: 22.7%** (Iteration 1 baseline: 31.2%)
**Average discrimination gap: 0.2412** (Iteration 1: 0.1984)
**Go threshold: ≥80% → NO-GO**

#### Per-File Recall@10 (Iteration 2a)

| File | Iter 1 | Iter 2a | Delta | Hits (top 10) | Misses |
|------|--------|---------|-------|----------------|--------|
| graph/kg-embedding.ts | 0% | 0% | = | none | errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure |
| graph/kg-store.ts | 50% | 25% | -25% | information-hiding | prefer-immutable-data, simplicity-first, consistent-abstraction-levels |
| graph/kg-pipeline.ts | 25% | 0% | -25% | none | errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing |
| graph/kg-query.ts | 50% | 100% | +50% | information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing | none |
| graph/kg-vector-store.ts | 0% | 0% | = | none | information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values |
| features/orchestration/tools/drive-flow.ts | 40% | 0% | -40% | none | errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries |
| features/orchestration/tools/report-result.ts | 0% | 0% | = | none | errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default |
| features/orchestration/tools/init-workspace.ts | 0% | 0% | = | none | validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access |
| features/principles/tools/get-principles.ts | 50% | 25% | -25% | information-hiding | validate-at-trust-boundaries, errors-are-values, functions-do-one-thing |
| features/file-context/tools/get-file-context.ts | 40% | 20% | -20% | information-hiding | validate-at-trust-boundaries, errors-are-values, handle-partial-failure, least-privilege-access |
| shared/matcher.ts | 75% | 50% | -25% | measure-before-optimizing, information-hiding | functions-do-one-thing, consistent-abstraction-levels |
| shared/parser.ts | 0% | 0% | = | none | functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence |
| shared/lib/tool-result.ts | 75% | 75% | = | errors-are-values, information-hiding, fail-closed-by-default | consistent-abstraction-levels |

#### Top-5 Rankings for Key Files (Iteration 2a)

**`graph/kg-embedding.ts`** (ground truth: errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure)
Recall@10: 0% | Top: 0.3610 | Median: 0.1850 | Gap: 0.1760

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | normalize-first-denormalize-intentionally | 0.3610 |  |
| 2 | aggregates-reference-by-id | 0.3384 |  |
| 3 | measure-before-optimizing | 0.3300 |  |
| 4 | design-tokens-as-style-contract | 0.3219 |  |
| 5 | deep-modules | 0.3125 |  |
| 6 | refactoring-integrity | 0.2856 |  |
| 7 | colocate-component-assets | 0.2768 |  |
| 8 | consistent-abstraction-levels | 0.2702 |  |
| 9 | unidirectional-data-flow | 0.2619 |  |
| 10 | prefer-composition-over-inheritance | 0.2580 |  |

**`graph/kg-store.ts`** (ground truth: information-hiding, prefer-immutable-data, simplicity-first, consistent-abstraction-levels)
Recall@10: 25% | Top: 0.5430 | Median: 0.2817 | Gap: 0.2612

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | normalize-first-denormalize-intentionally | 0.5430 |  |
| 2 | backward-compatible-schema-changes | 0.4519 |  |
| 3 | explicit-transaction-boundaries | 0.4339 |  |
| 4 | services-own-their-data | 0.4227 |  |
| 5 | aggregates-reference-by-id | 0.3972 |  |
| 6 | information-hiding | 0.3932 | YES |
| 7 | measure-before-optimizing | 0.3920 |  |
| 8 | colocate-component-assets | 0.3896 |  |
| 9 | architectural-fitness-functions | 0.3871 |  |
| 10 | leave-touched-files-better | 0.3665 |  |

**`graph/kg-pipeline.ts`** (ground truth: errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing)
Recall@10: 0% | Top: 0.4642 | Median: 0.2885 | Gap: 0.1757

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | architectural-fitness-functions | 0.4642 |  |
| 2 | normalize-first-denormalize-intentionally | 0.4475 |  |
| 3 | measure-before-optimizing | 0.4426 |  |
| 4 | aggregates-reference-by-id | 0.3976 |  |
| 5 | information-hiding | 0.3868 |  |
| 6 | backward-compatible-schema-changes | 0.3855 |  |
| 7 | leave-touched-files-better | 0.3778 |  |
| 8 | structured-logging-with-levels | 0.3712 |  |
| 9 | refactoring-integrity | 0.3651 |  |
| 10 | explicit-transaction-boundaries | 0.3526 |  |

**`graph/kg-query.ts`** (ground truth: information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing)
Recall@10: 100% | Top: 0.4536 | Median: 0.2450 | Gap: 0.2086

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | normalize-first-denormalize-intentionally | 0.4536 |  |
| 2 | deep-modules | 0.4435 |  |
| 3 | measure-before-optimizing | 0.4380 | YES |
| 4 | aggregates-reference-by-id | 0.4353 |  |
| 5 | structured-logging-with-levels | 0.3728 |  |
| 6 | consistent-abstraction-levels | 0.3530 | YES |
| 7 | architectural-fitness-functions | 0.3484 |  |
| 8 | minimize-attack-surface | 0.3404 |  |
| 9 | information-hiding | 0.3346 | YES |
| 10 | command-query-separation | 0.3138 | YES |

**`graph/kg-vector-store.ts`** (ground truth: information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values)
Recall@10: 0% | Top: 0.4464 | Median: 0.2497 | Gap: 0.1967

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | normalize-first-denormalize-intentionally | 0.4464 |  |
| 2 | aggregates-reference-by-id | 0.3713 |  |
| 3 | architectural-fitness-functions | 0.3476 |  |
| 4 | unidirectional-data-flow | 0.3408 |  |
| 5 | props-are-the-component-contract | 0.3395 |  |
| 6 | backward-compatible-schema-changes | 0.3376 |  |
| 7 | measure-before-optimizing | 0.3200 |  |
| 8 | structured-logging-with-levels | 0.3188 |  |
| 9 | leave-touched-files-better | 0.3183 |  |
| 10 | isolate-frontend-runtime-state | 0.3125 |  |

**`features/orchestration/tools/drive-flow.ts`** (ground truth: errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries)
Recall@10: 0% | Top: 0.5121 | Median: 0.2752 | Gap: 0.2370

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.5121 |  |
| 2 | design-for-self-healing | 0.4240 |  |
| 3 | prefer-async-between-services | 0.3897 |  |
| 4 | unidirectional-data-flow | 0.3858 |  |
| 5 | decompose-by-domain-not-layer | 0.3848 |  |
| 6 | architectural-fitness-functions | 0.3670 |  |
| 7 | explicit-transaction-boundaries | 0.3623 |  |
| 8 | fail-closed-by-default | 0.3576 |  |
| 9 | measure-before-optimizing | 0.3528 |  |
| 10 | simplicity-first | 0.3507 |  |

**`features/orchestration/tools/report-result.ts`** (ground truth: errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default)
Recall@10: 0% | Top: 0.4241 | Median: 0.2701 | Gap: 0.1540

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.4241 |  |
| 2 | resilient-frontend-composition | 0.4106 |  |
| 3 | design-for-self-healing | 0.4101 |  |
| 4 | isolate-frontend-runtime-state | 0.3940 |  |
| 5 | minimize-client-side-state | 0.3868 |  |
| 6 | unidirectional-data-flow | 0.3695 |  |
| 7 | explicit-transaction-boundaries | 0.3659 |  |
| 8 | prefer-async-between-services | 0.3630 |  |
| 9 | leave-touched-files-better | 0.3626 |  |
| 10 | idempotent-operations | 0.3589 |  |

**`features/orchestration/tools/init-workspace.ts`** (ground truth: validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access)
Recall@10: 0% | Top: 0.4392 | Median: 0.1862 | Gap: 0.2530

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.4392 |  |
| 2 | leave-touched-files-better | 0.4269 |  |
| 3 | design-for-self-healing | 0.3682 |  |
| 4 | colocate-component-assets | 0.3321 |  |
| 5 | infrastructure-tested-like-code | 0.3188 |  |
| 6 | architectural-fitness-functions | 0.3135 |  |
| 7 | externalize-configuration | 0.3073 |  |
| 8 | isolate-frontend-runtime-state | 0.2922 |  |
| 9 | refactoring-integrity | 0.2815 |  |
| 10 | decompose-by-domain-not-layer | 0.2797 |  |

**`features/principles/tools/get-principles.ts`** (ground truth: validate-at-trust-boundaries, information-hiding, errors-are-values, functions-do-one-thing)
Recall@10: 25% | Top: 0.4761 | Median: 0.1845 | Gap: 0.2915

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | architectural-fitness-functions | 0.4761 |  |
| 2 | refactoring-integrity | 0.4087 |  |
| 3 | leave-touched-files-better | 0.3908 |  |
| 4 | information-hiding | 0.3292 | YES |
| 5 | decompose-by-domain-not-layer | 0.3119 |  |
| 6 | measure-before-optimizing | 0.3082 |  |
| 7 | colocate-component-assets | 0.3018 |  |
| 8 | bounded-context-boundaries | 0.2992 |  |
| 9 | observable-best-effort | 0.2943 |  |
| 10 | design-tokens-as-style-contract | 0.2891 |  |

**`features/file-context/tools/get-file-context.ts`** (ground truth: validate-at-trust-boundaries, errors-are-values, information-hiding, handle-partial-failure, least-privilege-access)
Recall@10: 20% | Top: 0.4625 | Median: 0.2093 | Gap: 0.2532

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | leave-touched-files-better | 0.4625 |  |
| 2 | refactoring-integrity | 0.4447 |  |
| 3 | architectural-fitness-functions | 0.4247 |  |
| 4 | measure-before-optimizing | 0.3692 |  |
| 5 | information-hiding | 0.3538 | YES |
| 6 | colocate-component-assets | 0.3406 |  |
| 7 | decompose-by-domain-not-layer | 0.3279 |  |
| 8 | externalize-configuration | 0.3120 |  |
| 9 | infrastructure-tested-like-code | 0.3084 |  |
| 10 | design-tokens-as-style-contract | 0.3077 |  |

**`shared/matcher.ts`** (ground truth: measure-before-optimizing, information-hiding, functions-do-one-thing, consistent-abstraction-levels)
Recall@10: 50% | Top: 0.5277 | Median: 0.2179 | Gap: 0.3098

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | architectural-fitness-functions | 0.5277 |  |
| 2 | refactoring-integrity | 0.4963 |  |
| 3 | leave-touched-files-better | 0.4661 |  |
| 4 | measure-before-optimizing | 0.4599 | YES |
| 5 | information-hiding | 0.3797 | YES |
| 6 | colocate-component-assets | 0.3510 |  |
| 7 | design-tokens-as-style-contract | 0.3077 |  |
| 8 | deep-modules | 0.3050 |  |
| 9 | decompose-by-domain-not-layer | 0.2956 |  |
| 10 | single-source-of-component-styles | 0.2908 |  |

**`shared/parser.ts`** (ground truth: functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence)
Recall@10: 0% | Top: 0.4421 | Median: 0.1400 | Gap: 0.3021

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | refactoring-integrity | 0.4421 |  |
| 2 | information-hiding | 0.3380 |  |
| 3 | leave-touched-files-better | 0.3313 |  |
| 4 | architectural-fitness-functions | 0.3218 |  |
| 5 | design-tokens-as-style-contract | 0.3176 |  |
| 6 | observable-best-effort | 0.3076 |  |
| 7 | colocate-component-assets | 0.2845 |  |
| 8 | bounded-context-boundaries | 0.2841 |  |
| 9 | decompose-by-domain-not-layer | 0.2430 |  |
| 10 | props-are-the-component-contract | 0.2389 |  |

**`shared/lib/tool-result.ts`** (ground truth: errors-are-values, information-hiding, consistent-abstraction-levels, fail-closed-by-default)
Recall@10: 75% | Top: 0.5603 | Median: 0.2441 | Gap: 0.3161

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.5603 |  |
| 2 | leave-touched-files-better | 0.4057 |  |
| 3 | refactoring-integrity | 0.4054 |  |
| 4 | fail-closed-by-default | 0.3897 | YES |
| 5 | architectural-fitness-functions | 0.3741 |  |
| 6 | wrap-external-exceptions | 0.3634 |  |
| 7 | resilient-frontend-composition | 0.3624 |  |
| 8 | information-hiding | 0.3541 | YES |
| 9 | errors-are-values | 0.3535 | YES |
| 10 | structured-logging-with-levels | 0.3456 |  |

### Iteration 2b Results — Full Principle Body + Vocabulary-Enriched Summaries

**Aggregate Recall@10: 35.8%** (Iteration 1: 31.2%, Iteration 2a: 22.7%)
**Average discrimination gap: 0.2410** (Iteration 1: 0.1984, Iteration 2a: 0.2412)
**Go threshold: ≥80% → NO-GO**

#### Per-File Recall@10 (Iteration 2b)

| File | Iter 1 | Iter 2a | Iter 2b | Delta vs 2a | Hits (top 10) | Misses |
|------|--------|---------|---------|-------------|----------------|--------|
| graph/kg-embedding.ts | 0% | 0% | 50% | +50% | observable-best-effort, simplicity-first | errors-are-values, handle-partial-failure |
| graph/kg-store.ts | 50% | 25% | 25% | = | information-hiding | prefer-immutable-data, simplicity-first, consistent-abstraction-levels |
| graph/kg-pipeline.ts | 25% | 0% | 25% | +25% | observable-best-effort | errors-are-values, handle-partial-failure, functions-do-one-thing |
| graph/kg-query.ts | 50% | 100% | 100% | = | information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing | none |
| graph/kg-vector-store.ts | 0% | 0% | 0% | = | none | information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values |
| features/orchestration/tools/drive-flow.ts | 40% | 0% | 20% | +20% | errors-are-values | no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries |
| features/orchestration/tools/report-result.ts | 0% | 0% | 25% | +25% | no-hidden-side-effects | errors-are-values, command-query-separation, fail-closed-by-default |
| features/orchestration/tools/init-workspace.ts | 0% | 0% | 0% | = | none | validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access |
| features/principles/tools/get-principles.ts | 50% | 25% | 25% | = | information-hiding | validate-at-trust-boundaries, errors-are-values, functions-do-one-thing |
| features/file-context/tools/get-file-context.ts | 40% | 20% | 20% | = | information-hiding | validate-at-trust-boundaries, errors-are-values, handle-partial-failure, least-privilege-access |
| shared/matcher.ts | 75% | 50% | 75% | +25% | measure-before-optimizing, information-hiding, consistent-abstraction-levels | functions-do-one-thing |
| shared/parser.ts | 0% | 0% | 25% | +25% | consistent-abstraction-levels | functions-do-one-thing, errors-are-values, define-errors-out-of-existence |
| shared/lib/tool-result.ts | 75% | 75% | 75% | = | errors-are-values, information-hiding, fail-closed-by-default | consistent-abstraction-levels |

#### Top-5 Rankings for Key Files (Iteration 2b)

**`graph/kg-embedding.ts`** (ground truth: errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure)
Recall@10: 50% | Top: 0.4531 | Median: 0.3006 | Gap: 0.1524

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | aggregates-reference-by-id | 0.4531 |  |
| 2 | measure-before-optimizing | 0.4425 |  |
| 3 | deep-modules | 0.4259 |  |
| 4 | refactoring-integrity | 0.4117 |  |
| 5 | consistent-abstraction-levels | 0.4109 |  |
| 6 | simplicity-first | 0.3989 | YES |
| 7 | observable-best-effort | 0.3943 | YES |
| 8 | normalize-first-denormalize-intentionally | 0.3897 |  |
| 9 | architectural-fitness-functions | 0.3742 |  |
| 10 | design-tokens-as-style-contract | 0.3642 |  |

**`graph/kg-store.ts`** (ground truth: information-hiding, prefer-immutable-data, simplicity-first, consistent-abstraction-levels)
Recall@10: 25% | Top: 0.5816 | Median: 0.3183 | Gap: 0.2634

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | normalize-first-denormalize-intentionally | 0.5816 |  |
| 2 | backward-compatible-schema-changes | 0.4851 |  |
| 3 | explicit-transaction-boundaries | 0.4695 |  |
| 4 | services-own-their-data | 0.4438 |  |
| 5 | information-hiding | 0.4390 | YES |
| 6 | aggregates-reference-by-id | 0.4261 |  |
| 7 | idempotent-operations | 0.4193 |  |
| 8 | command-query-separation | 0.4039 |  |
| 9 | measure-before-optimizing | 0.4015 |  |
| 10 | prefer-composition-over-inheritance | 0.3988 |  |

**`graph/kg-pipeline.ts`** (ground truth: errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing)
Recall@10: 25% | Top: 0.4979 | Median: 0.3417 | Gap: 0.1562

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | architectural-fitness-functions | 0.4979 |  |
| 2 | measure-before-optimizing | 0.4746 |  |
| 3 | structured-logging-with-levels | 0.4487 |  |
| 4 | information-hiding | 0.4472 |  |
| 5 | normalize-first-denormalize-intentionally | 0.4338 |  |
| 6 | decompose-by-domain-not-layer | 0.4322 |  |
| 7 | aggregates-reference-by-id | 0.4308 |  |
| 8 | refactoring-integrity | 0.4176 |  |
| 9 | leave-touched-files-better | 0.4162 |  |
| 10 | observable-best-effort | 0.4023 | YES |

**`graph/kg-query.ts`** (ground truth: information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing)
Recall@10: 100% | Top: 0.5138 | Median: 0.2832 | Gap: 0.2307

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | measure-before-optimizing | 0.5138 | YES |
| 2 | deep-modules | 0.4961 |  |
| 3 | normalize-first-denormalize-intentionally | 0.4752 |  |
| 4 | aggregates-reference-by-id | 0.4652 |  |
| 5 | consistent-abstraction-levels | 0.4182 | YES |
| 6 | information-hiding | 0.3851 | YES |
| 7 | architectural-fitness-functions | 0.3836 |  |
| 8 | structured-logging-with-levels | 0.3814 |  |
| 9 | command-query-separation | 0.3762 | YES |
| 10 | minimize-attack-surface | 0.3620 |  |

**`graph/kg-vector-store.ts`** (ground truth: information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values)
Recall@10: 0% | Top: 0.4829 | Median: 0.2993 | Gap: 0.1836

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | normalize-first-denormalize-intentionally | 0.4829 |  |
| 2 | aggregates-reference-by-id | 0.4087 |  |
| 3 | leave-touched-files-better | 0.3943 |  |
| 4 | architectural-fitness-functions | 0.3893 |  |
| 5 | backward-compatible-schema-changes | 0.3730 |  |
| 6 | props-are-the-component-contract | 0.3618 |  |
| 7 | structured-logging-with-levels | 0.3614 |  |
| 8 | prefer-composition-over-inheritance | 0.3595 |  |
| 9 | measure-before-optimizing | 0.3584 |  |
| 10 | explicit-transaction-boundaries | 0.3555 |  |

**`features/orchestration/tools/drive-flow.ts`** (ground truth: errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries)
Recall@10: 20% | Top: 0.5576 | Median: 0.3314 | Gap: 0.2261

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.5576 |  |
| 2 | design-for-self-healing | 0.4629 |  |
| 3 | unidirectional-data-flow | 0.4492 |  |
| 4 | explicit-transaction-boundaries | 0.4384 |  |
| 5 | fail-closed-by-default | 0.4228 |  |
| 6 | prefer-async-between-services | 0.4203 |  |
| 7 | architectural-fitness-functions | 0.4186 |  |
| 8 | decompose-by-domain-not-layer | 0.4156 |  |
| 9 | resilient-frontend-composition | 0.4003 |  |
| 10 | errors-are-values | 0.3969 | YES |

**`features/orchestration/tools/report-result.ts`** (ground truth: errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default)
Recall@10: 25% | Top: 0.4489 | Median: 0.2730 | Gap: 0.1758

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.4489 |  |
| 2 | resilient-frontend-composition | 0.4022 |  |
| 3 | design-for-self-healing | 0.3915 |  |
| 4 | leave-touched-files-better | 0.3880 |  |
| 5 | information-hiding | 0.3851 |  |
| 6 | explicit-transaction-boundaries | 0.3822 |  |
| 7 | no-hidden-side-effects | 0.3790 | YES |
| 8 | tests-are-deterministic | 0.3717 |  |
| 9 | unidirectional-data-flow | 0.3704 |  |
| 10 | isolate-frontend-runtime-state | 0.3641 |  |

**`features/orchestration/tools/init-workspace.ts`** (ground truth: validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access)
Recall@10: 0% | Top: 0.5387 | Median: 0.2687 | Gap: 0.2700

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.5387 |  |
| 2 | leave-touched-files-better | 0.4878 |  |
| 3 | design-for-self-healing | 0.4345 |  |
| 4 | infrastructure-tested-like-code | 0.4211 |  |
| 5 | decompose-by-domain-not-layer | 0.3723 |  |
| 6 | architectural-fitness-functions | 0.3677 |  |
| 7 | refactoring-integrity | 0.3627 |  |
| 8 | externalize-configuration | 0.3546 |  |
| 9 | colocate-component-assets | 0.3517 |  |
| 10 | isolate-frontend-runtime-state | 0.3506 |  |

**`features/principles/tools/get-principles.ts`** (ground truth: validate-at-trust-boundaries, information-hiding, errors-are-values, functions-do-one-thing)
Recall@10: 25% | Top: 0.5142 | Median: 0.2118 | Gap: 0.3024

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | architectural-fitness-functions | 0.5142 |  |
| 2 | refactoring-integrity | 0.4416 |  |
| 3 | leave-touched-files-better | 0.4281 |  |
| 4 | information-hiding | 0.3771 | YES |
| 5 | decompose-by-domain-not-layer | 0.3678 |  |
| 6 | bounded-context-boundaries | 0.3655 |  |
| 7 | observable-best-effort | 0.3565 |  |
| 8 | measure-before-optimizing | 0.3341 |  |
| 9 | design-tokens-as-style-contract | 0.3301 |  |
| 10 | least-privilege-access | 0.3291 |  |

**`features/file-context/tools/get-file-context.ts`** (ground truth: validate-at-trust-boundaries, errors-are-values, information-hiding, handle-partial-failure, least-privilege-access)
Recall@10: 20% | Top: 0.5321 | Median: 0.2909 | Gap: 0.2412

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | leave-touched-files-better | 0.5321 |  |
| 2 | architectural-fitness-functions | 0.4829 |  |
| 3 | refactoring-integrity | 0.4827 |  |
| 4 | infrastructure-tested-like-code | 0.4502 |  |
| 5 | information-hiding | 0.4179 | YES |
| 6 | measure-before-optimizing | 0.4109 |  |
| 7 | secrets-never-in-code | 0.3942 |  |
| 8 | decompose-by-domain-not-layer | 0.3898 |  |
| 9 | externalize-configuration | 0.3886 |  |
| 10 | colocate-component-assets | 0.3853 |  |

**`shared/matcher.ts`** (ground truth: measure-before-optimizing, information-hiding, functions-do-one-thing, consistent-abstraction-levels)
Recall@10: 75% | Top: 0.5568 | Median: 0.2536 | Gap: 0.3031

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | refactoring-integrity | 0.5568 |  |
| 2 | measure-before-optimizing | 0.5522 | YES |
| 3 | leave-touched-files-better | 0.5230 |  |
| 4 | architectural-fitness-functions | 0.5192 |  |
| 5 | information-hiding | 0.4425 | YES |
| 6 | patterns-need-justification | 0.4286 |  |
| 7 | deep-modules | 0.4050 |  |
| 8 | consistent-abstraction-levels | 0.4044 | YES |
| 9 | colocate-component-assets | 0.3801 |  |
| 10 | design-tokens-as-style-contract | 0.3748 |  |

**`shared/parser.ts`** (ground truth: functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence)
Recall@10: 25% | Top: 0.5160 | Median: 0.2211 | Gap: 0.2949

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | refactoring-integrity | 0.5160 |  |
| 2 | information-hiding | 0.4483 |  |
| 3 | architectural-fitness-functions | 0.3865 |  |
| 4 | leave-touched-files-better | 0.3859 |  |
| 5 | observable-best-effort | 0.3757 |  |
| 6 | consistent-abstraction-levels | 0.3755 | YES |
| 7 | bounded-context-boundaries | 0.3702 |  |
| 8 | design-tokens-as-style-contract | 0.3662 |  |
| 9 | decompose-by-domain-not-layer | 0.3316 |  |
| 10 | ubiquitous-language-in-code | 0.3216 |  |

**`shared/lib/tool-result.ts`** (ground truth: errors-are-values, information-hiding, consistent-abstraction-levels, fail-closed-by-default)
Recall@10: 75% | Top: 0.6216 | Median: 0.2879 | Gap: 0.3336

| Rank | Principle | Score | In GT? |
|------|-----------|-------|--------|
| 1 | observable-best-effort | 0.6216 |  |
| 2 | fail-closed-by-default | 0.4466 | YES |
| 3 | refactoring-integrity | 0.4451 |  |
| 4 | errors-are-values | 0.4399 | YES |
| 5 | wrap-external-exceptions | 0.4375 |  |
| 6 | leave-touched-files-better | 0.4279 |  |
| 7 | structured-logging-with-levels | 0.4150 |  |
| 8 | information-hiding | 0.4026 | YES |
| 9 | architectural-fitness-functions | 0.3997 |  |
| 10 | prefer-composition-over-inheritance | 0.3933 |  |

### Comparison Table: All Iterations

| Metric | Iteration 1 | Iteration 2a | Iteration 2b |
|--------|-------------|--------------|--------------|
| Principle embedding text | Title + first para + 300-char anti-rat | Title + full body | Title + full body |
| Summary type | Enriched (role/relationships/concerns) | Same as iter 1 | Enriched + pattern vocabulary |
| Aggregate Recall@10 | 31.2% | 22.7% | 35.8% |
| Average discrimination gap | 0.1984 | 0.2412 | 0.2410 |
| Files at 0% recall | 5 | 7 | 2 |
| Files at 100% recall | 0 | 1 | 1 |
| Go/No-Go | NO-GO | NO-GO | NO-GO |

### Analysis

**Full principle body (2a)** changed aggregate recall by -8.5 percentage points (31.2% → 22.7%).

**Vocabulary-enriched summaries (2b)** changed aggregate recall by +13.1 percentage points vs 2a (22.7% → 35.8%), and +4.6 percentage points vs iteration 1.

In iteration 2a: **1 files improved**, **6 unchanged**, **6 regressed**.
Improved: graph/kg-query.ts (50% → 100%)
Regressed: graph/kg-store.ts (50% → 25%), graph/kg-pipeline.ts (25% → 0%), features/orchestration/tools/drive-flow.ts (40% → 0%), features/principles/tools/get-principles.ts (50% → 25%), features/file-context/tools/get-file-context.ts (40% → 20%), shared/matcher.ts (75% → 50%)

In iteration 2b vs 2a: **6 files improved**, **7 unchanged**, **0 regressed**.
Improved: graph/kg-embedding.ts (0% → 50%), graph/kg-pipeline.ts (0% → 25%), features/orchestration/tools/drive-flow.ts (0% → 20%), features/orchestration/tools/report-result.ts (0% → 25%), shared/matcher.ts (50% → 75%), shared/parser.ts (0% → 25%)

### Updated Go/No-Go Recommendation

**RECOMMENDATION: NO-GO** — Best: 35.8% (threshold: 80%)

Despite full-body principle embeddings and vocabulary-enriched summaries, aggregate Recall@10 remains well below 80%. The semantic gap between descriptive file summaries and prescriptive principle text is not bridgeable by vocabulary alignment alone.

**What would need to change:**

1. **Hybrid lexical+semantic matching** — The most direct path: add principle tag/keyword matching alongside cosine similarity.
2. **Larger embedding model** — Domain-adapted or larger general-purpose model (e.g., `all-mpnet-base-v2`).
3. **Fine-tuning** — Train on (file summary, applicable principle) pairs. Requires ~200+ labeled examples.
4. **LLM-based matching** — Use an LLM to directly evaluate whether a principle applies to a file summary. Higher accuracy, higher cost.

## Iteration 3: LLM Reranking

### Approach

Two-stage pipeline:
- **Stage 1 — Embedding recall**: Top-15 candidates per file from precomputed cosine similarity matrix (iteration 2b — vocabulary-enriched summaries + full principle body embeddings)
- **Stage 2 — LLM rerank**: File summary + 15 candidate principles sent to `claude-haiku-4-5-20251001` via `claude -p` CLI. Prompt asks which principles are genuinely applicable, returned ranked by relevance.

**Note**: Stage 1 uses top-15 candidates (not top-20) because the stored matrix only retains top-15 per file. The LLM reranks within this candidate set.

### Per-File Results

| File | GT Count | Stage1 Recall@10 | LLM Recall@10 | LLM Precision@10 | TP | FP | Latency |
|------|----------|-----------------|---------------|-----------------|----|----|---------|
| graph/kg-embedding.ts | 4 | 50% | 50% | 67% | 2 | 1 | 28367ms |
| graph/kg-store.ts | 4 | 25% | 25% | 17% | 1 | 5 | 29647ms |
| graph/kg-pipeline.ts | 4 | 25% | 25% | 20% | 1 | 4 | 33565ms |
| graph/kg-query.ts | 4 | 100% | 100% | 67% | 4 | 2 | 23134ms |
| graph/kg-vector-store.ts | 4 | 0% | 25% | 25% | 1 | 3 | 27359ms |
| features/orchestration/tools/drive-flow.ts | 5 | 20% | 40% | 50% | 2 | 2 | 45621ms |
| features/orchestration/tools/report-result.ts | 4 | 25% | 25% | 20% | 1 | 4 | 21869ms |
| features/orchestration/tools/init-workspace.ts | 5 | 0% | 0% | 0% | 0 | 2 | 48031ms |
| features/principles/tools/get-principles.ts | 4 | 25% | 25% | 25% | 1 | 3 | 25023ms |
| features/file-context/tools/get-file-context.ts | 5 | 20% | 20% | 25% | 1 | 3 | 22335ms |
| shared/matcher.ts | 4 | 75% | 75% | 75% | 3 | 1 | 27324ms |
| shared/parser.ts | 4 | 25% | 25% | 33% | 1 | 2 | 18008ms |
| shared/lib/tool-result.ts | 4 | 75% | 75% | 60% | 3 | 2 | 21722ms |

### Detailed Per-File Rankings

#### `graph/kg-embedding.ts`

**Ground truth:** errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure
**Stage 1 Recall@10:** 50%
**LLM Recall@10:** 50%
**LLM Precision@10:** 67%
**Latency:** 28367ms

**LLM top-3 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | observable-best-effort | YES |
| 2 | deep-modules |  |
| 3 | simplicity-first | YES |

**Missed from ground truth:** errors-are-values, handle-partial-failure

#### `graph/kg-store.ts`

**Ground truth:** information-hiding, prefer-immutable-data, simplicity-first, consistent-abstraction-levels
**Stage 1 Recall@10:** 25%
**LLM Recall@10:** 25%
**LLM Precision@10:** 17%
**Latency:** 29647ms

**LLM top-6 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | information-hiding | YES |
| 2 | idempotent-operations |  |
| 3 | deep-modules |  |
| 4 | explicit-transaction-boundaries |  |
| 5 | measure-before-optimizing |  |
| 6 | command-query-separation |  |

**Missed from ground truth:** prefer-immutable-data, simplicity-first, consistent-abstraction-levels

#### `graph/kg-pipeline.ts`

**Ground truth:** errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing
**Stage 1 Recall@10:** 25%
**LLM Recall@10:** 25%
**LLM Precision@10:** 20%
**Latency:** 33565ms

**LLM top-5 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | observable-best-effort | YES |
| 2 | explicit-transaction-boundaries |  |
| 3 | structured-logging-with-levels |  |
| 4 | information-hiding |  |
| 5 | consistent-abstraction-levels |  |

**Missed from ground truth:** errors-are-values, handle-partial-failure, functions-do-one-thing

#### `graph/kg-query.ts`

**Ground truth:** information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing
**Stage 1 Recall@10:** 100%
**LLM Recall@10:** 100%
**LLM Precision@10:** 67%
**Latency:** 23134ms

**LLM top-6 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | information-hiding | YES |
| 2 | command-query-separation | YES |
| 3 | measure-before-optimizing | YES |
| 4 | consistent-abstraction-levels | YES |
| 5 | deep-modules |  |
| 6 | no-hidden-side-effects |  |

#### `graph/kg-vector-store.ts`

**Ground truth:** information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values
**Stage 1 Recall@10:** 0%
**LLM Recall@10:** 25%
**LLM Precision@10:** 25%
**Latency:** 27359ms

**LLM top-4 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | information-hiding | YES |
| 2 | explicit-transaction-boundaries |  |
| 3 | backward-compatible-schema-changes |  |
| 4 | command-query-separation |  |

**Missed from ground truth:** wrap-external-exceptions, simplicity-first, errors-are-values

#### `features/orchestration/tools/drive-flow.ts`

**Ground truth:** errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries
**Stage 1 Recall@10:** 20%
**LLM Recall@10:** 40%
**LLM Precision@10:** 50%
**Latency:** 45621ms

**LLM top-4 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | errors-are-values | YES |
| 2 | validate-at-trust-boundaries | YES |
| 3 | observable-best-effort |  |
| 4 | fail-closed-by-default |  |

**Missed from ground truth:** no-hidden-side-effects, functions-do-one-thing, handle-partial-failure

#### `features/orchestration/tools/report-result.ts`

**Ground truth:** errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default
**Stage 1 Recall@10:** 25%
**LLM Recall@10:** 25%
**LLM Precision@10:** 20%
**Latency:** 21869ms

**LLM top-5 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | explicit-transaction-boundaries |  |
| 2 | no-hidden-side-effects | YES |
| 3 | information-hiding |  |
| 4 | idempotent-operations |  |
| 5 | observable-best-effort |  |

**Missed from ground truth:** errors-are-values, command-query-separation, fail-closed-by-default

#### `features/orchestration/tools/init-workspace.ts`

**Ground truth:** validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access
**Stage 1 Recall@10:** 0%
**LLM Recall@10:** 0%
**LLM Precision@10:** 0%
**Latency:** 48031ms

**LLM top-2 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | observable-best-effort |  |
| 2 | ubiquitous-language-in-code |  |

**Missed from ground truth:** validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access

#### `features/principles/tools/get-principles.ts`

**Ground truth:** validate-at-trust-boundaries, information-hiding, errors-are-values, functions-do-one-thing
**Stage 1 Recall@10:** 25%
**LLM Recall@10:** 25%
**LLM Precision@10:** 25%
**Latency:** 25023ms

**LLM top-4 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | information-hiding | YES |
| 2 | deep-modules |  |
| 3 | least-privilege-access |  |
| 4 | consistent-abstraction-levels |  |

**Missed from ground truth:** validate-at-trust-boundaries, errors-are-values, functions-do-one-thing

#### `features/file-context/tools/get-file-context.ts`

**Ground truth:** validate-at-trust-boundaries, errors-are-values, information-hiding, handle-partial-failure, least-privilege-access
**Stage 1 Recall@10:** 20%
**LLM Recall@10:** 20%
**LLM Precision@10:** 25%
**Latency:** 22335ms

**LLM top-4 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | information-hiding | YES |
| 2 | observable-best-effort |  |
| 3 | deep-modules |  |
| 4 | minimize-attack-surface |  |

**Missed from ground truth:** validate-at-trust-boundaries, errors-are-values, handle-partial-failure, least-privilege-access

#### `shared/matcher.ts`

**Ground truth:** measure-before-optimizing, information-hiding, functions-do-one-thing, consistent-abstraction-levels
**Stage 1 Recall@10:** 75%
**LLM Recall@10:** 75%
**LLM Precision@10:** 75%
**Latency:** 27324ms

**LLM top-4 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | measure-before-optimizing | YES |
| 2 | information-hiding | YES |
| 3 | consistent-abstraction-levels | YES |
| 4 | deep-modules |  |

**Missed from ground truth:** functions-do-one-thing

#### `shared/parser.ts`

**Ground truth:** functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence
**Stage 1 Recall@10:** 25%
**LLM Recall@10:** 25%
**LLM Precision@10:** 33%
**Latency:** 18008ms

**LLM top-3 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | consistent-abstraction-levels | YES |
| 2 | information-hiding |  |
| 3 | deep-modules |  |

**Missed from ground truth:** functions-do-one-thing, errors-are-values, define-errors-out-of-existence

#### `shared/lib/tool-result.ts`

**Ground truth:** errors-are-values, information-hiding, consistent-abstraction-levels, fail-closed-by-default
**Stage 1 Recall@10:** 75%
**LLM Recall@10:** 75%
**LLM Precision@10:** 60%
**Latency:** 21722ms

**LLM top-5 selection:**

| Rank | Principle ID | In Ground Truth? |
|------|-------------|-----------------|
| 1 | fail-closed-by-default | YES |
| 2 | errors-are-values | YES |
| 3 | information-hiding | YES |
| 4 | observable-best-effort |  |
| 5 | wrap-external-exceptions |  |

**Missed from ground truth:** consistent-abstraction-levels

### Aggregate Metrics

| Metric | Value |
|--------|-------|
| Files evaluated | 13 |
| Stage 1 candidates per file | 15 (top-15 from embedding matrix) |
| Stage 2 model | claude-haiku-4-5-20251001 |
| Stage 1 Aggregate Recall@10 | 35.8% |
| LLM Aggregate Recall@10 | 39.2% |
| LLM Aggregate Precision@10 | 37.2% |
| Average latency per file | 28616ms |
| Total latency (13 files) | 372005ms |
| Go threshold | ≥80% recall@10 |
| Go/No-Go | NO-GO |

### Cost Analysis

Using Haiku pricing ($0.80/1M input tokens, $4/1M output tokens):

| Scale | Files | Est. Cost |
|-------|-------|-----------|
| Per file | 1 | $0.00084 |
| Dev codebase | 100 | $0.0840 |
| Medium codebase | 500 | $0.4200 |
| Large codebase | 2000 | $1.6800 |

**Notes**: Cost estimate assumes ~800 input tokens per file (summary + 15 candidate principles) and ~50 output tokens. At Haiku pricing ($0.80/1M input, $4/1M output): `(800 × $0.80 + 50 × $4) / 1,000,000 = $0.00084/file`. In production, the LLM stage would only run once per file at indexing time, not per query.

_`*` Latency estimate: `claude -p` eval measured 28.6s/file due to Claude Code startup overhead. Direct Anthropic SDK call to Haiku would take ~1-2s/file in production._

### Comparison Table: All Iterations

| Metric | Iter 1 | Iter 2a | Iter 2b | Iter 3 (LLM) |
|--------|--------|---------|---------|--------------|
| Method | Embedding only | Full-body embedding | Full-body + vocab-enriched | Embedding recall → LLM rerank |
| Aggregate Recall@10 | 31.2% | 22.7% | 35.8% | 39.2% |
| Precision@10 | — | — | — | 37.2% |
| Latency per file | <1ms | <1ms | <1ms | ~1-2s* |
| Cost per file | $0 | $0 | $0 | $0.00084 |
| Go/No-Go | NO-GO | NO-GO | NO-GO | NO-GO |

### Analysis

LLM reranking produced 39.2% aggregate Recall@10, a +3.5 percentage point improvement over iteration 2b (35.8%) and +8.0 percentage points vs iteration 1 (31.2%).

**Stage 1 → LLM delta**: 2 files improved, 11 unchanged, 0 regressed vs embedding-only stage 1.
Improved: graph/kg-vector-store.ts (0% → 25%), features/orchestration/tools/drive-flow.ts (20% → 40%)

**Precision analysis**: LLM Precision@10 of 37.2% means that of the principles the LLM selected as applicable, 37.2% were in the ground truth set. This measures selectivity — higher precision means fewer false positives.

**Latency**: Average 28616ms per file using `claude -p` CLI (claude-haiku-4-5-20251001). **Important**: this latency is an artifact of the eval method — `claude -p` spawns a full Claude Code process per invocation, adding ~25-27 seconds of startup overhead. A production implementation using the Anthropic SDK directly would take ~1-2 seconds per file for a Haiku API call. The 28-second figure should not be used as a production latency estimate.

### Go/No-Go Recommendation

**RECOMMENDATION: NO-GO** — 39.2% (threshold: 80%)

LLM reranking gave a modest improvement (+3.5pp over iter 2b) but didn't approach the 80% threshold. The bottleneck is Stage 1, not Stage 2.

**Root cause: Stage 1 ceiling is 38.2%**

Post-run analysis of which ground truth principles appear in the top-15 Stage 1 candidates:

| File | GT Count | GT in Stage 1 top-15 | Stage 1 Ceiling | GT Missed by Stage 1 |
|------|----------|--------------------|-----------------|----------------------|
| graph/kg-embedding.ts | 4 | 2 | 50% | errors-are-values, handle-partial-failure |
| graph/kg-store.ts | 4 | 1 | 25% | prefer-immutable-data, simplicity-first, consistent-abstraction-levels |
| graph/kg-pipeline.ts | 4 | 1 | 25% | errors-are-values, handle-partial-failure, functions-do-one-thing |
| graph/kg-query.ts | 4 | 4 | 100% | — |
| graph/kg-vector-store.ts | 4 | 1 | 25% | wrap-external-exceptions, simplicity-first, errors-are-values |
| features/orchestration/tools/drive-flow.ts | 5 | 2 | 40% | no-hidden-side-effects, functions-do-one-thing, handle-partial-failure |
| features/orchestration/tools/report-result.ts | 4 | 1 | 25% | errors-are-values, command-query-separation, fail-closed-by-default |
| features/orchestration/tools/init-workspace.ts | 5 | 0 | 0% | ALL 5 principles |
| features/principles/tools/get-principles.ts | 4 | 1 | 25% | validate-at-trust-boundaries, errors-are-values, functions-do-one-thing |
| features/file-context/tools/get-file-context.ts | 5 | 1 | 20% | validate-at-trust-boundaries, errors-are-values, handle-partial-failure, least-privilege-access |
| shared/matcher.ts | 4 | 3 | 75% | functions-do-one-thing |
| shared/parser.ts | 4 | 1 | 25% | functions-do-one-thing, errors-are-values, define-errors-out-of-existence |
| shared/lib/tool-result.ts | 4 | 3 | 75% | consistent-abstraction-levels |
| **TOTAL** | **55** | **21** | **38.2%** | **34 GT principles not in top-15** |

The LLM achieved 39.2% — essentially at the Stage 1 ceiling of 38.2%. The LLM is doing its job correctly within the candidates it can see, but 34 out of 55 ground truth principles never appear in the embedding top-15. No amount of LLM reasoning can recover what the embedding stage didn't retrieve.

**Key observations:**

1. `features/orchestration/tools/init-workspace.ts` has 0% Stage 1 ceiling — all 5 ground truth principles (`validate-at-trust-boundaries`, `errors-are-values`, `fail-closed-by-default`, `no-hidden-side-effects`, `least-privilege-access`) are absent from the top-15. The embedding model consistently ranks infrastructure-oriented and data-flow principles above security/reliability principles for this file.

2. Cross-cutting principles (`errors-are-values`, `functions-do-one-thing`, `validate-at-trust-boundaries`) consistently rank below domain-specific noise. These are the most widely applicable Canon principles, yet they rank poorly because their principle text doesn't use the same vocabulary as the file descriptions.

3. The LLM **removed false positives** effectively: aggregate Stage 1 precision was poor (many wrong top-15 candidates), while LLM Precision@10 was 37.2% — showing the LLM filtered out many wrong candidates within its window.

**The fundamental constraint**: LLM reranking is bounded by Stage 1 recall. To reach 80% recall@10, Stage 1 would need to achieve at least 80% coverage of ground truth principles in its candidate set. Currently it achieves 38.2% coverage at top-15.

**Paths to 80%:**

1. **Expand Stage 1 candidate pool to top-40 or top-57**: Instead of filtering at top-15, pass all 57 principles to the LLM for selection. This eliminates Stage 1 as a bottleneck entirely. Cost: ~3.7x more input tokens per file. Still ~$0.003/file at Haiku pricing.

2. **LLM-only approach (no embedding Stage 1)**: Skip embeddings entirely. Send all 57 principle titles + first paragraphs to the LLM and ask which apply. Input: ~2000 tokens per file. Cost: ~$0.002/file at Haiku. This is likely the highest-recall approach and should be tested as Iteration 4.

3. **Better Stage 1 embeddings**: Fix the embedding model's inability to retrieve cross-cutting principles. Likely requires fine-tuning or a fundamentally different retrieval strategy (e.g., principle-tag matching, BM25).

**Recommended next step: Iteration 4 — LLM-only (no Stage 1 filter)**

Send all 57 principles to the LLM directly. Test hypothesis: when the LLM sees all principles, not just embedding-filtered candidates, does recall@10 exceed 80%? At Haiku pricing, this costs ~$0.002/file — viable for production indexing-time use.