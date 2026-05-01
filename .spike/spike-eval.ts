/**
 * Spike Eval — Semantic Principle Matching via EmbeddingService
 *
 * Runs Part 2 of the spike: loads all Canon principles, embeds them alongside
 * enriched file summaries, computes cosine similarity, and evaluates recall@10.
 *
 * Usage: npx tsx spike-eval.ts
 * Run from: mcp-server/ directory (so @shared/* aliases resolve via tsconfig)
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

// The worktree is the project root (canon/)
const WORKTREE = join(import.meta.dirname, "../../../../worktree");
const PRINCIPLES_DIR = join(WORKTREE, "principles");
const OUTPUT_DIR = import.meta.dirname;

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
// Principle loading (inline, no @shared alias)
// ---------------------------------------------------------------------------

type Principle = {
  id: string;
  title: string;
  severity: string;
  body: string;
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

      // Get body (first para)
      const firstPara = rawBody.split(/\n\n/)[0]?.trim() ?? rawBody;

      all.push({ id, title, severity, body: firstPara, anti_rationalization: antiRat });
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
  // Vectors are pre-normalized → dot product = cosine similarity
  return dot;
}

// ---------------------------------------------------------------------------
// Enriched file summaries (Part 1) — hand-authored based on reading each file
// ---------------------------------------------------------------------------

type FileSummary = {
  path: string; // relative to mcp-server/src/
  summary: string;
};

const ENRICHED_SUMMARIES: FileSummary[] = [
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
// Ground truth — 3-5 principles per file that SHOULD apply
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
// Compose principle embedding text
// ---------------------------------------------------------------------------

function composePrincipleText(p: Principle): string {
  // title + first paragraph of body + anti_rationalization (first 300 chars)
  const parts = [`${p.title} (${p.severity})`];
  parts.push(p.body);
  if (p.anti_rationalization) {
    // Just first 300 chars of anti-rationalization to keep it focused
    parts.push(p.anti_rationalization.slice(0, 300));
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function recall_at_k(
  rankedPrinciples: string[], // ordered by similarity desc
  groundTruth: string[],
  k: number,
): number {
  if (groundTruth.length === 0) return 1.0;
  const topK = new Set(rankedPrinciples.slice(0, k));
  const hits = groundTruth.filter((id) => topK.has(id)).length;
  return hits / groundTruth.length;
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

  // Compose embedding texts
  const principleTexts = principles.map(composePrincipleText);
  const fileTexts = ENRICHED_SUMMARIES.map((f) => f.summary);

  console.log(`Embedding ${principles.length} principles...`);
  const principleEmbeddings = await svc.embed(principleTexts);
  console.log(`Embedding ${ENRICHED_SUMMARIES.length} file summaries...`);
  const fileEmbeddings = await svc.embed(fileTexts);

  // Build similarity matrix: matrix[i][j] = sim(file[i], principle[j])
  const matrix: number[][] = [];
  for (let i = 0; i < fileEmbeddings.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < principleEmbeddings.length; j++) {
      row.push(cosineSim(fileEmbeddings[i]!, principleEmbeddings[j]!));
    }
    matrix.push(row);
  }

  // For each file, rank principles by similarity
  type FileResult = {
    file: string;
    ranked: Array<{ id: string; score: number }>;
    groundTruth: string[];
    recall10: number;
    topScore: number;
    medianScore: number;
    gap: number;
  };

  const fileResults: FileResult[] = [];

  for (let i = 0; i < ENRICHED_SUMMARIES.length; i++) {
    const file = ENRICHED_SUMMARIES[i]!;
    const scores = matrix[i]!.map((score, j) => ({
      id: principles[j]!.id,
      score,
    }));
    scores.sort((a, b) => b.score - a.score);

    const gt = GROUND_TRUTH[file.path] ?? [];
    const r10 = recall_at_k(
      scores.map((s) => s.id),
      gt,
      10,
    );

    const topScore = scores[0]?.score ?? 0;
    const medianScore = scores[Math.floor(scores.length / 2)]?.score ?? 0;
    const gap = topScore - medianScore;

    fileResults.push({
      file: file.path,
      ranked: scores.slice(0, 15), // top 15 for output
      groundTruth: gt,
      recall10: r10,
      topScore,
      medianScore,
      gap,
    });
  }

  // Aggregate recall@10
  const aggRecall10 =
    fileResults.reduce((sum, r) => sum + r.recall10, 0) / fileResults.length;
  const avgGap = fileResults.reduce((sum, r) => sum + r.gap, 0) / fileResults.length;

  // Print summary
  console.log("\n=== RESULTS ===");
  console.log(`Aggregate Recall@10: ${(aggRecall10 * 100).toFixed(1)}%`);
  console.log(`Average discrimination gap: ${avgGap.toFixed(4)}`);
  console.log(`Go threshold: 80% recall@10 → ${aggRecall10 >= 0.8 ? "GO" : "NO-GO"}`);

  for (const r of fileResults) {
    const hitIds = r.groundTruth.filter((id) =>
      r.ranked
        .slice(0, 10)
        .map((x) => x.id)
        .includes(id),
    );
    const missIds = r.groundTruth.filter((id) => !hitIds.includes(id));
    console.log(`\n${r.file}`);
    console.log(`  Recall@10: ${(r.recall10 * 100).toFixed(0)}% (hits: ${hitIds.join(", ") || "none"}, misses: ${missIds.join(", ") || "none"})`);
    console.log(`  Top sim: ${r.topScore.toFixed(4)}, Median: ${r.medianScore.toFixed(4)}, Gap: ${r.gap.toFixed(4)}`);
    console.log(`  Top 5: ${r.ranked.slice(0, 5).map((x) => `${x.id}(${x.score.toFixed(3)})`).join(", ")}`);
  }

  // Write outputs
  const matrixOutput = {
    files: ENRICHED_SUMMARIES.map((f) => f.path),
    principles: principles.map((p) => p.id),
    matrix,
    ground_truth: GROUND_TRUTH,
  };

  const { writeFile: fsWriteFile } = await import("node:fs/promises");
  const matrixPath = join(OUTPUT_DIR, "spike-similarity-matrix.json");
  await fsWriteFile(matrixPath, JSON.stringify(matrixOutput, null, 2));
  console.log(`\nMatrix written to: ${matrixPath}`);

  // Write findings markdown
  const findingsPath = join(OUTPUT_DIR, "spike-findings.md");
  await fsWriteFile(findingsPath, buildFindings(fileResults, aggRecall10, avgGap, principles));
  console.log(`Findings written to: ${findingsPath}`);
}

function buildFindings(
  fileResults: any[],
  aggRecall10: number,
  avgGap: number,
  principles: Principle[],
): string {
  const go = aggRecall10 >= 0.8;
  const lines: string[] = [];

  lines.push("# Spike Findings: Semantic Principle Matching Evaluation");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(
    `**Aggregate Recall@10: ${(aggRecall10 * 100).toFixed(1)}%**  `,
  );
  lines.push(
    `**Average discrimination gap (top vs median): ${avgGap.toFixed(4)}**  `,
  );
  lines.push(
    `**Go threshold: ≥80% → ${go ? "GO" : "NO-GO"}**`,
  );
  lines.push("");

  lines.push("## Sample File Selection Rationale");
  lines.push("");
  lines.push(
    "13 files selected across architectural layers to cover diverse concern profiles:",
  );
  lines.push(
    "- **Graph infrastructure** (4 files): kg-embedding, kg-store, kg-pipeline, kg-query, kg-vector-store — tests whether embedding can distinguish data-layer concerns (information-hiding, command-query-separation) from reliability concerns (handle-partial-failure, errors-are-values)",
  );
  lines.push(
    "- **Orchestration tools** (3 files): drive-flow, report-result, init-workspace — tests whether boundary/security concerns (validate-at-trust-boundaries, fail-closed-by-default) surface for tool handlers at the MCP boundary",
  );
  lines.push(
    "- **Shared kernel** (3 files): matcher, parser, tool-result — tests whether cross-cutting utility concerns distinguish from domain-specific ones",
  );
  lines.push(
    "- **Feature tools** (2 files): get-principles, get-file-context — tests mixed concern profiles (validation + information-hiding + error handling)",
  );
  lines.push("");

  lines.push("## Enriched Summaries");
  lines.push("");
  lines.push(
    "_Summaries capture Role (architectural function), Relationships (dependency position), and Concerns (engineering concerns) for each file._",
  );
  lines.push("");

  const ENRICHED_SUMMARIES_INLINE = [
    { path: "graph/kg-embedding.ts" },
    { path: "graph/kg-store.ts" },
    { path: "graph/kg-pipeline.ts" },
    { path: "graph/kg-query.ts" },
    { path: "graph/kg-vector-store.ts" },
    { path: "features/orchestration/tools/drive-flow.ts" },
    { path: "features/orchestration/tools/report-result.ts" },
    { path: "features/orchestration/tools/init-workspace.ts" },
    { path: "features/principles/tools/get-principles.ts" },
    { path: "features/file-context/tools/get-file-context.ts" },
    { path: "shared/matcher.ts" },
    { path: "shared/parser.ts" },
    { path: "shared/lib/tool-result.ts" },
  ];

  for (const f of ENRICHED_SUMMARIES_INLINE) {
    lines.push(`### \`${f.path}\``);
    lines.push("");
    // Summary text is in fileResults — look it up
    const result = fileResults.find((r) => r.file === f.path);
    if (result) {
      lines.push(`Ground truth principles: ${result.groundTruth.join(", ")}`);
    }
    lines.push("");
  }

  lines.push("## Per-File Similarity Rankings");
  lines.push("");

  for (const r of fileResults) {
    lines.push(`### \`${r.file}\``);
    lines.push("");
    lines.push(`**Ground truth:** ${r.groundTruth.join(", ")}`);
    lines.push(`**Recall@10:** ${(r.recall10 * 100).toFixed(0)}%`);
    lines.push(`**Top similarity:** ${r.topScore.toFixed(4)} | **Median:** ${r.medianScore.toFixed(4)} | **Gap:** ${r.gap.toFixed(4)}`);
    lines.push("");
    lines.push("| Rank | Principle ID | Score | In Ground Truth? |");
    lines.push("|------|-------------|-------|-----------------|");
    for (let rank = 0; rank < Math.min(10, r.ranked.length); rank++) {
      const entry = r.ranked[rank];
      const inGT = r.groundTruth.includes(entry.id) ? "YES" : "";
      lines.push(`| ${rank + 1} | ${entry.id} | ${entry.score.toFixed(4)} | ${inGT} |`);
    }
    lines.push("");
  }

  lines.push("## Aggregate Metrics");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Files evaluated | ${fileResults.length} |`);
  lines.push(`| Principles in corpus | ${principles.length} |`);
  lines.push(`| Aggregate Recall@10 | ${(aggRecall10 * 100).toFixed(1)}% |`);
  lines.push(`| Average discrimination gap | ${avgGap.toFixed(4)} |`);
  lines.push(`| Per-file recall@10 range | ${(Math.min(...fileResults.map((r) => r.recall10)) * 100).toFixed(0)}% – ${(Math.max(...fileResults.map((r) => r.recall10)) * 100).toFixed(0)}% |`);
  lines.push("");

  lines.push("## Discrimination Analysis");
  lines.push("");
  lines.push(
    "Discrimination measures the cosine similarity gap between the top-ranked (most applicable) principle and the median-ranked (non-applicable) principle. " +
    "A large gap means the model clearly separates relevant from irrelevant principles. A small gap means principles cluster together and the ranking is essentially noise.",
  );
  lines.push("");
  lines.push("| File | Top Score | Median Score | Gap |");
  lines.push("|------|-----------|-------------|-----|");
  for (const r of fileResults) {
    lines.push(`| ${r.file} | ${r.topScore.toFixed(4)} | ${r.medianScore.toFixed(4)} | ${r.gap.toFixed(4)} |`);
  }
  lines.push("");

  lines.push("## Go/No-Go Recommendation");
  lines.push("");
  if (go) {
    lines.push(
      `**RECOMMENDATION: GO**`,
    );
    lines.push("");
    lines.push(
      `Aggregate Recall@10 of ${(aggRecall10 * 100).toFixed(1)}% exceeds the 80% threshold. ` +
      `The 384-dim all-MiniLM-L6-v2 embeddings show sufficient discrimination to match principles to files via semantic similarity. ` +
      `The average discrimination gap of ${avgGap.toFixed(4)} indicates meaningful separation between applicable and non-applicable principles.`,
    );
  } else {
    lines.push(
      `**RECOMMENDATION: NO-GO**`,
    );
    lines.push("");
    lines.push(
      `Aggregate Recall@10 of ${(aggRecall10 * 100).toFixed(1)}% falls below the 80% threshold. ` +
      `The embeddings do not discriminate well enough to reliably match principles to files. ` +
      `Consider: (1) richer principle embedding text (include full body + examples), ` +
      `(2) larger embedding model, or (3) hybrid lexical+semantic matching.`,
    );
  }
  lines.push("");
  lines.push(
    "### Limitations of this evaluation",
  );
  lines.push("");
  lines.push(
    "- Ground truth was manually assigned by reading file code — may not capture all applicable principles\n" +
    "- Enriched summaries were hand-authored, not generated by an AI from code — production would use LLM-generated summaries\n" +
    "- Canon has 54 principles; real files may have more ground-truth matches than the 3-5 assigned here\n" +
    "- Principle corpus is small (54 items) — similarity scores cluster when the corpus is this compact\n" +
    "- The model was not fine-tuned on engineering principle text — recall may improve with domain adaptation",
  );

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Spike failed:", err);
  process.exit(1);
});
