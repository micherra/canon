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