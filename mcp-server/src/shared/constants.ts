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

/** Canon data directory and file names. */
export const CANON_DIR = ".canon";
export const CANON_FILES = {
  CONFIG: "config.json",
  DRIFT_DB: "drift.db",
  KNOWLEDGE_DB: "knowledge-graph.db",
  ORCHESTRATION_DB: "orchestration.db",
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

/** Extract the first paragraph from a principle body as its summary. */
export function extractSummary(body: string): string {
  return body.split(/\n\n/)[0]?.trim() || body;
}
