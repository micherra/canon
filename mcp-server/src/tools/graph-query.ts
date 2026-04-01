import { existsSync } from 'fs';
import { join } from 'path';
import { KgQuery } from '../graph/kg-query.ts';
import { initDatabase } from '../graph/kg-schema.ts';
import { CANON_DIR, CANON_FILES } from '../constants.ts';
import type { SearchResult } from '../graph/kg-types.ts';
import { toolError, toolOk, type ToolResult } from '../utils/tool-result.ts';

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export type GraphQueryType = "callers" | "callees" | "blast_radius" | "dead_code" | "search" | "ancestors";

export interface GraphQueryOptions {
  max_depth?: number;
  limit?: number;
  include_tests?: boolean;
}

export interface GraphQueryInput {
  query_type: GraphQueryType;
  target?: string;
  options?: GraphQueryOptions;
}

export interface GraphQueryOutput {
  query_type: GraphQueryType;
  target?: string;
  results: unknown[];
  count: number;
}

// ---------------------------------------------------------------------------
// Helper — find entity ID via FTS5 search on the target string
// ---------------------------------------------------------------------------

function findEntityId(kq: KgQuery, target: string): number | null {
  const hits: SearchResult[] = kq.search(target, 1);
  if (hits.length === 0) return null;
  return hits[0].entity_id;
}

// ---------------------------------------------------------------------------
// graphQuery
// ---------------------------------------------------------------------------

/**
 * MCP tool handler for graph_query.
 *
 * Opens the SQLite knowledge-graph DB, resolves the target entity (when
 * required) via FTS5 search, then delegates to the appropriate KgQuery
 * method.
 *
 * Returns a structured result with typed rows and a total count.
 */
export function graphQuery(
  input: GraphQueryInput,
  projectDir: string
): ToolResult<GraphQueryOutput> {
  const { query_type, target, options = {} } = input;

  // ------------------------------------------------------------------
  // 1. Locate the DB — if absent, return a recoverable error
  // ------------------------------------------------------------------
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) {
    return toolError(
      "KG_NOT_INDEXED",
      `Knowledge graph database not found at "${dbPath}". Run the codebase_graph tool first to index your codebase.`,
      true, // recoverable
    );
  }

  // ------------------------------------------------------------------
  // 2. Open DB (read-only mode) and create the query helper
  // ------------------------------------------------------------------
  const db = initDatabase(dbPath);
  const kq = new KgQuery(db);

  try {
    // ----------------------------------------------------------------
    // 3. Dispatch by query_type
    // ----------------------------------------------------------------
    switch (query_type) {
      case "search": {
        if (!target) {
          return toolError("INVALID_INPUT", `query_type "search" requires a target string.`);
        }
        const limit = options.limit ?? 50;
        const results = kq.search(target, limit);
        return toolOk({ query_type, target, results, count: results.length });
      }

      case "dead_code": {
        const results = kq.findDeadCode({
          includeTests: options.include_tests ?? false,
        });
        return toolOk({ query_type, target, results, count: results.length });
      }

      case "callers": {
        if (!target) {
          return toolError("INVALID_INPUT", `query_type "callers" requires a target entity name.`);
        }
        const entityId = findEntityId(kq, target);
        if (entityId === null) {
          return toolOk({ query_type, target, results: [], count: 0 });
        }
        const results = kq.getCallers(entityId);
        return toolOk({ query_type, target, results, count: results.length });
      }

      case "callees": {
        if (!target) {
          return toolError("INVALID_INPUT", `query_type "callees" requires a target entity name.`);
        }
        const entityId = findEntityId(kq, target);
        if (entityId === null) {
          return toolOk({ query_type, target, results: [], count: 0 });
        }
        const results = kq.getCallees(entityId);
        return toolOk({ query_type, target, results, count: results.length });
      }

      case "blast_radius": {
        if (!target) {
          return toolError("INVALID_INPUT", `query_type "blast_radius" requires a target entity name.`);
        }
        const entityId = findEntityId(kq, target);
        if (entityId === null) {
          return toolOk({ query_type, target, results: [], count: 0 });
        }
        const maxDepth = options.max_depth ?? 3;
        const results = kq.getBlastRadius([entityId], maxDepth);
        return toolOk({ query_type, target, results, count: results.length });
      }

      case "ancestors": {
        if (!target) {
          return toolError("INVALID_INPUT", `query_type "ancestors" requires a target entity name.`);
        }
        const entityId = findEntityId(kq, target);
        if (entityId === null) {
          return toolOk({ query_type, target, results: [], count: 0 });
        }
        const results = kq.getAncestors(entityId);
        return toolOk({ query_type, target, results, count: results.length });
      }

      default: {
        // TypeScript exhaustiveness guard — this is a bug, not an expected error
        const exhaustive: never = query_type;
        throw new Error(`Unknown query_type: ${String(exhaustive)}`);
      }
    }
  } finally {
    db.close();
  }
}
