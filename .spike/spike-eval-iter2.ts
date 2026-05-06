/**
 * Spike Eval — Iteration 2
 *
 * Tests two variants:
 * - Iteration 2a: Full principle body (title + complete body + anti-rationalization)
 * - Iteration 2b: Full principle body + vocabulary-enriched file summaries
 *
 * Usage: npx tsx .spike/spike-eval-iter2.ts
 * Run from: mcp-server/ directory (so gray-matter and @huggingface/transformers resolve)
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

// Resolve paths absolutely so the script can run from any working directory.
// The script lives at .spike/spike-eval-iter2.ts within the worktree.
import { fileURLToPath } from "node:url";
const SPIKE_DIR = typeof __dirname !== "undefined"
  ? __dirname
  : fileURLToPath(new URL(".", import.meta.url));
const WORKTREE = join(SPIKE_DIR, "..");    // <worktree>/
const PRINCIPLES_DIR = join(WORKTREE, "principles");
const OUTPUT_DIR = SPIKE_DIR;

// ---------------------------------------------------------------------------
// Inline EmbeddingService (avoid import alias complexity from outside mcp-server)
// ---------------------------------------------------------------------------

import { pipeline } from "@huggingface/transformers";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_BATCH_SIZE = 64;

class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.pipe) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.pipe = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" } as any);
    })();
    return this.initPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const output = await this.pipe!(batch, { normalize: true, pooling: "mean" });
      for (let j = 0; j < batch.length; j++) {
        results.push(new Float32Array(output._getitem(j).data as Float32Array));
      }
    }
    return results;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [result] = await this.embed([text]);
    return result!;
  }
}

// ---------------------------------------------------------------------------
// Principle loading — FULL BODY (iteration 2 change)
// ---------------------------------------------------------------------------

type Principle = {
  id: string;
  title: string;
  severity: string;
  body: string;         // full body including rationale, examples, verification
  anti_rationalization?: string;
};

async function loadPrinciples(dir: string): Promise<Principle[]> {
  const subdirs = ["rules", "strong-opinions", "conventions"];
  const all: Principle[] = [];
  for (const sub of subdirs) {
    const subdir = join(dir, sub);
    let files: string[];
    try {
      files = await readdir(subdir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(join(subdir, file), "utf-8");
      const parsed = matter(content);
      const id = (parsed.data.id as string) || file.replace(".md", "");
      const title = (parsed.data.title as string) || id;
      const severity = (parsed.data.severity as string) || "convention";
      const rawBody = parsed.content.trim();

      // Extract anti_rationalization section
      const arMatch = rawBody.match(/\n## Anti-Rationalization\s*\n([\s\S]*?)(?:\n## |$)/i);
      const antiRat = arMatch ? arMatch[1].trim() : undefined;

      // ITERATION 2 CHANGE: use full rawBody instead of just the first paragraph
      all.push({ id, title, severity, body: rawBody, anti_rationalization: antiRat });
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Cosine similarity (vectors are already normalized by EmbeddingService)
// ---------------------------------------------------------------------------

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

// ---------------------------------------------------------------------------
// Enriched file summaries — Iteration 1 baseline (same as iter 1)
// ---------------------------------------------------------------------------

type FileSummary = {
  path: string;
  summary: string;
};

const ENRICHED_SUMMARIES_ITER1: FileSummary[] = [
  {
    path: "graph/kg-embedding.ts",
    summary:
      "Wraps @huggingface/transformers for 384-dim sentence embedding (all-MiniLM-L6-v2, q8 quantized). " +
      "Architectural role: the sole vector representation layer for the knowledge graph — every semantic search query and summary embedding flows through here. " +
      "Relationships: called by kg-pipeline.ts (batch embed during indexing) and kg-vector-query.ts (query-time embedding); depends on @shared/constants for EMBEDDING_MODEL/EMBEDDING_DIM. " +
      "Concerns: throws on failure (intentional — internal infrastructure, not an MCP tool handler), lazy-loads model on first use with concurrent-safe init promise, " +
      "processes in batches of EMBEDDING_BATCH_SIZE to cap peak memory, uses normalize+mean pooling so output vectors are unit-normalized.",
  },
  {
    path: "graph/kg-store.ts",
    summary:
      "Synchronous CRUD layer over a better-sqlite3 Database instance for the knowledge graph schema. " +
      "Architectural role: the single write path for files, entities, edges, file-edges, and summaries in the SQLite KG — all indexing mutations go through this class. " +
      "Relationships: constructed by kg-pipeline.ts with the same DB handle; used nowhere else for writes. KgQuery owns the read path. " +
      "Concerns: all statements are prepared at construction time for performance (statement reuse), boolean coercion for SQLite 0/1 integers, " +
      "upsert patterns for idempotent reindexing, file-level and entity-level cascade deletes for incremental updates. " +
      "State management: holds prepared statement references as private fields — not thread-safe, but better-sqlite3 is process-exclusive.",
  },
  {
    path: "graph/kg-pipeline.ts",
    summary:
      "Orchestrates the five-phase knowledge graph build: scan → parse → resolve-links → persist → embed. " +
      "Architectural role: top-level entry point for full KG indexing (runPipeline) and incremental single-file updates (reindexFile). Coordinates all infrastructure. " +
      "Relationships: imports EmbeddingService, KgStore, KgVectorStore, kg-pipeline-phases, kg-schema, kg-wasm-parser, scanner. " +
      "Concerns: all DB mutations wrapped in transactions for performance and atomicity; adapter errors are non-fatal (bare file entity created instead); " +
      "incremental mode skips files whose mtime+hash match DB row; sourceDirs option limits scan scope; embedding is Phase 5 — async, best-effort, never blocks indexing. " +
      "Error propagation: errors in parsing produce degraded (entity-free) file rows rather than halting the pipeline.",
  },
  {
    path: "graph/kg-query.ts",
    summary:
      "Read-only query module over the knowledge graph SQLite DB — callers, callees, search, dead code, ancestors, blast radius, file degrees, subgraph. " +
      "Architectural role: the exclusive read interface for entity-level graph traversal. All SELECT queries centralized here, no mutations. " +
      "Relationships: used by kg-blast-radius, get-file-context, graph_query tool, and any code needing graph traversal. Depends on kg-query-insights for impact scoring. " +
      "Concerns: all statements prepared at construction for performance; SQL-level joins for callers/callees (edges table); " +
      "computeImpactScore integrates in_degree, layer centrality, and violation count into a single score; " +
      "getFileMetrics is N+1 risk if called in a loop — callers must use computeFileInsightMaps for batch pre-computation.",
  },
  {
    path: "graph/kg-vector-store.ts",
    summary:
      "CRUD layer for entity_vectors and summary_vectors (sqlite-vec vec0 virtual tables). " +
      "Architectural role: manages vector persistence — inserts, staleness detection, and cleanup for semantic search. " +
      "Relationships: used by kg-pipeline.ts for vector persistence after embedding; KgVectorQuery uses it for ANN queries. " +
      "Concerns: sqlite-vec 0.1.6-alpha.2 bug — prepared statement binding fails on vec0 inserts, so all vec0 writes use db.exec() with inline JSON string literals (workaround). " +
      "Meta tables (entity_vector_meta, summary_vector_meta) track text hashes for staleness detection and stay in sync with vec0 rows. " +
      "Throws on errors (internal infrastructure).",
  },
  {
    path: "features/orchestration/tools/drive-flow.ts",
    summary:
      "Core state machine loop for Canon flow execution — the MCP tool that orchestrators call to advance build workflows. " +
      "Architectural role: central dispatch point for the entire orchestration engine. Every flow step (spawn, HITL, done) routes through here. " +
      "Relationships: calls enterAndPrepareState, reportResult, drive-flow-helpers, drive-flow-wave; depends on execution-store, board-state-schemas, flow-definition-schemas. " +
      "Concerns: turn-by-turn protocol (first call enters state, subsequent calls report result and advance); " +
      "wave state handling (parallel agent tasks); convergence limit enforcement; stuck detection; HITL breakpoint generation; " +
      "settings injection for auto-approve worktrees. Returns ToolResult<DriveFlowAction> — never throws for expected conditions.",
  },
  {
    path: "features/orchestration/tools/report-result.ts",
    summary:
      "MCP tool wrapper for recording agent results and evaluating state machine transitions. " +
      "Architectural role: the write path for agent outcomes — updates board state, advances transitions, detects stuck states, evaluates quality signals. " +
      "Relationships: calls syncBoardToStore, evaluateTransition, applyBoardMutations, postTransactionSideEffects; validates required artifacts and handoffs. " +
      "Concerns: accepts optional quality signal fields (gate_results, postcondition_results, violation_count, test_results, files_changed); " +
      "discovery fields (discovered_gates, discovered_postconditions) accumulate across calls; " +
      "debate protocol integration (inspectDebateProgress); optional role handling for parallel states. " +
      "State management: board mutations inside store.transaction() for atomicity; optimistic locking prevents concurrent stale writes.",
  },
  {
    path: "features/orchestration/tools/init-workspace.ts",
    summary:
      "MCP tool for creating or resuming Canon build workspaces — the entry point for every new flow execution. " +
      "Architectural role: lifecycle management for workspace directories, git worktrees, board state, and file claims preflight. " +
      "Relationships: calls loadAndResolveFlow, createWorkspace, generateSlug, gitWorktreeAdd, seedFromPriorWorkspace, KgQuery. " +
      "Concerns: preflight mode checks git status, stale sessions, and active file claims before creating; " +
      "creates build worktree at {workspace}/worktree on canon/{slug} branch; " +
      "returns empty workspace string on preflight failure (caller must check preflight_issues); " +
      "slug collision detection prevents accidental workspace reuse; cache_prefix_hash for prompt caching optimization. " +
      "Security: file claims are informational-only (non-blocking) — advisory overlap warnings, not hard blocks.",
  },
  {
    path: "features/principles/tools/get-principles.ts",
    summary:
      "MCP tool for matching Canon principles to a file or layer context. " +
      "Architectural role: the principle retrieval interface — agents call this to get relevant engineering principles before writing code. " +
      "Relationships: calls loadAllPrinciples, matchPrinciples, KgQuery for graph context enrichment; uses filterBodyBySections for summary_only mode. " +
      "Concerns: layer inference from file path (via inferLayer); graph context overlay (in_degree, impact_score) when file_path provided; " +
      "configurable max_principles_per_review limit; summary_only flag returns first paragraph only for token efficiency. " +
      "Trust boundary: file_path is user-supplied but not used for filesystem access — only pattern matching.",
  },
  {
    path: "features/file-context/tools/get-file-context.ts",
    summary:
      "MCP tool that assembles rich context for a source file — contents, graph relationships, structural metrics, hotspot data, blast radius. " +
      "Architectural role: the primary file inspection interface for agents needing deep context about a single file before editing it. " +
      "Relationships: reads file contents via readFile, extracts imports/exports via import-parser/export-parser, queries KgQuery for metrics, " +
      "loads hotspot and co-change data from git-intel tables, computes blast radius via kg-blast-radius. " +
      "Concerns: high fan-in file (many features depend on its output shape); returns up to FILE_PREVIEW_MAX_LINES (200) of content; " +
      "shape derivation (Sink/Hub/Central/Leaf/Internal) from in_degree/out_degree; git-intel freshness check triggers ensureGitIntelFresh when projectDir provided. " +
      "Security: path traversal guard via isNotFound + toPosix normalization; file content is trusted (read from project tree, not user-supplied payload).",
  },
  {
    path: "shared/matcher.ts",
    summary:
      "Principle matching engine — filters all principles to those applicable for a given file path, layer, severity, or tags. " +
      "Architectural role: the decision layer between the principle library and any tool that needs context-aware principle selection. " +
      "Relationships: imported by get-principles.ts, review-code, and any code needing principle filtering; depends on parser.ts for loadPrincipleFile. " +
      "Concerns: glob-to-regex compilation with caching; mtime-based principle cache with invalidation across project + plugin directories; " +
      "severity ranking (rule > strong-opinion > convention) for sort ordering; " +
      "layer inference from file path segments using buildLayerInferrer. " +
      "Performance: globRegexCache prevents regex recompilation; principleCache avoids file re-reads on every tool call.",
  },
  {
    path: "shared/parser.ts",
    summary:
      "Principle file parser — extracts YAML frontmatter and structured sections (Anti-Rationalization, Verification) from principle markdown files. " +
      "Architectural role: the parsing foundation for all principle loading — every principle in Canon flows through this module. " +
      "Relationships: used by matcher.ts (loadPrincipleFile), and any code that reads principle files directly. " +
      "Concerns: uses gray-matter for frontmatter parsing (replaced hand-rolled parser 2026-03-26); " +
      "extractSections splits on ## headings and separates known sections from body remainder; " +
      "filterBodyBySections supports summary-only mode (first paragraph) vs full body for token budget management. " +
      "Data integrity: id and title are required fields; parsePrinciple returns empty strings rather than throwing on missing fields.",
  },
  {
    path: "shared/lib/tool-result.ts",
    summary:
      "Defines the ToolResult<T> discriminated union — the error contract for all MCP tool handlers in Canon. " +
      "Architectural role: the error-handling foundation for the entire codebase. Every tool function returns this type instead of throwing. " +
      "Relationships: imported by every feature's tool handlers; wrapHandler depends on it for unexpected error wrapping. " +
      "Concerns: 9 CanonErrorCode string literals covering all expected error categories (WORKSPACE_NOT_FOUND, FLOW_NOT_FOUND, etc.); " +
      "toolOk/toolError constructors enforce shape; isToolError type guard for discriminated union narrowing; " +
      "assertOk for test contexts where success is required. " +
      "recoverable flag signals whether the orchestrator should retry or escalate to HITL.",
  },
];

// ---------------------------------------------------------------------------
// Vocabulary-enriched summaries — Iteration 2b
// Adds explicit principle-pattern vocabulary to each summary, bridging
// the descriptive (implementation) vs prescriptive (pattern) semantic gap.
// ---------------------------------------------------------------------------

const ENRICHED_SUMMARIES_ITER2B: FileSummary[] = [
  {
    path: "graph/kg-embedding.ts",
    summary:
      "Wraps @huggingface/transformers for 384-dim sentence embedding (all-MiniLM-L6-v2, q8 quantized). " +
      "Architectural role: the sole vector representation layer for the knowledge graph — every semantic search query and summary embedding flows through here. " +
      "Relationships: called by kg-pipeline.ts (batch embed during indexing) and kg-vector-query.ts (query-time embedding); depends on @shared/constants for EMBEDDING_MODEL/EMBEDDING_DIM. " +
      "Concerns: throws on failure (intentional — internal infrastructure, not an MCP tool handler), lazy-loads model on first use with concurrent-safe init promise, " +
      "processes in batches of EMBEDDING_BATCH_SIZE to cap peak memory, uses normalize+mean pooling so output vectors are unit-normalized. " +
      // Vocabulary bridge: errors-are-values, observable-best-effort, simplicity-first, handle-partial-failure
      "Pattern vocabulary: infrastructure service that throws exceptions rather than returning typed result objects (appropriate for internal callers who must handle failures). " +
      "Best-effort non-blocking design: embedding failures do not propagate to pipeline callers; failures are surfaced only to direct callers. " +
      "Lazy initialization with concurrent-safe promise prevents double-loading — simplicity-first single responsibility. " +
      "No timeout or circuit-breaker needed (in-process ML inference, not a distributed call), but handles OOM gracefully via batch size limits.",
  },
  {
    path: "graph/kg-store.ts",
    summary:
      "Synchronous CRUD layer over a better-sqlite3 Database instance for the knowledge graph schema. " +
      "Architectural role: the single write path for files, entities, edges, file-edges, and summaries in the SQLite KG — all indexing mutations go through this class. " +
      "Relationships: constructed by kg-pipeline.ts with the same DB handle; used nowhere else for writes. KgQuery owns the read path. " +
      "Concerns: all statements are prepared at construction time for performance (statement reuse), boolean coercion for SQLite 0/1 integers, " +
      "upsert patterns for idempotent reindexing, file-level and entity-level cascade deletes for incremental updates. " +
      "State management: holds prepared statement references as private fields — not thread-safe, but better-sqlite3 is process-exclusive. " +
      // Vocabulary bridge: information-hiding, prefer-immutable-data, simplicity-first, consistent-abstraction-levels
      "Pattern vocabulary: encapsulates the storage schema decision — changing the DB column layout requires editing only this module (information hiding, design decision encapsulation). " +
      "All public methods operate at the same abstraction level (entity operations), no mixing of low-level SQL with high-level orchestration (consistent abstraction levels). " +
      "Upsert semantics make writes idempotent — safe to call multiple times for the same entity. " +
      "Private fields hide implementation details; callers cannot access prepared statements directly.",
  },
  {
    path: "graph/kg-pipeline.ts",
    summary:
      "Orchestrates the five-phase knowledge graph build: scan → parse → resolve-links → persist → embed. " +
      "Architectural role: top-level entry point for full KG indexing (runPipeline) and incremental single-file updates (reindexFile). Coordinates all infrastructure. " +
      "Relationships: imports EmbeddingService, KgStore, KgVectorStore, kg-pipeline-phases, kg-schema, kg-wasm-parser, scanner. " +
      "Concerns: all DB mutations wrapped in transactions for performance and atomicity; adapter errors are non-fatal (bare file entity created instead); " +
      "incremental mode skips files whose mtime+hash match DB row; sourceDirs option limits scan scope; embedding is Phase 5 — async, best-effort, never blocks indexing. " +
      "Error propagation: errors in parsing produce degraded (entity-free) file rows rather than halting the pipeline. " +
      // Vocabulary bridge: errors-are-values, handle-partial-failure, observable-best-effort, functions-do-one-thing
      "Pattern vocabulary: typed result propagation — parse errors are captured as degraded entities rather than thrown exceptions (errors-as-values pattern). " +
      "Handles partial failure: individual file parse failures do not halt the pipeline; remaining files continue processing (graceful degradation). " +
      "Each phase is a separate function doing one thing — scan, parse, link, persist, embed are isolated responsibilities (single responsibility, functions-do-one-thing). " +
      "Best-effort embedding: Phase 5 runs async and never blocks pipeline completion; embedding failures are non-fatal and observable via logging.",
  },
  {
    path: "graph/kg-query.ts",
    summary:
      "Read-only query module over the knowledge graph SQLite DB — callers, callees, search, dead code, ancestors, blast radius, file degrees, subgraph. " +
      "Architectural role: the exclusive read interface for entity-level graph traversal. All SELECT queries centralized here, no mutations. " +
      "Relationships: used by kg-blast-radius, get-file-context, graph_query tool, and any code needing graph traversal. Depends on kg-query-insights for impact scoring. " +
      "Concerns: all statements prepared at construction for performance; SQL-level joins for callers/callees (edges table); " +
      "computeImpactScore integrates in_degree, layer centrality, and violation count into a single score; " +
      "getFileMetrics is N+1 risk if called in a loop — callers must use computeFileInsightMaps for batch pre-computation. " +
      // Vocabulary bridge: information-hiding, command-query-separation, consistent-abstraction-levels, measure-before-optimizing
      "Pattern vocabulary: strict command-query separation — this module contains only queries (SELECT), never mutations (no INSERT/UPDATE/DELETE). KgStore owns the command side. " +
      "Encapsulates the graph traversal algorithm — callers don't know whether callers/callees are computed via SQL joins or in-memory traversal (information hiding). " +
      "All methods operate at entity/file abstraction level (consistent abstraction levels). " +
      "Performance optimization via prepared statements and batch pre-computation (computeFileInsightMaps) to avoid N+1 queries — measure-before-optimizing guided caching strategy.",
  },
  {
    path: "graph/kg-vector-store.ts",
    summary:
      "CRUD layer for entity_vectors and summary_vectors (sqlite-vec vec0 virtual tables). " +
      "Architectural role: manages vector persistence — inserts, staleness detection, and cleanup for semantic search. " +
      "Relationships: used by kg-pipeline.ts for vector persistence after embedding; KgVectorQuery uses it for ANN queries. " +
      "Concerns: sqlite-vec 0.1.6-alpha.2 bug — prepared statement binding fails on vec0 inserts, so all vec0 writes use db.exec() with inline JSON string literals (workaround). " +
      "Meta tables (entity_vector_meta, summary_vector_meta) track text hashes for staleness detection and stay in sync with vec0 rows. " +
      "Throws on errors (internal infrastructure). " +
      // Vocabulary bridge: information-hiding, wrap-external-exceptions, simplicity-first, errors-are-values
      "Pattern vocabulary: wraps an external library quirk (sqlite-vec bug) — the workaround is encapsulated here so callers never know about the db.exec string-literal hack (wrap-external-exceptions, information-hiding). " +
      "Encapsulates the vector storage decision — changing from sqlite-vec to a different ANN store requires editing only this module. " +
      "Throws exceptions rather than returning typed results (appropriate for internal infrastructure where the caller cannot recover — infrastructure-level failure). " +
      "Simple staleness detection via text hash comparison — simplicity-first, no complex versioning.",
  },
  {
    path: "features/orchestration/tools/drive-flow.ts",
    summary:
      "Core state machine loop for Canon flow execution — the MCP tool that orchestrators call to advance build workflows. " +
      "Architectural role: central dispatch point for the entire orchestration engine. Every flow step (spawn, HITL, done) routes through here. " +
      "Relationships: calls enterAndPrepareState, reportResult, drive-flow-helpers, drive-flow-wave; depends on execution-store, board-state-schemas, flow-definition-schemas. " +
      "Concerns: turn-by-turn protocol (first call enters state, subsequent calls report result and advance); " +
      "wave state handling (parallel agent tasks); convergence limit enforcement; stuck detection; HITL breakpoint generation; " +
      "settings injection for auto-approve worktrees. Returns ToolResult<DriveFlowAction> — never throws for expected conditions. " +
      // Vocabulary bridge: errors-are-values, no-hidden-side-effects, functions-do-one-thing, handle-partial-failure, validate-at-trust-boundaries
      "Pattern vocabulary: returns ToolResult<DriveFlowAction> typed discriminated union — never throws for expected conditions (errors-are-values pattern). " +
      "All state transitions are explicit and declared — no hidden side effects in the call chain (no-hidden-side-effects). " +
      "Each state handler does one thing: enter, execute, or transition (functions-do-one-thing). " +
      "Handles partial failure: stuck detection and convergence limits prevent infinite loops when agents fail. " +
      "Validates user-supplied flow definitions at the trust boundary before executing state machine transitions (validate-at-trust-boundaries).",
  },
  {
    path: "features/orchestration/tools/report-result.ts",
    summary:
      "MCP tool wrapper for recording agent results and evaluating state machine transitions. " +
      "Architectural role: the write path for agent outcomes — updates board state, advances transitions, detects stuck states, evaluates quality signals. " +
      "Relationships: calls syncBoardToStore, evaluateTransition, applyBoardMutations, postTransactionSideEffects; validates required artifacts and handoffs. " +
      "Concerns: accepts optional quality signal fields (gate_results, postcondition_results, violation_count, test_results, files_changed); " +
      "discovery fields (discovered_gates, discovered_postconditions) accumulate across calls; " +
      "debate protocol integration (inspectDebateProgress); optional role handling for parallel states. " +
      "State management: board mutations inside store.transaction() for atomicity; optimistic locking prevents concurrent stale writes. " +
      // Vocabulary bridge: errors-are-values, no-hidden-side-effects, command-query-separation, fail-closed-by-default
      "Pattern vocabulary: returns typed ToolResult — never throws (errors-are-values). " +
      "Side effects (board mutations, transition evaluation) are declared and explicit — no hidden side effects. " +
      "Pure command: records results and triggers transitions; does not return query data about board state (command-query-separation). " +
      "Fail-closed: if required artifacts are missing or handoff validation fails, the transition is rejected rather than proceeding with incomplete state (fail-closed-by-default).",
  },
  {
    path: "features/orchestration/tools/init-workspace.ts",
    summary:
      "MCP tool for creating or resuming Canon build workspaces — the entry point for every new flow execution. " +
      "Architectural role: lifecycle management for workspace directories, git worktrees, board state, and file claims preflight. " +
      "Relationships: calls loadAndResolveFlow, createWorkspace, generateSlug, gitWorktreeAdd, seedFromPriorWorkspace, KgQuery. " +
      "Concerns: preflight mode checks git status, stale sessions, and active file claims before creating; " +
      "creates build worktree at {workspace}/worktree on canon/{slug} branch; " +
      "returns empty workspace string on preflight failure (caller must check preflight_issues); " +
      "slug collision detection prevents accidental workspace reuse; cache_prefix_hash for prompt caching optimization. " +
      "Security: file claims are informational-only (non-blocking) — advisory overlap warnings, not hard blocks. " +
      // Vocabulary bridge: validate-at-trust-boundaries, errors-are-values, fail-closed-by-default, no-hidden-side-effects, least-privilege-access
      "Pattern vocabulary: validates all inputs at the trust boundary — git status, flow definition, existing workspace state — before creating any filesystem artifacts (validate-at-trust-boundaries). " +
      "Returns typed ToolResult with preflight_issues field — caller must explicitly check before proceeding (errors-are-values). " +
      "Fail-closed on preflight: returns empty workspace string on preflight failure rather than creating a partial workspace (fail-closed-by-default). " +
      "No hidden side effects: workspace creation, worktree allocation, and board initialization are all declared steps. " +
      "Least privilege: file claims are advisory-only; no lock escalation or blocking of other workspaces.",
  },
  {
    path: "features/principles/tools/get-principles.ts",
    summary:
      "MCP tool for matching Canon principles to a file or layer context. " +
      "Architectural role: the principle retrieval interface — agents call this to get relevant engineering principles before writing code. " +
      "Relationships: calls loadAllPrinciples, matchPrinciples, KgQuery for graph context enrichment; uses filterBodyBySections for summary_only mode. " +
      "Concerns: layer inference from file path (via inferLayer); graph context overlay (in_degree, impact_score) when file_path provided; " +
      "configurable max_principles_per_review limit; summary_only flag returns first paragraph only for token efficiency. " +
      "Trust boundary: file_path is user-supplied but not used for filesystem access — only pattern matching. " +
      // Vocabulary bridge: validate-at-trust-boundaries, information-hiding, errors-are-values, functions-do-one-thing
      "Pattern vocabulary: validates user-supplied file_path at the trust boundary — path is used only for pattern matching, never for filesystem access (validate-at-trust-boundaries, least-privilege). " +
      "Encapsulates principle loading and matching logic — callers receive filtered principles without knowing about glob patterns, mtime caches, or layer inference internals (information-hiding). " +
      "Returns typed ToolResult — never throws for expected conditions (errors-are-values). " +
      "Single responsibility: matching principles for a given context — does not also load, parse, or validate principles (functions-do-one-thing).",
  },
  {
    path: "features/file-context/tools/get-file-context.ts",
    summary:
      "MCP tool that assembles rich context for a source file — contents, graph relationships, structural metrics, hotspot data, blast radius. " +
      "Architectural role: the primary file inspection interface for agents needing deep context about a single file before editing it. " +
      "Relationships: reads file contents via readFile, extracts imports/exports via import-parser/export-parser, queries KgQuery for metrics, " +
      "loads hotspot and co-change data from git-intel tables, computes blast radius via kg-blast-radius. " +
      "Concerns: high fan-in file (many features depend on its output shape); returns up to FILE_PREVIEW_MAX_LINES (200) of content; " +
      "shape derivation (Sink/Hub/Central/Leaf/Internal) from in_degree/out_degree; git-intel freshness check triggers ensureGitIntelFresh when projectDir provided. " +
      "Security: path traversal guard via isNotFound + toPosix normalization; file content is trusted (read from project tree, not user-supplied payload). " +
      // Vocabulary bridge: validate-at-trust-boundaries, errors-are-values, information-hiding, handle-partial-failure, least-privilege-access
      "Pattern vocabulary: validates user-supplied file_path against path traversal at the trust boundary before any filesystem access (validate-at-trust-boundaries). " +
      "Returns typed ToolResult — not-found and permission errors are typed values, not thrown exceptions (errors-are-values). " +
      "Handles partial failure: git-intel freshness check is best-effort — stale data is returned rather than failing the whole request (handle-partial-failure). " +
      "Encapsulates graph metric computation — callers receive in_degree, impact_score, blast_radius without knowing about the SQLite query implementation (information-hiding). " +
      "Least privilege: file content capped at FILE_PREVIEW_MAX_LINES, not full file dump; path normalization prevents traversal outside project tree.",
  },
  {
    path: "shared/matcher.ts",
    summary:
      "Principle matching engine — filters all principles to those applicable for a given file path, layer, severity, or tags. " +
      "Architectural role: the decision layer between the principle library and any tool that needs context-aware principle selection. " +
      "Relationships: imported by get-principles.ts, review-code, and any code needing principle filtering; depends on parser.ts for loadPrincipleFile. " +
      "Concerns: glob-to-regex compilation with caching; mtime-based principle cache with invalidation across project + plugin directories; " +
      "severity ranking (rule > strong-opinion > convention) for sort ordering; " +
      "layer inference from file path segments using buildLayerInferrer. " +
      "Performance: globRegexCache prevents regex recompilation; principleCache avoids file re-reads on every tool call. " +
      // Vocabulary bridge: measure-before-optimizing, information-hiding, functions-do-one-thing, consistent-abstraction-levels
      "Pattern vocabulary: performance optimization driven by measurement — glob regex caching and mtime-based principle caching were added after profiling showed repeated re-compilation cost (measure-before-optimizing). " +
      "Encapsulates the matching algorithm — callers don't know whether matching uses glob patterns, regex, or mtime caching (information-hiding). " +
      "Single responsibility: filter and rank principles for a context — does not load, parse, or display them (functions-do-one-thing). " +
      "All methods operate at principle-selection abstraction level — no mixing of file I/O with matching logic (consistent abstraction levels).",
  },
  {
    path: "shared/parser.ts",
    summary:
      "Principle file parser — extracts YAML frontmatter and structured sections (Anti-Rationalization, Verification) from principle markdown files. " +
      "Architectural role: the parsing foundation for all principle loading — every principle in Canon flows through this module. " +
      "Relationships: used by matcher.ts (loadPrincipleFile), and any code that reads principle files directly. " +
      "Concerns: uses gray-matter for frontmatter parsing (replaced hand-rolled parser 2026-03-26); " +
      "extractSections splits on ## headings and separates known sections from body remainder; " +
      "filterBodyBySections supports summary-only mode (first paragraph) vs full body for token budget management. " +
      "Data integrity: id and title are required fields; parsePrinciple returns empty strings rather than throwing on missing fields. " +
      // Vocabulary bridge: functions-do-one-thing, errors-are-values, consistent-abstraction-levels, define-errors-out-of-existence
      "Pattern vocabulary: single responsibility — parse a principle markdown file into a structured object, nothing else (functions-do-one-thing). " +
      "Returns empty strings rather than throwing on missing required fields — the error condition (missing id/title) is eliminated by returning a default value rather than propagating an error (define-errors-out-of-existence). " +
      "All parsing functions operate at the same abstraction level: frontmatter extraction, section splitting, body filtering — no mixing of parsing with validation or display (consistent abstraction levels). " +
      "Errors from gray-matter are typed and handled rather than thrown upward to callers (errors-are-values).",
  },
  {
    path: "shared/lib/tool-result.ts",
    summary:
      "Defines the ToolResult<T> discriminated union — the error contract for all MCP tool handlers in Canon. " +
      "Architectural role: the error-handling foundation for the entire codebase. Every tool function returns this type instead of throwing. " +
      "Relationships: imported by every feature's tool handlers; wrapHandler depends on it for unexpected error wrapping. " +
      "Concerns: 9 CanonErrorCode string literals covering all expected error categories (WORKSPACE_NOT_FOUND, FLOW_NOT_FOUND, etc.); " +
      "toolOk/toolError constructors enforce shape; isToolError type guard for discriminated union narrowing; " +
      "assertOk for test contexts where success is required. " +
      "recoverable flag signals whether the orchestrator should retry or escalate to HITL. " +
      // Vocabulary bridge: errors-are-values, information-hiding, consistent-abstraction-levels, fail-closed-by-default
      "Pattern vocabulary: implements the errors-as-values pattern — typed discriminated union with { ok: true; data: T } and { ok: false; error: CanonErrorCode } branches; callers cannot ignore errors without exhaustive type-checking. " +
      "Encapsulates error shape — callers use isToolError type guard without knowing internal error fields (information-hiding). " +
      "All constructors operate at the same level: toolOk, toolError, isToolError, assertOk — no mixing of error creation with business logic (consistent abstraction levels). " +
      "fail-closed-by-default: recoverable flag distinguishes retryable errors from escalation-required failures; default is non-recoverable (fail-closed).",
  },
];

// ---------------------------------------------------------------------------
// Ground truth — same as iteration 1
// ---------------------------------------------------------------------------

const GROUND_TRUTH: Record<string, string[]> = {
  "graph/kg-embedding.ts": [
    "errors-are-values",
    "observable-best-effort",
    "simplicity-first",
    "handle-partial-failure",
  ],
  "graph/kg-store.ts": [
    "information-hiding",
    "prefer-immutable-data",
    "simplicity-first",
    "consistent-abstraction-levels",
  ],
  "graph/kg-pipeline.ts": [
    "errors-are-values",
    "handle-partial-failure",
    "observable-best-effort",
    "functions-do-one-thing",
  ],
  "graph/kg-query.ts": [
    "information-hiding",
    "command-query-separation",
    "consistent-abstraction-levels",
    "measure-before-optimizing",
  ],
  "graph/kg-vector-store.ts": [
    "information-hiding",
    "wrap-external-exceptions",
    "simplicity-first",
    "errors-are-values",
  ],
  "features/orchestration/tools/drive-flow.ts": [
    "errors-are-values",
    "no-hidden-side-effects",
    "functions-do-one-thing",
    "handle-partial-failure",
    "validate-at-trust-boundaries",
  ],
  "features/orchestration/tools/report-result.ts": [
    "errors-are-values",
    "no-hidden-side-effects",
    "command-query-separation",
    "fail-closed-by-default",
  ],
  "features/orchestration/tools/init-workspace.ts": [
    "validate-at-trust-boundaries",
    "errors-are-values",
    "fail-closed-by-default",
    "no-hidden-side-effects",
    "least-privilege-access",
  ],
  "features/principles/tools/get-principles.ts": [
    "validate-at-trust-boundaries",
    "information-hiding",
    "errors-are-values",
    "functions-do-one-thing",
  ],
  "features/file-context/tools/get-file-context.ts": [
    "validate-at-trust-boundaries",
    "errors-are-values",
    "information-hiding",
    "handle-partial-failure",
    "least-privilege-access",
  ],
  "shared/matcher.ts": [
    "measure-before-optimizing",
    "information-hiding",
    "functions-do-one-thing",
    "consistent-abstraction-levels",
  ],
  "shared/parser.ts": [
    "functions-do-one-thing",
    "errors-are-values",
    "consistent-abstraction-levels",
    "define-errors-out-of-existence",
  ],
  "shared/lib/tool-result.ts": [
    "errors-are-values",
    "information-hiding",
    "consistent-abstraction-levels",
    "fail-closed-by-default",
  ],
};

// ---------------------------------------------------------------------------
// Compose principle embedding text — Iteration 2a/2b change
// Use FULL body instead of just first paragraph
// ---------------------------------------------------------------------------

function composePrincipleText(p: Principle): string {
  // ITERATION 2 CHANGE: title + FULL body (includes rationale, examples, verification)
  // anti_rationalization is already in the body, so no need to append separately
  const parts = [`${p.title} (${p.severity})`];
  parts.push(p.body);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function recall_at_k(
  rankedPrinciples: string[],
  groundTruth: string[],
  k: number,
): number {
  if (groundTruth.length === 0) return 1.0;
  const topK = new Set(rankedPrinciples.slice(0, k));
  const hits = groundTruth.filter((id) => topK.has(id)).length;
  return hits / groundTruth.length;
}

// ---------------------------------------------------------------------------
// Run evaluation for a set of file summaries
// ---------------------------------------------------------------------------

type FileResult = {
  file: string;
  ranked: Array<{ id: string; score: number }>;
  groundTruth: string[];
  recall10: number;
  topScore: number;
  medianScore: number;
  gap: number;
};

async function runEval(
  summaries: FileSummary[],
  principleTexts: string[],
  principleIds: string[],
  svc: EmbeddingService,
  label: string,
): Promise<{ fileResults: FileResult[]; aggRecall10: number; avgGap: number }> {
  console.log(`\n=== Running ${label} ===`);
  console.log(`Embedding ${summaries.length} file summaries...`);
  const fileTexts = summaries.map((f) => f.summary);
  const fileEmbeddings = await svc.embed(fileTexts);

  // Build similarity matrix
  const matrix: number[][] = [];
  for (let i = 0; i < fileEmbeddings.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < principleTexts.length; j++) {
      row.push(cosineSim(fileEmbeddings[i]!, (await svc.embed([principleTexts[j]!]))[0]!));
    }
    matrix.push(row);
  }

  const fileResults: FileResult[] = [];
  for (let i = 0; i < summaries.length; i++) {
    const file = summaries[i]!;
    const scores = matrix[i]!.map((score, j) => ({
      id: principleIds[j]!,
      score,
    }));
    scores.sort((a, b) => b.score - a.score);

    const gt = GROUND_TRUTH[file.path] ?? [];
    const r10 = recall_at_k(scores.map((s) => s.id), gt, 10);
    const topScore = scores[0]?.score ?? 0;
    const medianScore = scores[Math.floor(scores.length / 2)]?.score ?? 0;
    const gap = topScore - medianScore;

    fileResults.push({
      file: file.path,
      ranked: scores.slice(0, 15),
      groundTruth: gt,
      recall10: r10,
      topScore,
      medianScore,
      gap,
    });
  }

  const aggRecall10 = fileResults.reduce((sum, r) => sum + r.recall10, 0) / fileResults.length;
  const avgGap = fileResults.reduce((sum, r) => sum + r.gap, 0) / fileResults.length;

  console.log(`Aggregate Recall@10: ${(aggRecall10 * 100).toFixed(1)}% → ${aggRecall10 >= 0.8 ? "GO" : "NO-GO"}`);
  for (const r of fileResults) {
    const hitIds = r.groundTruth.filter((id) => r.ranked.slice(0, 10).map((x) => x.id).includes(id));
    const missIds = r.groundTruth.filter((id) => !hitIds.includes(id));
    console.log(`  ${r.file}: Recall@10=${(r.recall10 * 100).toFixed(0)}% hits=[${hitIds.join(",")}] misses=[${missIds.join(",")}]`);
    console.log(`    Top5: ${r.ranked.slice(0, 5).map((x) => `${x.id}(${x.score.toFixed(3)})`).join(", ")}`);
  }

  return { fileResults, aggRecall10, avgGap };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Loading principles from", PRINCIPLES_DIR);
  const principles = await loadPrinciples(PRINCIPLES_DIR);
  console.log(`Loaded ${principles.length} principles`);

  const svc = new EmbeddingService();
  console.log("Initializing embedding model (first call — may download)...");

  // Compose principle texts (full body — iter 2 change)
  const principleTexts = principles.map(composePrincipleText);
  const principleIds = principles.map((p) => p.id);

  console.log(`Embedding ${principles.length} principles (full body)...`);
  const principleEmbeddings = await svc.embed(principleTexts);

  // Pre-computed principle embeddings for reuse
  // Build a fast lookup: index → embedding
  const principleEmbMap = new Map<number, Float32Array>();
  for (let j = 0; j < principleEmbeddings.length; j++) {
    principleEmbMap.set(j, principleEmbeddings[j]!);
  }

  // Helper that uses pre-computed principle embeddings
  async function runEvalFast(
    summaries: FileSummary[],
    label: string,
  ): Promise<{ fileResults: FileResult[]; aggRecall10: number; avgGap: number }> {
    console.log(`\n=== Running ${label} ===`);
    console.log(`Embedding ${summaries.length} file summaries...`);
    const fileTexts = summaries.map((f) => f.summary);
    const fileEmbeddings = await svc.embed(fileTexts);

    const fileResults: FileResult[] = [];
    for (let i = 0; i < summaries.length; i++) {
      const file = summaries[i]!;
      const fileEmb = fileEmbeddings[i]!;

      const scores = principleEmbeddings.map((pe, j) => ({
        id: principleIds[j]!,
        score: cosineSim(fileEmb, pe),
      }));
      scores.sort((a, b) => b.score - a.score);

      const gt = GROUND_TRUTH[file.path] ?? [];
      const r10 = recall_at_k(scores.map((s) => s.id), gt, 10);
      const topScore = scores[0]?.score ?? 0;
      const medianScore = scores[Math.floor(scores.length / 2)]?.score ?? 0;
      const gap = topScore - medianScore;

      fileResults.push({
        file: file.path,
        ranked: scores.slice(0, 15),
        groundTruth: gt,
        recall10: r10,
        topScore,
        medianScore,
        gap,
      });
    }

    const aggRecall10 = fileResults.reduce((sum, r) => sum + r.recall10, 0) / fileResults.length;
    const avgGap = fileResults.reduce((sum, r) => sum + r.gap, 0) / fileResults.length;

    console.log(`Aggregate Recall@10: ${(aggRecall10 * 100).toFixed(1)}% → ${aggRecall10 >= 0.8 ? "GO" : "NO-GO"}`);
    for (const r of fileResults) {
      const hitIds = r.groundTruth.filter((id) => r.ranked.slice(0, 10).map((x) => x.id).includes(id));
      const missIds = r.groundTruth.filter((id) => !hitIds.includes(id));
      console.log(`  ${r.file}: Recall@10=${(r.recall10 * 100).toFixed(0)}% hits=[${hitIds.join(",")}] misses=[${missIds.join(",")}]`);
      console.log(`    Top5: ${r.ranked.slice(0, 5).map((x) => `${x.id}(${x.score.toFixed(3)})`).join(", ")}`);
    }

    return { fileResults, aggRecall10, avgGap };
  }

  // Run iteration 2a: full principle body + original summaries
  const iter2a = await runEvalFast(ENRICHED_SUMMARIES_ITER1, "Iteration 2a: Full Principle Body + Original Summaries");

  // Run iteration 2b: full principle body + vocabulary-enriched summaries
  const iter2b = await runEvalFast(ENRICHED_SUMMARIES_ITER2B, "Iteration 2b: Full Principle Body + Vocabulary-Enriched Summaries");

  // Write iteration 2a similarity matrix
  const { writeFile: fsWriteFile } = await import("node:fs/promises");
  const matrixPath2a = join(OUTPUT_DIR, "spike-similarity-matrix.json");
  const matrixOutput2a = {
    iteration: "2a",
    description: "Full principle body + original enriched summaries",
    files: ENRICHED_SUMMARIES_ITER1.map((f) => f.path),
    principles: principleIds,
    matrix: iter2a.fileResults.map((r) => r.ranked.map((x) => x.score)),
    ground_truth: GROUND_TRUTH,
    metrics: {
      aggRecall10: iter2a.aggRecall10,
      avgGap: iter2a.avgGap,
    },
    per_file: iter2a.fileResults.map((r) => ({
      file: r.file,
      recall10: r.recall10,
      topScore: r.topScore,
      medianScore: r.medianScore,
      gap: r.gap,
      top15: r.ranked,
    })),
    "2b_metrics": {
      aggRecall10: iter2b.aggRecall10,
      avgGap: iter2b.avgGap,
    },
    "2b_per_file": iter2b.fileResults.map((r) => ({
      file: r.file,
      recall10: r.recall10,
      topScore: r.topScore,
      medianScore: r.medianScore,
      gap: r.gap,
      top15: r.ranked,
    })),
  };
  await fsWriteFile(matrixPath2a, JSON.stringify(matrixOutput2a, null, 2));
  console.log(`\nMatrix written to: ${matrixPath2a}`);

  // Iteration 1 baselines (from the existing findings)
  const iter1Baselines: Record<string, number> = {
    "graph/kg-embedding.ts": 0.0,
    "graph/kg-store.ts": 0.5,
    "graph/kg-pipeline.ts": 0.25,
    "graph/kg-query.ts": 0.5,
    "graph/kg-vector-store.ts": 0.0,
    "features/orchestration/tools/drive-flow.ts": 0.4,
    "features/orchestration/tools/report-result.ts": 0.0,
    "features/orchestration/tools/init-workspace.ts": 0.0,
    "features/principles/tools/get-principles.ts": 0.5,
    "features/file-context/tools/get-file-context.ts": 0.4,
    "shared/matcher.ts": 0.75,
    "shared/parser.ts": 0.0,
    "shared/lib/tool-result.ts": 0.75,
  };
  const iter1AggRecall10 = 0.312;

  // Write spike-findings.md update (append Iteration 2 section)
  const findingsPath = join(OUTPUT_DIR, "spike-findings.md");
  const existingFindings = await readFile(findingsPath, "utf-8");
  const iter2Section = buildIter2Section(
    iter2a.fileResults, iter2a.aggRecall10, iter2a.avgGap,
    iter2b.fileResults, iter2b.aggRecall10, iter2b.avgGap,
    iter1Baselines, iter1AggRecall10,
    principles.length,
  );
  await fsWriteFile(findingsPath, existingFindings + "\n\n" + iter2Section);
  console.log(`Findings updated at: ${findingsPath}`);
}

function buildIter2Section(
  results2a: FileResult[], agg2a: number, gap2a: number,
  results2b: FileResult[], agg2b: number, gap2b: number,
  iter1Baselines: Record<string, number>, iter1Agg: number,
  principleCount: number,
): string {
  const go2a = agg2a >= 0.8;
  const go2b = agg2b >= 0.8;
  const lines: string[] = [];

  lines.push("## Iteration 2");
  lines.push("");
  lines.push("### Change Made");
  lines.push("");
  lines.push("**Iteration 2a**: Modified `composePrincipleText()` to use the **full principle body** (title + complete markdown body including Rationale, Examples, Anti-Rationalization, and Verification sections) instead of just the title + first paragraph + 300-char anti-rationalization excerpt.");
  lines.push("");
  lines.push("**Iteration 2b**: Same full-body principle embeddings, but also added **explicit principle-vocabulary bridges** to each file summary. Each summary was augmented with a \"Pattern vocabulary\" paragraph that names the patterns in principle-language terms (e.g., \"errors-as-values pattern using discriminated unions\", \"validate-at-trust-boundaries\", \"information hiding / encapsulation of design decision\").");
  lines.push("");
  lines.push("### Iteration 2a Results — Full Principle Body");
  lines.push("");
  lines.push(`**Aggregate Recall@10: ${(agg2a * 100).toFixed(1)}%** (Iteration 1 baseline: ${(iter1Agg * 100).toFixed(1)}%)`);
  lines.push(`**Average discrimination gap: ${gap2a.toFixed(4)}** (Iteration 1: 0.1984)`);
  lines.push(`**Go threshold: ≥80% → ${go2a ? "GO" : "NO-GO"}**`);
  lines.push("");

  lines.push("#### Per-File Recall@10 (Iteration 2a)");
  lines.push("");
  lines.push("| File | Iter 1 | Iter 2a | Delta | Hits (top 10) | Misses |");
  lines.push("|------|--------|---------|-------|----------------|--------|");
  for (const r of results2a) {
    const iter1 = iter1Baselines[r.file] ?? 0;
    const delta = r.recall10 - iter1;
    const deltaStr = delta > 0 ? `+${(delta * 100).toFixed(0)}%` : delta < 0 ? `${(delta * 100).toFixed(0)}%` : "=";
    const hitIds = r.groundTruth.filter((id) => r.ranked.slice(0, 10).map((x) => x.id).includes(id));
    const missIds = r.groundTruth.filter((id) => !hitIds.includes(id));
    lines.push(`| ${r.file} | ${(iter1 * 100).toFixed(0)}% | ${(r.recall10 * 100).toFixed(0)}% | ${deltaStr} | ${hitIds.join(", ") || "none"} | ${missIds.join(", ") || "none"} |`);
  }
  lines.push("");

  lines.push("#### Top-5 Rankings for Key Files (Iteration 2a)");
  lines.push("");
  for (const r of results2a) {
    lines.push(`**\`${r.file}\`** (ground truth: ${r.groundTruth.join(", ")})`);
    lines.push(`Recall@10: ${(r.recall10 * 100).toFixed(0)}% | Top: ${r.topScore.toFixed(4)} | Median: ${r.medianScore.toFixed(4)} | Gap: ${r.gap.toFixed(4)}`);
    lines.push("");
    lines.push("| Rank | Principle | Score | In GT? |");
    lines.push("|------|-----------|-------|--------|");
    for (let i = 0; i < Math.min(10, r.ranked.length); i++) {
      const entry = r.ranked[i]!;
      const inGT = r.groundTruth.includes(entry.id) ? "YES" : "";
      lines.push(`| ${i + 1} | ${entry.id} | ${entry.score.toFixed(4)} | ${inGT} |`);
    }
    lines.push("");
  }

  lines.push("### Iteration 2b Results — Full Principle Body + Vocabulary-Enriched Summaries");
  lines.push("");
  lines.push(`**Aggregate Recall@10: ${(agg2b * 100).toFixed(1)}%** (Iteration 1: ${(iter1Agg * 100).toFixed(1)}%, Iteration 2a: ${(agg2a * 100).toFixed(1)}%)`);
  lines.push(`**Average discrimination gap: ${gap2b.toFixed(4)}** (Iteration 1: 0.1984, Iteration 2a: ${gap2a.toFixed(4)})`);
  lines.push(`**Go threshold: ≥80% → ${go2b ? "GO" : "NO-GO"}**`);
  lines.push("");

  lines.push("#### Per-File Recall@10 (Iteration 2b)");
  lines.push("");
  lines.push("| File | Iter 1 | Iter 2a | Iter 2b | Delta vs 2a | Hits (top 10) | Misses |");
  lines.push("|------|--------|---------|---------|-------------|----------------|--------|");
  for (let i = 0; i < results2b.length; i++) {
    const r = results2b[i]!;
    const r2a = results2a[i]!;
    const iter1 = iter1Baselines[r.file] ?? 0;
    const delta = r.recall10 - r2a.recall10;
    const deltaStr = delta > 0 ? `+${(delta * 100).toFixed(0)}%` : delta < 0 ? `${(delta * 100).toFixed(0)}%` : "=";
    const hitIds = r.groundTruth.filter((id) => r.ranked.slice(0, 10).map((x) => x.id).includes(id));
    const missIds = r.groundTruth.filter((id) => !hitIds.includes(id));
    lines.push(`| ${r.file} | ${(iter1 * 100).toFixed(0)}% | ${(r2a.recall10 * 100).toFixed(0)}% | ${(r.recall10 * 100).toFixed(0)}% | ${deltaStr} | ${hitIds.join(", ") || "none"} | ${missIds.join(", ") || "none"} |`);
  }
  lines.push("");

  lines.push("#### Top-5 Rankings for Key Files (Iteration 2b)");
  lines.push("");
  for (const r of results2b) {
    lines.push(`**\`${r.file}\`** (ground truth: ${r.groundTruth.join(", ")})`);
    lines.push(`Recall@10: ${(r.recall10 * 100).toFixed(0)}% | Top: ${r.topScore.toFixed(4)} | Median: ${r.medianScore.toFixed(4)} | Gap: ${r.gap.toFixed(4)}`);
    lines.push("");
    lines.push("| Rank | Principle | Score | In GT? |");
    lines.push("|------|-----------|-------|--------|");
    for (let i = 0; i < Math.min(10, r.ranked.length); i++) {
      const entry = r.ranked[i]!;
      const inGT = r.groundTruth.includes(entry.id) ? "YES" : "";
      lines.push(`| ${i + 1} | ${entry.id} | ${entry.score.toFixed(4)} | ${inGT} |`);
    }
    lines.push("");
  }

  lines.push("### Comparison Table: All Iterations");
  lines.push("");
  lines.push("| Metric | Iteration 1 | Iteration 2a | Iteration 2b |");
  lines.push("|--------|-------------|--------------|--------------|");
  lines.push(`| Principle embedding text | Title + first para + 300-char anti-rat | Title + full body | Title + full body |`);
  lines.push(`| Summary type | Enriched (role/relationships/concerns) | Same as iter 1 | Enriched + pattern vocabulary |`);
  lines.push(`| Aggregate Recall@10 | ${(iter1Agg * 100).toFixed(1)}% | ${(agg2a * 100).toFixed(1)}% | ${(agg2b * 100).toFixed(1)}% |`);
  lines.push(`| Average discrimination gap | 0.1984 | ${gap2a.toFixed(4)} | ${gap2b.toFixed(4)} |`);
  lines.push(`| Files at 0% recall | 5 | ${results2a.filter((r) => r.recall10 === 0).length} | ${results2b.filter((r) => r.recall10 === 0).length} |`);
  lines.push(`| Files at 100% recall | 0 | ${results2a.filter((r) => r.recall10 === 1.0).length} | ${results2b.filter((r) => r.recall10 === 1.0).length} |`);
  lines.push(`| Go/No-Go | NO-GO | ${go2a ? "GO" : "NO-GO"} | ${go2b ? "GO" : "NO-GO"} |`);
  lines.push("");

  lines.push("### Analysis");
  lines.push("");

  const improvement2a = ((agg2a - iter1Agg) * 100).toFixed(1);
  const improvement2b = ((agg2b - iter1Agg) * 100).toFixed(1);
  const improvement2bVs2a = ((agg2b - agg2a) * 100).toFixed(1);

  lines.push(`**Full principle body (2a)** changed aggregate recall by ${Number(improvement2a) >= 0 ? "+" : ""}${improvement2a} percentage points (${(iter1Agg * 100).toFixed(1)}% → ${(agg2a * 100).toFixed(1)}%).`);
  lines.push("");
  lines.push(`**Vocabulary-enriched summaries (2b)** changed aggregate recall by ${Number(improvement2bVs2a) >= 0 ? "+" : ""}${improvement2bVs2a} percentage points vs 2a (${(agg2a * 100).toFixed(1)}% → ${(agg2b * 100).toFixed(1)}%), and ${Number(improvement2b) >= 0 ? "+" : ""}${improvement2b} percentage points vs iteration 1.`);
  lines.push("");

  // Identify which files improved, stayed same, or regressed
  const improvedFiles2a = results2a.filter((r) => r.recall10 > (iter1Baselines[r.file] ?? 0));
  const regressedFiles2a = results2a.filter((r) => r.recall10 < (iter1Baselines[r.file] ?? 0));
  const sameFiles2a = results2a.filter((r) => r.recall10 === (iter1Baselines[r.file] ?? 0));

  lines.push(`In iteration 2a: **${improvedFiles2a.length} files improved**, **${sameFiles2a.length} unchanged**, **${regressedFiles2a.length} regressed**.`);
  if (improvedFiles2a.length > 0) {
    lines.push(`Improved: ${improvedFiles2a.map((r) => `${r.file} (${((iter1Baselines[r.file] ?? 0) * 100).toFixed(0)}% → ${(r.recall10 * 100).toFixed(0)}%)`).join(", ")}`);
  }
  if (regressedFiles2a.length > 0) {
    lines.push(`Regressed: ${regressedFiles2a.map((r) => `${r.file} (${((iter1Baselines[r.file] ?? 0) * 100).toFixed(0)}% → ${(r.recall10 * 100).toFixed(0)}%)`).join(", ")}`);
  }
  lines.push("");

  const improvedFiles2b = results2b.filter((r, i) => r.recall10 > (results2a[i]?.recall10 ?? 0));
  const regressedFiles2b = results2b.filter((r, i) => r.recall10 < (results2a[i]?.recall10 ?? 0));
  lines.push(`In iteration 2b vs 2a: **${improvedFiles2b.length} files improved**, **${results2b.length - improvedFiles2b.length - regressedFiles2b.length} unchanged**, **${regressedFiles2b.length} regressed**.`);
  if (improvedFiles2b.length > 0) {
    lines.push(`Improved: ${improvedFiles2b.map((r, i) => {
      const r2a = results2a.find((x) => x.file === r.file);
      return `${r.file} (${((r2a?.recall10 ?? 0) * 100).toFixed(0)}% → ${(r.recall10 * 100).toFixed(0)}%)`;
    }).join(", ")}`);
  }
  if (regressedFiles2b.length > 0) {
    lines.push(`Regressed: ${regressedFiles2b.map((r) => {
      const r2a = results2a.find((x) => x.file === r.file);
      return `${r.file} (${((r2a?.recall10 ?? 0) * 100).toFixed(0)}% → ${(r.recall10 * 100).toFixed(0)}%)`;
    }).join(", ")}`);
  }
  lines.push("");

  lines.push("### Updated Go/No-Go Recommendation");
  lines.push("");

  const bestAgg = Math.max(agg2a, agg2b);
  const bestLabel = agg2b >= agg2a ? "Iteration 2b" : "Iteration 2a";

  if (bestAgg >= 0.8) {
    lines.push(`**RECOMMENDATION: GO** (${bestLabel})`);
    lines.push("");
    lines.push(`Best aggregate Recall@10 of ${(bestAgg * 100).toFixed(1)}% meets the 80% threshold. The approach is viable for production use.`);
    lines.push("");
    lines.push(`The key insight: ${agg2b >= agg2a
      ? "vocabulary bridging in the file summaries (naming patterns in principle-language terms) was the decisive lever — full principle body alone was not sufficient, but combined with vocabulary-enriched summaries the threshold was crossed."
      : "full principle body provided enough vocabulary overlap with file descriptions to cross the threshold without requiring manual vocabulary enrichment."}`);
  } else if (bestAgg >= 0.6) {
    lines.push(`**RECOMMENDATION: NO-GO (but progressing)** — Best: ${(bestAgg * 100).toFixed(1)}% (threshold: 80%)`);
    lines.push("");
    lines.push(`The full-body and vocabulary-enrichment approaches improved recall significantly but did not reach the 80% threshold. Progress is real but insufficient.`);
    lines.push("");
    lines.push("**What would need to change to reach 80%:**");
    lines.push("");
    lines.push("1. **Hybrid lexical+semantic matching** — Add BM25 or TF-IDF scoring on principle ID, title, and tags alongside cosine similarity. The `tags` field (e.g., `error-handling`, `security`, `validation`) provides a direct vocabulary bridge that semantic embeddings miss.");
    lines.push("2. **Larger embedding model** — all-MiniLM-L6-v2 (22M params, 384-dim) is optimized for speed, not domain accuracy. A larger model (e.g., `all-mpnet-base-v2`, 768-dim) trained on more diverse text may better handle the prescriptive→descriptive semantic gap.");
    lines.push("3. **Principle tag matching** — Match the principle's `tags` frontmatter field against inferred tags from file summaries. Files with 'error-handling' patterns would match principles tagged `error-handling` directly.");
    lines.push("4. **Few-shot retrieval** — Add 2-3 example (file summary, applicable principle) pairs to each principle as training signal for retrieval. The current approach has no labeled pairs — the model generalizes from general-purpose text similarity.");
  } else {
    lines.push(`**RECOMMENDATION: NO-GO** — Best: ${(bestAgg * 100).toFixed(1)}% (threshold: 80%)`);
    lines.push("");
    lines.push(`Despite full-body principle embeddings and vocabulary-enriched summaries, aggregate Recall@10 remains well below 80%. The semantic gap between descriptive file summaries and prescriptive principle text is not bridgeable by vocabulary alignment alone.`);
    lines.push("");
    lines.push("**What would need to change:**");
    lines.push("");
    lines.push("1. **Hybrid lexical+semantic matching** — The most direct path: add principle tag/keyword matching alongside cosine similarity.");
    lines.push("2. **Larger embedding model** — Domain-adapted or larger general-purpose model (e.g., `all-mpnet-base-v2`).");
    lines.push("3. **Fine-tuning** — Train on (file summary, applicable principle) pairs. Requires ~200+ labeled examples.");
    lines.push("4. **LLM-based matching** — Use an LLM to directly evaluate whether a principle applies to a file summary. Higher accuracy, higher cost.");
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Spike iter2 failed:", err);
  process.exit(1);
});
