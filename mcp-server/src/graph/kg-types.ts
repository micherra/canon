/**
 * Knowledge Graph Type Definitions
 *
 * Pure type definitions for the codebase knowledge graph system.
 * No runtime code — all exports are TypeScript types and interfaces.
 */

// ---------------------------------------------------------------------------
// Entity and Edge Kind Unions
// ---------------------------------------------------------------------------

export type EntityKind =
  | "file"
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type-alias"
  | "enum"
  | "variable"
  | "property"
  | "principle"
  | "flow"
  | "flow-fragment"
  | "agent"
  | "template"
  | "decision"
  | "hook";

export type EdgeType =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "type-references"
  | "contains"
  | "re-exports"
  | "composition"
  | "fm:references"
  | "doc:references"
  | "applies-to"
  | "includes"
  | "spawns"
  | "tests";

// ---------------------------------------------------------------------------
// SQLite Row Interfaces
// ---------------------------------------------------------------------------

/** Matches the `files` table. `file_id` is undefined before DB insert. */
export interface FileRow {
  file_id?: number;
  path: string;
  mtime_ms: number;
  content_hash: string;
  language: string;
  layer: string;
  last_indexed_at: number;
}

/** Matches the `entities` table. `entity_id` is undefined before DB insert. */
export interface EntityRow {
  entity_id?: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: EntityKind;
  line_start: number;
  line_end: number;
  is_exported: boolean;
  is_default_export: boolean;
  /** Function/method/class signature string, nullable */
  signature: string | null;
  /** JSON-serialized metadata blob */
  metadata: string | null;
}

/** Matches the `edges` table. `edge_id` is undefined before DB insert. */
export interface EdgeRow {
  edge_id?: number;
  source_entity_id: number;
  target_entity_id: number;
  edge_type: EdgeType;
  /** Confidence in [0, 1]; defaults to 1.0 when certain */
  confidence: number;
  /** JSON-serialized metadata blob */
  metadata: string | null;
}

/** Matches the `file_edges` table. `file_edge_id` is undefined before DB insert. */
export interface FileEdgeRow {
  file_edge_id?: number;
  source_file_id: number;
  target_file_id: number;
  edge_type: EdgeType;
  /** Confidence in [0, 1] */
  confidence: number;
  /** Raw import specifier or other textual evidence */
  evidence: string | null;
  /** Human-readable relation label */
  relation: string | null;
}

// ---------------------------------------------------------------------------
// Ingestion Pipeline — Adapter Interface
// ---------------------------------------------------------------------------

/** Intra-file edge before entity IDs are resolved */
export interface IntraFileEdge {
  source_qualified: string;
  target_qualified: string;
  edge_type: EdgeType;
  confidence?: number;
}

/** Import specifier with the names it brings into scope */
export interface ImportSpecifier {
  specifier: string;
  names: string[];
}

/**
 * Result returned by a LanguageAdapter after parsing a single file.
 * `entity_id` and `file_id` are omitted because they are assigned by the
 * ingestion layer after database insertion.
 */
export interface AdapterResult {
  entities: Omit<EntityRow, "entity_id" | "file_id">[];
  intraFileEdges: IntraFileEdge[];
  importSpecifiers: ImportSpecifier[];
}

/** Pluggable per-language file parser */
export interface LanguageAdapter {
  /** File extensions this adapter handles (e.g. ['.ts', '.tsx']) */
  extensions: string[];
  parse(filePath: string, content: string): AdapterResult;
}

// ---------------------------------------------------------------------------
// Query Result Types
// ---------------------------------------------------------------------------

/** Result row for caller/callee queries */
export interface CallerResult {
  entity_id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: EntityKind;
  edge_type: EdgeType;
  confidence: number;
}

/** Result row for blast-radius recursive CTE queries */
export interface BlastRadiusResult {
  entity_id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: EntityKind;
  /** Distance from the root entity in the dependency graph */
  depth: number;
}

/** Result row for full-text search (FTS5) queries */
export interface SearchResult {
  entity_id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: EntityKind;
  /** BM25 rank score from FTS5 (lower is better) */
  rank: number;
  snippet: string | null;
}

/** Result row for dead-code detection queries */
export interface DeadCodeResult {
  entity_id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: EntityKind;
  /** True when the entity has no incoming edges */
  is_unreferenced: boolean;
}

/** Result row for file-level blast-radius recursive CTE queries */
export interface FileBlastRadiusResult {
  file_id: number;
  path: string;
  layer: string;
  language: string;
  depth: number;
}

// ---------------------------------------------------------------------------
// File Metrics Types
// ---------------------------------------------------------------------------

/**
 * A layer violation where a file imports from a layer it is not allowed to
 * depend on per the clean-architecture layer rules.
 */
export interface LayerViolation {
  target: string;
  source_layer: string;
  target_layer: string;
}

/**
 * Full structural metrics for a single file, computed from SQL aggregates
 * over file_edges and enriched with hub/cycle/violation data.
 */
export interface FileMetrics {
  in_degree: number;
  out_degree: number;
  is_hub: boolean;
  in_cycle: boolean;
  cycle_peers: string[];
  layer: string;
  layer_violation_count: number;
  layer_violations: LayerViolation[];
  impact_score: number;
}

/** Matches the `summaries` table. `summary_id` is undefined before DB insert. */
export interface SummaryRow {
  summary_id?: number;
  file_id: number;
  entity_id: number | null;
  scope: "file" | "entity";
  summary: string;
  model: string | null;
  content_hash: string | null;
  updated_at: string;
}

/** Matches the entity_vector_meta / summary_vector_meta tables */
export interface VectorMetaRow {
  entity_id?: number; // or summary_id for summary vectors
  summary_id?: number;
  text_hash: string;
  model_id: string;
  updated_at: string;
}

/** Result from semantic search across vector tables */
export interface SemanticSearchResult {
  entity_id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: EntityKind;
  distance: number;
  source: "entity" | "summary";
  summary?: string;
  file_path?: string;
}
