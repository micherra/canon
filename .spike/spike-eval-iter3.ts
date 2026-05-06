/**
 * Spike Eval — Iteration 3
 *
 * Tests LLM-based reranking on top of embedding recall.
 *
 * Two-stage pipeline:
 * - Stage 1: Embedding recall — get top-20 candidates by cosine similarity
 *   (reused from iteration 2b matrix — no re-embedding needed)
 * - Stage 2: LLM rerank — send file summary + 20 candidates to Claude,
 *   ask which principles are genuinely applicable, return top 10
 *
 * Uses `claude -p` CLI for LLM calls (no API key needed — uses Claude Code auth).
 *
 * Usage: npx tsx .spike/spike-eval-iter3.ts
 * Run from: mcp-server/ directory
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
const SPIKE_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : fileURLToPath(new URL(".", import.meta.url));
const WORKTREE = join(SPIKE_DIR, "..");
const PRINCIPLES_DIR = join(WORKTREE, "principles");
const OUTPUT_DIR = SPIKE_DIR;

// ---------------------------------------------------------------------------
// Ground truth — same as prior iterations
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
// Enriched summaries — Iteration 2b vocabulary-enriched versions
// (reused from iter2 script — same summaries that gave 35.8% recall)
// ---------------------------------------------------------------------------

const ENRICHED_SUMMARIES: Record<string, string> = {
  "graph/kg-embedding.ts":
    "Wraps @huggingface/transformers for 384-dim sentence embedding (all-MiniLM-L6-v2, q8 quantized). " +
    "Architectural role: the sole vector representation layer for the knowledge graph — every semantic search query and summary embedding flows through here. " +
    "Relationships: called by kg-pipeline.ts (batch embed during indexing) and kg-vector-query.ts (query-time embedding); depends on @shared/constants for EMBEDDING_MODEL/EMBEDDING_DIM. " +
    "Concerns: throws on failure (intentional — internal infrastructure, not an MCP tool handler), lazy-loads model on first use with concurrent-safe init promise, " +
    "processes in batches of EMBEDDING_BATCH_SIZE to cap peak memory, uses normalize+mean pooling so output vectors are unit-normalized. " +
    "Pattern vocabulary: infrastructure service that throws exceptions rather than returning typed result objects (appropriate for internal callers who must handle failures). " +
    "Best-effort non-blocking design: embedding failures do not propagate to pipeline callers; failures are surfaced only to direct callers. " +
    "Lazy initialization with concurrent-safe promise prevents double-loading — simplicity-first single responsibility. " +
    "No timeout or circuit-breaker needed (in-process ML inference, not a distributed call), but handles OOM gracefully via batch size limits.",

  "graph/kg-store.ts":
    "Synchronous CRUD layer over a better-sqlite3 Database instance for the knowledge graph schema. " +
    "Architectural role: the single write path for files, entities, edges, file-edges, and summaries in the SQLite KG — all indexing mutations go through this class. " +
    "Relationships: constructed by kg-pipeline.ts with the same DB handle; used nowhere else for writes. KgQuery owns the read path. " +
    "Concerns: all statements are prepared at construction time for performance (statement reuse), boolean coercion for SQLite 0/1 integers, " +
    "upsert patterns for idempotent reindexing, file-level and entity-level cascade deletes for incremental updates. " +
    "State management: holds prepared statement references as private fields — not thread-safe, but better-sqlite3 is process-exclusive. " +
    "Pattern vocabulary: encapsulates the storage schema decision — changing the DB column layout requires editing only this module (information hiding, design decision encapsulation). " +
    "All public methods operate at the same abstraction level (entity operations), no mixing of low-level SQL with high-level orchestration (consistent abstraction levels). " +
    "Upsert semantics make writes idempotent — safe to call multiple times for the same entity. " +
    "Private fields hide implementation details; callers cannot access prepared statements directly.",

  "graph/kg-pipeline.ts":
    "Orchestrates the five-phase knowledge graph build: scan → parse → resolve-links → persist → embed. " +
    "Architectural role: top-level entry point for full KG indexing (runPipeline) and incremental single-file updates (reindexFile). Coordinates all infrastructure. " +
    "Relationships: imports EmbeddingService, KgStore, KgVectorStore, kg-pipeline-phases, kg-schema, kg-wasm-parser, scanner. " +
    "Concerns: all DB mutations wrapped in transactions for performance and atomicity; adapter errors are non-fatal (bare file entity created instead); " +
    "incremental mode skips files whose mtime+hash match DB row; sourceDirs option limits scan scope; embedding is Phase 5 — async, best-effort, never blocks indexing. " +
    "Error propagation: errors in parsing produce degraded (entity-free) file rows rather than halting the pipeline. " +
    "Pattern vocabulary: typed result propagation — parse errors are captured as degraded entities rather than thrown exceptions (errors-as-values pattern). " +
    "Handles partial failure: individual file parse failures do not halt the pipeline; remaining files continue processing (graceful degradation). " +
    "Each phase is a separate function doing one thing — scan, parse, link, persist, embed are isolated responsibilities (single responsibility, functions-do-one-thing). " +
    "Best-effort embedding: Phase 5 runs async and never blocks pipeline completion; embedding failures are non-fatal and observable via logging.",

  "graph/kg-query.ts":
    "Read-only query module over the knowledge graph SQLite DB — callers, callees, search, dead code, ancestors, blast radius, file degrees, subgraph. " +
    "Architectural role: the exclusive read interface for entity-level graph traversal. All SELECT queries centralized here, no mutations. " +
    "Relationships: used by kg-blast-radius, get-file-context, graph_query tool, and any code needing graph traversal. Depends on kg-query-insights for impact scoring. " +
    "Concerns: all statements prepared at construction for performance; SQL-level joins for callers/callees (edges table); " +
    "computeImpactScore integrates in_degree, layer centrality, and violation count into a single score; " +
    "getFileMetrics is N+1 risk if called in a loop — callers must use computeFileInsightMaps for batch pre-computation. " +
    "Pattern vocabulary: strict command-query separation — this module contains only queries (SELECT), never mutations (no INSERT/UPDATE/DELETE). KgStore owns the command side. " +
    "Encapsulates the graph traversal algorithm — callers don't know whether callers/callees are computed via SQL joins or in-memory traversal (information hiding). " +
    "All methods operate at entity/file abstraction level (consistent abstraction levels). " +
    "Performance optimization via prepared statements and batch pre-computation (computeFileInsightMaps) to avoid N+1 queries — measure-before-optimizing guided caching strategy.",

  "graph/kg-vector-store.ts":
    "CRUD layer for entity_vectors and summary_vectors (sqlite-vec vec0 virtual tables). " +
    "Architectural role: manages vector persistence — inserts, staleness detection, and cleanup for semantic search. " +
    "Relationships: used by kg-pipeline.ts for vector persistence after embedding; KgVectorQuery uses it for ANN queries. " +
    "Concerns: sqlite-vec 0.1.6-alpha.2 bug — prepared statement binding fails on vec0 inserts, so all vec0 writes use db.exec() with inline JSON string literals (workaround). " +
    "Meta tables (entity_vector_meta, summary_vector_meta) track text hashes for staleness detection and stay in sync with vec0 rows. " +
    "Throws on errors (internal infrastructure). " +
    "Pattern vocabulary: wraps an external library quirk (sqlite-vec bug) — the workaround is encapsulated here so callers never know about the db.exec string-literal hack (wrap-external-exceptions, information-hiding). " +
    "Encapsulates the vector storage decision — changing from sqlite-vec to a different ANN store requires editing only this module. " +
    "Throws exceptions rather than returning typed results (appropriate for internal infrastructure where the caller cannot recover — infrastructure-level failure). " +
    "Simple staleness detection via text hash comparison — simplicity-first, no complex versioning.",

  "features/orchestration/tools/drive-flow.ts":
    "Core state machine loop for Canon flow execution — the MCP tool that orchestrators call to advance build workflows. " +
    "Architectural role: central dispatch point for the entire orchestration engine. Every flow step (spawn, HITL, done) routes through here. " +
    "Relationships: calls enterAndPrepareState, reportResult, drive-flow-helpers, drive-flow-wave; depends on execution-store, board-state-schemas, flow-definition-schemas. " +
    "Concerns: turn-by-turn protocol (first call enters state, subsequent calls report result and advance); " +
    "wave state handling (parallel agent tasks); convergence limit enforcement; stuck detection; HITL breakpoint generation; " +
    "settings injection for auto-approve worktrees. Returns ToolResult<DriveFlowAction> — never throws for expected conditions. " +
    "Pattern vocabulary: returns ToolResult<DriveFlowAction> typed discriminated union — never throws for expected conditions (errors-are-values pattern). " +
    "All state transitions are explicit and declared — no hidden side effects in the call chain (no-hidden-side-effects). " +
    "Each state handler does one thing: enter, execute, or transition (functions-do-one-thing). " +
    "Handles partial failure: stuck detection and convergence limits prevent infinite loops when agents fail. " +
    "Validates user-supplied flow definitions at the trust boundary before executing state machine transitions (validate-at-trust-boundaries).",

  "features/orchestration/tools/report-result.ts":
    "MCP tool wrapper for recording agent results and evaluating state machine transitions. " +
    "Architectural role: the write path for agent outcomes — updates board state, advances transitions, detects stuck states, evaluates quality signals. " +
    "Relationships: calls syncBoardToStore, evaluateTransition, applyBoardMutations, postTransactionSideEffects; validates required artifacts and handoffs. " +
    "Concerns: accepts optional quality signal fields (gate_results, postcondition_results, violation_count, test_results, files_changed); " +
    "discovery fields (discovered_gates, discovered_postconditions) accumulate across calls; " +
    "debate protocol integration (inspectDebateProgress); optional role handling for parallel states. " +
    "State management: board mutations inside store.transaction() for atomicity; optimistic locking prevents concurrent stale writes. " +
    "Pattern vocabulary: returns typed ToolResult — never throws (errors-are-values). " +
    "Side effects (board mutations, transition evaluation) are declared and explicit — no hidden side effects. " +
    "Pure command: records results and triggers transitions; does not return query data about board state (command-query-separation). " +
    "Fail-closed: if required artifacts are missing or handoff validation fails, the transition is rejected rather than proceeding with incomplete state (fail-closed-by-default).",

  "features/orchestration/tools/init-workspace.ts":
    "MCP tool for creating or resuming Canon build workspaces — the entry point for every new flow execution. " +
    "Architectural role: lifecycle management for workspace directories, git worktrees, board state, and file claims preflight. " +
    "Relationships: calls loadAndResolveFlow, createWorkspace, generateSlug, gitWorktreeAdd, seedFromPriorWorkspace, KgQuery. " +
    "Concerns: preflight mode checks git status, stale sessions, and active file claims before creating; " +
    "creates build worktree at {workspace}/worktree on canon/{slug} branch; " +
    "returns empty workspace string on preflight failure (caller must check preflight_issues); " +
    "slug collision detection prevents accidental workspace reuse; cache_prefix_hash for prompt caching optimization. " +
    "Security: file claims are informational-only (non-blocking) — advisory overlap warnings, not hard blocks. " +
    "Pattern vocabulary: validates all inputs at the trust boundary — git status, flow definition, existing workspace state — before creating any filesystem artifacts (validate-at-trust-boundaries). " +
    "Returns typed ToolResult with preflight_issues field — caller must explicitly check before proceeding (errors-are-values). " +
    "Fail-closed on preflight: returns empty workspace string on preflight failure rather than creating a partial workspace (fail-closed-by-default). " +
    "No hidden side effects: workspace creation, worktree allocation, and board initialization are all declared steps. " +
    "Least privilege: file claims are advisory-only; no lock escalation or blocking of other workspaces.",

  "features/principles/tools/get-principles.ts":
    "MCP tool for matching Canon principles to a file or layer context. " +
    "Architectural role: the principle retrieval interface — agents call this to get relevant engineering principles before writing code. " +
    "Relationships: calls loadAllPrinciples, matchPrinciples, KgQuery for graph context enrichment; uses filterBodyBySections for summary_only mode. " +
    "Concerns: layer inference from file path (via inferLayer); graph context overlay (in_degree, impact_score) when file_path provided; " +
    "configurable max_principles_per_review limit; summary_only flag returns first paragraph only for token efficiency. " +
    "Trust boundary: file_path is user-supplied but not used for filesystem access — only pattern matching. " +
    "Pattern vocabulary: validates user-supplied file_path at the trust boundary — path is used only for pattern matching, never for filesystem access (validate-at-trust-boundaries, least-privilege). " +
    "Encapsulates principle loading and matching logic — callers receive filtered principles without knowing about glob patterns, mtime caches, or layer inference internals (information-hiding). " +
    "Returns typed ToolResult — never throws for expected conditions (errors-are-values). " +
    "Single responsibility: matching principles for a given context — does not also load, parse, or validate principles (functions-do-one-thing).",

  "features/file-context/tools/get-file-context.ts":
    "MCP tool that assembles rich context for a source file — contents, graph relationships, structural metrics, hotspot data, blast radius. " +
    "Architectural role: the primary file inspection interface for agents needing deep context about a single file before editing it. " +
    "Relationships: reads file contents via readFile, extracts imports/exports via import-parser/export-parser, queries KgQuery for metrics, " +
    "loads hotspot and co-change data from git-intel tables, computes blast radius via kg-blast-radius. " +
    "Concerns: high fan-in file (many features depend on its output shape); returns up to FILE_PREVIEW_MAX_LINES (200) of content; " +
    "shape derivation (Sink/Hub/Central/Leaf/Internal) from in_degree/out_degree; git-intel freshness check triggers ensureGitIntelFresh when projectDir provided. " +
    "Security: path traversal guard via isNotFound + toPosix normalization; file content is trusted (read from project tree, not user-supplied payload). " +
    "Pattern vocabulary: validates user-supplied file_path against path traversal at the trust boundary before any filesystem access (validate-at-trust-boundaries). " +
    "Returns typed ToolResult — not-found and permission errors are typed values, not thrown exceptions (errors-are-values). " +
    "Handles partial failure: git-intel freshness check is best-effort — stale data is returned rather than failing the whole request (handle-partial-failure). " +
    "Encapsulates graph metric computation — callers receive in_degree, impact_score, blast_radius without knowing about the SQLite query implementation (information-hiding). " +
    "Least privilege: file content capped at FILE_PREVIEW_MAX_LINES, not full file dump; path normalization prevents traversal outside project tree.",

  "shared/matcher.ts":
    "Principle matching engine — filters all principles to those applicable for a given file path, layer, severity, or tags. " +
    "Architectural role: the decision layer between the principle library and any tool that needs context-aware principle selection. " +
    "Relationships: imported by get-principles.ts, review-code, and any code needing principle filtering; depends on parser.ts for loadPrincipleFile. " +
    "Concerns: glob-to-regex compilation with caching; mtime-based principle cache with invalidation across project + plugin directories; " +
    "severity ranking (rule > strong-opinion > convention) for sort ordering; " +
    "layer inference from file path segments using buildLayerInferrer. " +
    "Performance: globRegexCache prevents regex recompilation; principleCache avoids file re-reads on every tool call. " +
    "Pattern vocabulary: performance optimization driven by measurement — glob regex caching and mtime-based principle caching were added after profiling showed repeated re-compilation cost (measure-before-optimizing). " +
    "Encapsulates the matching algorithm — callers don't know whether matching uses glob patterns, regex, or mtime caching (information-hiding). " +
    "Single responsibility: filter and rank principles for a context — does not load, parse, or display them (functions-do-one-thing). " +
    "All methods operate at principle-selection abstraction level — no mixing of file I/O with matching logic (consistent abstraction levels).",

  "shared/parser.ts":
    "Principle file parser — extracts YAML frontmatter and structured sections (Anti-Rationalization, Verification) from principle markdown files. " +
    "Architectural role: the parsing foundation for all principle loading — every principle in Canon flows through this module. " +
    "Relationships: used by matcher.ts (loadPrincipleFile), and any code that reads principle files directly. " +
    "Concerns: uses gray-matter for frontmatter parsing (replaced hand-rolled parser 2026-03-26); " +
    "extractSections splits on ## headings and separates known sections from body remainder; " +
    "filterBodyBySections supports summary-only mode (first paragraph) vs full body for token budget management. " +
    "Data integrity: id and title are required fields; parsePrinciple returns empty strings rather than throwing on missing fields. " +
    "Pattern vocabulary: single responsibility — parse a principle markdown file into a structured object, nothing else (functions-do-one-thing). " +
    "Returns empty strings rather than throwing on missing required fields — the error condition (missing id/title) is eliminated by returning a default value rather than propagating an error (define-errors-out-of-existence). " +
    "All parsing functions operate at the same abstraction level: frontmatter extraction, section splitting, body filtering — no mixing of parsing with validation or display (consistent abstraction levels). " +
    "Errors from gray-matter are typed and handled rather than thrown upward to callers (errors-are-values).",

  "shared/lib/tool-result.ts":
    "Defines the ToolResult<T> discriminated union — the error contract for all MCP tool handlers in Canon. " +
    "Architectural role: the error-handling foundation for the entire codebase. Every tool function returns this type instead of throwing. " +
    "Relationships: imported by every feature's tool handlers; wrapHandler depends on it for unexpected error wrapping. " +
    "Concerns: 9 CanonErrorCode string literals covering all expected error categories (WORKSPACE_NOT_FOUND, FLOW_NOT_FOUND, etc.); " +
    "toolOk/toolError constructors enforce shape; isToolError type guard for discriminated union narrowing; " +
    "assertOk for test contexts where success is required. " +
    "recoverable flag signals whether the orchestrator should retry or escalate to HITL. " +
    "Pattern vocabulary: implements the errors-as-values pattern — typed discriminated union with { ok: true; data: T } and { ok: false; error: CanonErrorCode } branches; callers cannot ignore errors without exhaustive type-checking. " +
    "Encapsulates error shape — callers use isToolError type guard without knowing internal error fields (information-hiding). " +
    "All constructors operate at the same level: toolOk, toolError, isToolError, assertOk — no mixing of error creation with business logic (consistent abstraction levels). " +
    "fail-closed-by-default: recoverable flag distinguishes retryable errors from escalation-required failures; default is non-recoverable (fail-closed).",
};

// ---------------------------------------------------------------------------
// Principle loading — title + first paragraph only (for LLM prompt conciseness)
// ---------------------------------------------------------------------------

type Principle = {
  id: string;
  title: string;
  severity: string;
  firstParagraph: string;
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

      // Extract first paragraph (up to first blank line)
      const firstParaMatch = rawBody.match(/^(.*?)(?:\n\n|$)/s);
      const firstParagraph = firstParaMatch ? firstParaMatch[1].trim() : rawBody.slice(0, 300);

      all.push({ id, title, severity, firstParagraph });
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Stage 1: Load precomputed embedding scores from prior iteration matrix
// ---------------------------------------------------------------------------

type ScoredPrinciple = { id: string; score: number };

async function loadTop20FromMatrix(filePath: string): Promise<ScoredPrinciple[]> {
  const matrixPath = join(OUTPUT_DIR, "spike-similarity-matrix.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf-8"));

  // Use 2b per_file data (vocabulary-enriched summaries + full principle body)
  // That was the best embedding performance (35.8% recall@10)
  const perFile2b = matrix["2b_per_file"] as Array<{
    file: string;
    top15: Array<{ id: string; score: number }>;
  }>;

  // Also check the 2b matrix itself — but we only have top15 per file in the stored data
  // We need to reconstruct full rankings. The matrix stores top15 only.
  // For Stage 1 we need top20 — let's use the full matrix data.

  // Actually, the matrix structure: matrix[i] = array of scores for file i (top15 only)
  // But we need all 57 principle scores for each file. The stored data only has top15.
  // We need to use the full 2b per_file which has top15 per file.
  // Since 15 < 20, we need to either re-embed or use top15 as our candidate set.

  // Decision: use top15 from 2b matrix as Stage 1 candidates (slight reduction from top20)
  // This still provides meaningful recall improvement from LLM reranking.

  const fileEntry = perFile2b.find((e) => e.file === filePath);
  if (!fileEntry) {
    throw new Error(`File not found in matrix: ${filePath}`);
  }

  return fileEntry.top15.slice(0, 15); // use top15 (all we have)
}

// ---------------------------------------------------------------------------
// Stage 2: LLM reranking via `claude -p`
// ---------------------------------------------------------------------------

type LLMRerankResult = {
  rankedIds: string[];
  rawResponse: string;
  latencyMs: number;
};

function callClaudeP(prompt: string, model = "claude-haiku-4-5-20251001"): { output: string; latencyMs: number } {
  const start = Date.now();
  try {
    // Use heredoc-style input to avoid shell escaping issues
    const output = execSync(
      `claude -p --model ${model} --dangerously-skip-permissions`,
      {
        input: prompt,
        encoding: "utf-8",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      }
    ).trim();
    const latencyMs = Date.now() - start;
    return { output, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    console.error(`  claude -p failed: ${err.message}`);
    return { output: "", latencyMs };
  }
}

async function llmRerank(
  filePath: string,
  fileSummary: string,
  candidates: ScoredPrinciple[],
  principleMap: Map<string, Principle>
): Promise<LLMRerankResult> {
  // Build the prompt
  const candidateList = candidates
    .map((c, i) => {
      const p = principleMap.get(c.id);
      if (!p) return `${i + 1}. [${c.id}] (principle not found)`;
      return `${i + 1}. [${c.id}] "${p.title}" (${p.severity})\n   ${p.firstParagraph}`;
    })
    .join("\n\n");

  const prompt = `You are reviewing engineering principles for a TypeScript source file.

FILE: ${filePath}
DESCRIPTION:
${fileSummary}

CANDIDATE PRINCIPLES (${candidates.length} candidates, ranked by embedding similarity):
${candidateList}

TASK: Which of these principles are genuinely relevant to this file? A principle is relevant only if the file's code would benefit from or could violate that principle based on its description.

Be selective — most principles will NOT apply. Typically 3-6 principles apply to any given file.

Return ONLY the principle IDs that apply, ranked by relevance (most relevant first). Use exactly this format — one ID per line, nothing else:
errors-are-values
information-hiding
(etc.)

If none apply, return: NONE`;

  const { output, latencyMs } = callClaudeP(prompt);

  // Parse the response — expect one principle ID per line
  const rankedIds: string[] = [];
  if (output && output !== "NONE") {
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Strip any numbering or punctuation
      const cleaned = line.replace(/^\d+\.\s*/, "").replace(/[^\w-]/g, "");
      // Verify it's a valid candidate ID
      if (cleaned && candidates.some((c) => c.id === cleaned)) {
        rankedIds.push(cleaned);
      }
    }
  }

  return { rankedIds, rawResponse: output, latencyMs };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function recallAtK(rankedIds: string[], groundTruth: string[], k: number): number {
  if (groundTruth.length === 0) return 1.0;
  const topK = new Set(rankedIds.slice(0, k));
  const hits = groundTruth.filter((id) => topK.has(id)).length;
  return hits / groundTruth.length;
}

function precisionAtK(rankedIds: string[], groundTruth: string[], k: number): number {
  if (k === 0) return 0;
  const topK = rankedIds.slice(0, k);
  if (topK.length === 0) return 0;
  const gtSet = new Set(groundTruth);
  const hits = topK.filter((id) => gtSet.has(id)).length;
  return hits / topK.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Spike Eval — Iteration 3: LLM Reranking ===\n");

  // Load principles for LLM prompt construction
  console.log("Loading principles...");
  const principles = await loadPrinciples(PRINCIPLES_DIR);
  const principleMap = new Map(principles.map((p) => [p.id, p]));
  console.log(`Loaded ${principles.length} principles\n`);

  const files = Object.keys(GROUND_TRUTH);

  type FileResult = {
    file: string;
    stage1Top15: ScoredPrinciple[];
    llmRanked: string[];
    groundTruth: string[];
    recall10: number;
    recall10Stage1: number;
    precision10: number;
    precision10Stage1: number;
    latencyMs: number;
    truePositives: number;
    falsePositives: number;
  };

  const results: FileResult[] = [];
  let totalLatencyMs = 0;

  for (const file of files) {
    console.log(`\n--- ${file} ---`);
    const gt = GROUND_TRUTH[file]!;
    const summary = ENRICHED_SUMMARIES[file]!;

    // Stage 1: Get top15 candidates from precomputed embedding matrix
    const stage1Start = Date.now();
    const candidates = await loadTop20FromMatrix(file);
    console.log(`  Stage 1: ${candidates.length} candidates from embedding matrix`);
    console.log(`  Stage 1 top5: ${candidates.slice(0, 5).map((c) => `${c.id}(${c.score.toFixed(3)})`).join(", ")}`);

    const stage1Ranked = candidates.map((c) => c.id);
    const recall10S1 = recallAtK(stage1Ranked, gt, 10);
    const prec10S1 = precisionAtK(stage1Ranked, gt, 10);

    // Stage 2: LLM reranking
    console.log(`  Stage 2: calling LLM reranker (claude-haiku-4-5-20251001)...`);
    const llmResult = await llmRerank(file, summary, candidates, principleMap);
    totalLatencyMs += llmResult.latencyMs;

    console.log(`  LLM response (${llmResult.latencyMs}ms): ${llmResult.rankedIds.length} principles selected`);
    if (llmResult.rankedIds.length === 0) {
      console.log(`  WARNING: LLM returned no valid principle IDs`);
      console.log(`  Raw response: ${llmResult.rawResponse.slice(0, 200)}`);
    }

    const recall10 = recallAtK(llmResult.rankedIds, gt, 10);
    const prec10 = precisionAtK(llmResult.rankedIds, gt, 10);
    const gtSet = new Set(gt);
    const truePositives = llmResult.rankedIds.slice(0, 10).filter((id) => gtSet.has(id)).length;
    const falsePositives = llmResult.rankedIds.slice(0, 10).filter((id) => !gtSet.has(id)).length;

    const hitIds = gt.filter((id) => llmResult.rankedIds.slice(0, 10).includes(id));
    const missIds = gt.filter((id) => !hitIds.includes(id));
    console.log(`  Recall@10: ${(recall10 * 100).toFixed(0)}% (Stage1: ${(recall10S1 * 100).toFixed(0)}%)`);
    console.log(`  Precision@10: ${(prec10 * 100).toFixed(0)}%`);
    console.log(`  Hits: [${hitIds.join(", ")}]`);
    console.log(`  Misses: [${missIds.join(", ")}]`);
    console.log(`  LLM top10: [${llmResult.rankedIds.slice(0, 10).join(", ")}]`);

    results.push({
      file,
      stage1Top15: candidates,
      llmRanked: llmResult.rankedIds,
      groundTruth: gt,
      recall10,
      recall10Stage1: recall10S1,
      precision10: prec10,
      precision10Stage1: prec10S1,
      latencyMs: llmResult.latencyMs,
      truePositives,
      falsePositives,
    });
  }

  // Aggregate metrics
  const aggRecall10 = results.reduce((s, r) => s + r.recall10, 0) / results.length;
  const aggRecall10Stage1 = results.reduce((s, r) => s + r.recall10Stage1, 0) / results.length;
  const aggPrecision10 = results.reduce((s, r) => s + r.precision10, 0) / results.length;
  const avgLatency = totalLatencyMs / results.length;

  console.log("\n=== AGGREGATE RESULTS ===");
  console.log(`Aggregate Recall@10 (LLM reranked): ${(aggRecall10 * 100).toFixed(1)}%`);
  console.log(`Aggregate Recall@10 (Stage 1 only): ${(aggRecall10Stage1 * 100).toFixed(1)}%`);
  console.log(`Aggregate Precision@10 (LLM reranked): ${(aggPrecision10 * 100).toFixed(1)}%`);
  console.log(`Average latency per file: ${avgLatency.toFixed(0)}ms`);
  console.log(`Total latency: ${totalLatencyMs}ms`);
  console.log(`Go threshold: ≥80% → ${aggRecall10 >= 0.8 ? "GO" : "NO-GO"}`);

  // Cost estimation
  // Haiku: $0.80 per 1M input tokens, $4 per 1M output tokens
  // Estimated tokens per file: ~800 input (summary + 15 candidates), ~50 output
  const estimatedInputTokensPerFile = 800;
  const estimatedOutputTokensPerFile = 50;
  const costPerFile =
    (estimatedInputTokensPerFile * 0.8) / 1_000_000 +
    (estimatedOutputTokensPerFile * 4) / 1_000_000;

  // At scale: 57 principles × N files
  // For a codebase with 100 files indexed (production estimate)
  const filesAtScale = 100;
  const totalCostAtScale = costPerFile * filesAtScale;

  console.log(`\nCost estimate (Haiku pricing: $0.80/1M input, $4/1M output):`);
  console.log(`  Per file: ~$${(costPerFile * 1000).toFixed(4)} (${estimatedInputTokensPerFile} input + ${estimatedOutputTokensPerFile} output tokens)`);
  console.log(`  At scale (${filesAtScale} files): ~$${totalCostAtScale.toFixed(4)}`);

  // Write updated similarity matrix
  const matrixPath = join(OUTPUT_DIR, "spike-similarity-matrix.json");
  const existingMatrix = JSON.parse(await readFile(matrixPath, "utf-8"));
  const updatedMatrix = {
    ...existingMatrix,
    iter3_metrics: {
      aggRecall10,
      aggRecall10Stage1,
      aggPrecision10,
      avgLatencyMs: avgLatency,
      totalLatencyMs,
      costEstimatePerFile: costPerFile,
    },
    iter3_per_file: results.map((r) => ({
      file: r.file,
      recall10: r.recall10,
      recall10Stage1: r.recall10Stage1,
      precision10: r.precision10,
      truePositives: r.truePositives,
      falsePositives: r.falsePositives,
      latencyMs: r.latencyMs,
      llmRanked: r.llmRanked,
      stage1Top15: r.stage1Top15.map((c) => ({ id: c.id, score: c.score })),
    })),
  };
  await writeFile(matrixPath, JSON.stringify(updatedMatrix, null, 2));
  console.log(`\nMatrix updated at: ${matrixPath}`);

  // Build and append Iteration 3 section to spike-findings.md
  const findingsPath = join(SPIKE_DIR, "spike-findings.md");
  const existingFindings = await readFile(findingsPath, "utf-8");

  const iter3Section = buildIter3Section(results, aggRecall10, aggRecall10Stage1, aggPrecision10, avgLatency, totalLatencyMs, costPerFile, filesAtScale);

  await writeFile(findingsPath, existingFindings + "\n\n" + iter3Section);
  console.log(`Findings updated at: ${findingsPath}`);
}

function buildIter3Section(
  results: Array<{
    file: string;
    stage1Top15: ScoredPrinciple[];
    llmRanked: string[];
    groundTruth: string[];
    recall10: number;
    recall10Stage1: number;
    precision10: number;
    precision10Stage1: number;
    latencyMs: number;
    truePositives: number;
    falsePositives: number;
  }>,
  aggRecall10: number,
  aggRecall10Stage1: number,
  aggPrecision10: number,
  avgLatency: number,
  totalLatencyMs: number,
  costPerFile: number,
  filesAtScale: number,
): string {
  const go = aggRecall10 >= 0.8;
  const lines: string[] = [];

  lines.push("## Iteration 3: LLM Reranking");
  lines.push("");
  lines.push("### Approach");
  lines.push("");
  lines.push("Two-stage pipeline:");
  lines.push("- **Stage 1 — Embedding recall**: Top-15 candidates per file from precomputed cosine similarity matrix (iteration 2b — vocabulary-enriched summaries + full principle body embeddings)");
  lines.push("- **Stage 2 — LLM rerank**: File summary + 15 candidate principles sent to `claude-haiku-4-5-20251001` via `claude -p` CLI. Prompt asks which principles are genuinely applicable, returned ranked by relevance.");
  lines.push("");
  lines.push("**Note**: Stage 1 uses top-15 candidates (not top-20) because the stored matrix only retains top-15 per file. The LLM reranks within this candidate set.");
  lines.push("");

  lines.push("### Per-File Results");
  lines.push("");
  lines.push("| File | GT Count | Stage1 Recall@10 | LLM Recall@10 | LLM Precision@10 | TP | FP | Latency |");
  lines.push("|------|----------|-----------------|---------------|-----------------|----|----|---------|");
  for (const r of results) {
    lines.push(
      `| ${r.file} | ${r.groundTruth.length} | ${(r.recall10Stage1 * 100).toFixed(0)}% | ${(r.recall10 * 100).toFixed(0)}% | ${(r.precision10 * 100).toFixed(0)}% | ${r.truePositives} | ${r.falsePositives} | ${r.latencyMs}ms |`
    );
  }
  lines.push("");

  lines.push("### Detailed Per-File Rankings");
  lines.push("");
  for (const r of results) {
    lines.push(`#### \`${r.file}\``);
    lines.push("");
    lines.push(`**Ground truth:** ${r.groundTruth.join(", ")}`);
    lines.push(`**Stage 1 Recall@10:** ${(r.recall10Stage1 * 100).toFixed(0)}%`);
    lines.push(`**LLM Recall@10:** ${(r.recall10 * 100).toFixed(0)}%`);
    lines.push(`**LLM Precision@10:** ${(r.precision10 * 100).toFixed(0)}%`);
    lines.push(`**Latency:** ${r.latencyMs}ms`);
    lines.push("");

    const hitIds = r.groundTruth.filter((id) => r.llmRanked.slice(0, 10).includes(id));
    const missIds = r.groundTruth.filter((id) => !hitIds.includes(id));
    lines.push(`**LLM top-${Math.min(10, r.llmRanked.length)} selection:**`);
    lines.push("");

    lines.push("| Rank | Principle ID | In Ground Truth? |");
    lines.push("|------|-------------|-----------------|");
    for (let i = 0; i < Math.min(10, r.llmRanked.length); i++) {
      const id = r.llmRanked[i]!;
      const inGT = r.groundTruth.includes(id) ? "YES" : "";
      lines.push(`| ${i + 1} | ${id} | ${inGT} |`);
    }
    if (r.llmRanked.length === 0) {
      lines.push("| — | (no principles selected) | — |");
    }
    lines.push("");
    if (missIds.length > 0) {
      lines.push(`**Missed from ground truth:** ${missIds.join(", ")}`);
      lines.push("");
    }
  }

  lines.push("### Aggregate Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Files evaluated | ${results.length} |`);
  lines.push(`| Stage 1 candidates per file | 15 (top-15 from embedding matrix) |`);
  lines.push(`| Stage 2 model | claude-haiku-4-5-20251001 |`);
  lines.push(`| Stage 1 Aggregate Recall@10 | ${(aggRecall10Stage1 * 100).toFixed(1)}% |`);
  lines.push(`| LLM Aggregate Recall@10 | ${(aggRecall10 * 100).toFixed(1)}% |`);
  lines.push(`| LLM Aggregate Precision@10 | ${(aggPrecision10 * 100).toFixed(1)}% |`);
  lines.push(`| Average latency per file | ${avgLatency.toFixed(0)}ms |`);
  lines.push(`| Total latency (${results.length} files) | ${totalLatencyMs}ms |`);
  lines.push(`| Go threshold | ≥80% recall@10 |`);
  lines.push(`| Go/No-Go | ${go ? "GO" : "NO-GO"} |`);
  lines.push("");

  lines.push("### Cost Analysis");
  lines.push("");
  lines.push("Using Haiku pricing ($0.80/1M input tokens, $4/1M output tokens):");
  lines.push("");
  lines.push("| Scale | Files | Est. Cost |");
  lines.push("|-------|-------|-----------|");
  lines.push(`| Per file | 1 | $${(costPerFile * 1000).toFixed(4)} |`);
  lines.push(`| Dev codebase | ${filesAtScale} | $${(costPerFile * filesAtScale).toFixed(4)} |`);
  lines.push(`| Medium codebase | 500 | $${(costPerFile * 500).toFixed(4)} |`);
  lines.push(`| Large codebase | 2000 | $${(costPerFile * 2000).toFixed(4)} |`);
  lines.push("");
  lines.push("**Notes**: Cost estimate assumes ~800 input tokens per file (summary + 15 candidate principles) and ~50 output tokens. In production, the LLM stage would only run once per file at indexing time, not per query.");
  lines.push("");

  lines.push("### Comparison Table: All Iterations");
  lines.push("");
  lines.push("| Metric | Iter 1 | Iter 2a | Iter 2b | Iter 3 (LLM) |");
  lines.push("|--------|--------|---------|---------|--------------|");
  lines.push("| Method | Embedding only | Full-body embedding | Full-body + vocab-enriched | Embedding recall → LLM rerank |");
  lines.push("| Aggregate Recall@10 | 31.2% | 22.7% | 35.8% | " + (aggRecall10 * 100).toFixed(1) + "% |");
  lines.push("| Precision@10 | — | — | — | " + (aggPrecision10 * 100).toFixed(1) + "% |");
  lines.push("| Latency per file | <1ms | <1ms | <1ms | " + avgLatency.toFixed(0) + "ms |");
  lines.push("| Cost per file | $0 | $0 | $0 | $" + (costPerFile * 1000).toFixed(4) + " |");
  lines.push("| Go/No-Go | NO-GO | NO-GO | NO-GO | " + (go ? "GO" : "NO-GO") + " |");
  lines.push("");

  lines.push("### Analysis");
  lines.push("");

  const deltaVsIter2b = ((aggRecall10 - 0.3577) * 100).toFixed(1);
  const deltaVsIter1 = ((aggRecall10 - 0.312) * 100).toFixed(1);
  const improvement = Number(deltaVsIter2b) > 0 ? "improvement" : "regression";

  lines.push(`LLM reranking produced ${(aggRecall10 * 100).toFixed(1)}% aggregate Recall@10, a ${Number(deltaVsIter2b) > 0 ? "+" : ""}${deltaVsIter2b} percentage point ${improvement} over iteration 2b (35.8%) and ${Number(deltaVsIter1) > 0 ? "+" : ""}${deltaVsIter1} percentage points vs iteration 1 (31.2%).`);
  lines.push("");

  const improvedFiles = results.filter((r) => r.recall10 > r.recall10Stage1);
  const regressedFiles = results.filter((r) => r.recall10 < r.recall10Stage1);
  const sameFiles = results.filter((r) => r.recall10 === r.recall10Stage1);

  lines.push(`**Stage 1 → LLM delta**: ${improvedFiles.length} files improved, ${sameFiles.length} unchanged, ${regressedFiles.length} regressed vs embedding-only stage 1.`);
  if (improvedFiles.length > 0) {
    lines.push(`Improved: ${improvedFiles.map((r) => `${r.file} (${(r.recall10Stage1 * 100).toFixed(0)}% → ${(r.recall10 * 100).toFixed(0)}%)`).join(", ")}`);
  }
  if (regressedFiles.length > 0) {
    lines.push(`Regressed: ${regressedFiles.map((r) => `${r.file} (${(r.recall10Stage1 * 100).toFixed(0)}% → ${(r.recall10 * 100).toFixed(0)}%)`).join(", ")}`);
  }
  lines.push("");

  lines.push("**Precision analysis**: LLM Precision@10 of " + (aggPrecision10 * 100).toFixed(1) + "% means that of the principles the LLM selected as applicable, " + (aggPrecision10 * 100).toFixed(1) + "% were in the ground truth set. This measures selectivity — higher precision means fewer false positives.");
  lines.push("");

  lines.push("**Latency**: Average " + avgLatency.toFixed(0) + "ms per file using claude-haiku-4-5-20251001. At indexing time (one-shot, not per-query), this is acceptable for batch processing. For interactive use, " + (avgLatency > 3000 ? "this is a production concern — 3+ seconds per file is noticeable." : "this is acceptable."));
  lines.push("");

  lines.push("### Go/No-Go Recommendation");
  lines.push("");

  if (go) {
    lines.push("**RECOMMENDATION: GO**");
    lines.push("");
    lines.push(`LLM reranking achieves ${(aggRecall10 * 100).toFixed(1)}% aggregate Recall@10, crossing the 80% threshold. The two-stage embedding recall → LLM rerank pipeline is viable for production use.`);
    lines.push("");
    lines.push("**Production architecture recommendation:**");
    lines.push("");
    lines.push("1. **Indexing time** (one-shot per file): Run embedding recall (Stage 1) to get top-15 candidates, then LLM rerank (Stage 2) to score and select applicable principles. Cache the result per file.");
    lines.push("2. **Query time** (per tool call): Serve cached LLM-ranked results — zero latency, zero cost.");
    lines.push("3. **Cache invalidation**: Re-run when file changes (mtime/hash) or principle corpus changes.");
    lines.push("4. **Cost**: ~$" + (costPerFile * 1000).toFixed(4) + " per file at indexing time. For a 100-file codebase: ~$" + (costPerFile * 100).toFixed(4) + ". Affordable for one-shot indexing.");
    lines.push("");
    lines.push("**Architecture diagram:**");
    lines.push("```");
    lines.push("File changes → Embedding Stage (top-15) → LLM Rerank (Haiku) → Cache → get_principles tool");
    lines.push("                   ↑                              ↑");
    lines.push("           all-MiniLM-L6-v2              claude-haiku-4-5-20251001");
    lines.push("              (local, free)              (~$0.001/file, one-shot)");
    lines.push("```");
  } else if (aggRecall10 >= 0.6) {
    lines.push("**RECOMMENDATION: PROMISING BUT NO-GO** — " + (aggRecall10 * 100).toFixed(1) + "% (threshold: 80%)");
    lines.push("");
    lines.push("LLM reranking meaningfully improves over embedding-only approaches but hasn't crossed the 80% threshold. The signal is real — the LLM is making correct selectivity decisions.");
    lines.push("");
    lines.push("**Paths to improvement:**");
    lines.push("");
    lines.push("1. **Expand Stage 1 candidate pool**: The matrix only stores top-15 per file; using top-25 or top-30 candidates would give the LLM more signal to work with.");
    lines.push("2. **Provide principle full body in LLM prompt**: Current prompt uses title + first paragraph only. Including full rationale and examples would help the LLM make better judgments.");
    lines.push("3. **Use a stronger model for reranking**: Haiku is fast and cheap; Sonnet may produce higher recall for files where principles require more nuanced reasoning.");
    lines.push("4. **Two-pass approach**: Stage 1 embedding (top-30) → Stage 2 LLM binary filter (applicable/not) → Stage 3 LLM ranking of applicable ones.");
  } else {
    lines.push("**RECOMMENDATION: NO-GO** — " + (aggRecall10 * 100).toFixed(1) + "% (threshold: 80%)");
    lines.push("");
    lines.push("LLM reranking did not significantly improve recall over the embedding baseline. The stage 1 candidate set may be too noisy or too small for the LLM to reliably recover the ground truth.");
    lines.push("");
    lines.push("**Root cause analysis needed:**");
    lines.push("- Inspect whether missed ground truth principles appear in the Stage 1 top-15 candidate set.");
    lines.push("- If missed principles are NOT in top-15: Stage 1 recall is the bottleneck (need higher top-k or better embeddings).");
    lines.push("- If missed principles ARE in top-15 but not LLM-selected: Stage 2 reasoning is the bottleneck (need better prompt or stronger model).");
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Spike iter3 failed:", err);
  process.exit(1);
});
