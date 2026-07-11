/** Shared constants — single source of truth for values used across modules. */

/** Layer centrality weights for impact scoring. Higher = more central to architecture. */
export const LAYER_CENTRALITY: Record<string, number> = {
  api: 1,
  data: 1.5,
  domain: 2,
  infra: 1,
  shared: 3,
  ui: 0.5,
  unknown: 0,
};

/** Extensions with import/export parsers (JS/TS and Python). */
export const JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
export const PY_EXTENSIONS = new Set(["py"]);

/** All extensions to scan for (includes Go/Rust which are scanned but lack import parsers). */
export const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".md",
  ".yaml",
  ".yml",
  ".json",
  ".sh",
]);

/** Extensions to try when resolving imports (e.g., `./foo` → `./foo.ts`). */
export const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"];

/** Meta-table key for the commit SHA the knowledge graph was last built at. */
export const GRAPH_HEAD_COMMIT_KEY = "graph_head_commit";

/** Meta-table key for the content-hash of the doc corpus (not git HEAD). */
export const DOC_CORPUS_HASH_KEY = "doc_corpus_hash";

/**
 * Meta-table key for the content-hash of the context graph (decisions/ADRs).
 * Content-hash, not git-HEAD — decisions mutate without git commits (DEC-M2-02).
 */
export const CONTEXT_GRAPH_HASH_KEY = "context_graph_hash";

/** Maximum characters per doc chunk (heading-section chunker). */
export const DOC_CORPUS_MAX_CHUNK_CHARS = 1200;

/**
 * Descriptor for one source corpus of markdown documents.
 * `root` is an absolute path; relative roots must be resolved against projectDir
 * before passing to ingestDocCorpus.
 */
export type DocCorpusSource = {
  /** Logical name for the corpus (stored as `corpus` column in doc_chunks). */
  corpus: string;
  /** Absolute path to the root directory to scan for *.md files. */
  root: string;
  /** Trust tier applied to all chunks from this source. */
  trust_tier: "internal" | "external";
  /** When true, a missing root directory is silently skipped. */
  optional: boolean;
};

/**
 * Default doc corpus sources for a Canon project.
 * Roots are relative to projectDir — callers must resolve them before use.
 * The `.canon-principles` and `.canon-proposed-learnings` corpora are resolved
 * to `.canon/principles/` and `.canon/proposed-learnings/` respectively by
 * `resolveDefaultSources` in search-knowledge.ts.
 */
export const DEFAULT_DOC_CORPUS_SOURCES: Omit<DocCorpusSource, "root">[] = [
  { corpus: "principles", optional: false, trust_tier: "internal" },
  { corpus: "references", optional: false, trust_tier: "internal" },
  { corpus: "agents", optional: false, trust_tier: "internal" },
  { corpus: "primers", optional: false, trust_tier: "internal" },
  { corpus: "digest", optional: true, trust_tier: "internal" },
  { corpus: ".canon-principles", optional: true, trust_tier: "internal" },
  { corpus: ".canon-proposed-learnings", optional: true, trust_tier: "internal" },
] as const;

/** Canon data directory and file names. */
export const CANON_DIR = ".canon";
export const CANON_FILES = {
  CONFIG: "config.json",
  DRIFT_DB: "drift.db",
  HISTORY_DIR: "history",
  JANITOR_LASTRUN: "janitor.lastrun",
  KNOWLEDGE_DB: "knowledge-graph.db",
  ORCHESTRATION_DB: "orchestration.db",
  PRINCIPLE_OVERRIDES: "principle-overrides.yaml",
} as const;

/** Maximum lines of file content returned by get_file_context. */
export const FILE_PREVIEW_MAX_LINES = 200;

/** Embedding model configuration */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;
export const EMBEDDING_BATCH_SIZE = 64;
export const EMBEDDING_MODEL_ID = "all-MiniLM-L6-v2"; // short ID for meta tables

/** Default timeout for background jobs (5 minutes). */
export const JOB_TIMEOUT_MS = 300_000;

/**
 * Reserved pseudo-principle_id used by Stage 1.5 correctness-scan findings.
 * These are advisory human-facing annotations, not Canon principle violations.
 * They must NEVER be counted in principle-keyed analytics (drift, area memory,
 * most_violated, violation_directories) but ARE stored and shown to humans.
 */
export const CORRECTNESS_SCAN_PRINCIPLE_ID = "correctness-scan";

/** Extract the first paragraph from a principle body as its summary. */
export function extractSummary(body: string): string {
  return body.split(/\n\n/)[0]?.trim() || body;
}

/** Known principle section headings for structured extraction. */
export const PRINCIPLE_SECTIONS = {
  ANTI_RATIONALIZATION: "Anti-Rationalization",
  VERIFICATION: "Verification",
} as const;
