import { existsSync } from "node:fs";
import { join } from "node:path";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { FileTagRow, SearchResult } from "@graph/kg-types.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

// Input / Output types

export type GraphQueryType =
  | "callers"
  | "callees"
  | "blast_radius"
  | "dead_code"
  | "search"
  | "context_for_file"
  | "supersedes_chain";

export type GraphQueryOptions = {
  max_depth?: number;
  limit?: number;
  include_tests?: boolean;
  min_confidence?: number;
};

export type GraphQueryInput = {
  query_type: GraphQueryType;
  target?: string;
  options?: GraphQueryOptions;
};

export type GraphQueryOutput = {
  query_type: GraphQueryType;
  target?: string;
  results: unknown[];
  count: number;
};

// Helper — find entity ID via FTS5 search on the target string

function findEntityId(kq: KgQuery, target: string): number | null {
  const hits: SearchResult[] = kq.search(target, 1);
  if (hits.length === 0) return null;
  return hits[0].entity_id;
}

// graphQuery

/**
 * MCP tool handler for graph_query.
 *
 * Opens the SQLite knowledge-graph DB, resolves the target entity (when
 * required) via FTS5 search, then delegates to the appropriate KgQuery
 * method.
 *
 * Returns a structured result with typed rows and a total count.
 */
/** Require a target string, returning an error result if absent. */
function requireTarget(
  queryType: GraphQueryType,
  target: string | undefined,
): ToolResult<GraphQueryOutput> | string {
  if (!target) {
    return toolError("INVALID_INPUT", `query_type "${queryType}" requires a target entity name.`);
  }
  return target;
}

/** Execute an entity-based query (callers, callees, blast_radius). */
function entityQuery(
  kq: KgQuery,
  queryType: GraphQueryType,
  target: string,
  queryFn: (entityId: number) => unknown[],
): ToolResult<GraphQueryOutput> {
  const entityId = findEntityId(kq, target);
  if (entityId === null) {
    return toolOk({ count: 0, query_type: queryType, results: [], target });
  }
  const results = queryFn(entityId);
  return toolOk({ count: results.length, query_type: queryType, results, target });
}

/** Dispatch search query. */
function dispatchSearch(
  kq: KgQuery,
  target: string | undefined,
  options: Record<string, unknown>,
): ToolResult<GraphQueryOutput> {
  const t = requireTarget("search", target);
  if (typeof t !== "string") return t;
  const limit = (options.limit as number | undefined) ?? 50;
  const minConfidence = options.min_confidence as number | undefined;
  const rawResults = kq.search(t, limit);

  const fileIds = rawResults.map((r) => r.file_id);
  const tagsByFileId = kq.getFileTagsByFileIds(fileIds);

  const results = rawResults.map((r) => {
    const tags = tagsByFileId.get(r.file_id) ?? [];
    const filtered =
      minConfidence != null
        ? tags.filter((tag: FileTagRow) => tag.confidence >= minConfidence)
        : tags;
    return {
      ...r,
      computed_tags: filtered.map((tag: FileTagRow) => tag.tag),
    };
  });

  return toolOk({ count: results.length, query_type: "search", results, target });
}

/** Dispatch entity-based queries (callers, callees, blast_radius). */
function dispatchEntityQuery(
  kq: KgQuery,
  query_type: "callers" | "callees" | "blast_radius",
  target: string | undefined,
  options: Record<string, unknown>,
): ToolResult<GraphQueryOutput> {
  const t = requireTarget(query_type, target);
  if (typeof t !== "string") return t;

  const queryFns: Record<string, (id: number) => unknown[]> = {
    blast_radius: (id) => kq.getBlastRadius([id], (options.max_depth as number | undefined) ?? 3),
    callees: (id) => kq.getCallees(id),
    callers: (id) => kq.getCallers(id),
  };
  return entityQuery(kq, query_type, t, queryFns[query_type]);
}

/** Dispatch a context-graph traversal (context_for_file, supersedes_chain). */
function dispatchContextQuery(
  query_type: "context_for_file" | "supersedes_chain",
  target: string | undefined,
  queryFn: (id: string) => unknown[],
): ToolResult<GraphQueryOutput> {
  const t = requireTarget(query_type, target);
  if (typeof t !== "string") return t;
  const results = queryFn(t);
  return toolOk({ count: results.length, query_type, results, target: t });
}

/** Dispatch the query based on type. */
function dispatchQuery(
  kq: KgQuery,
  query_type: GraphQueryType,
  target: string | undefined,
  options: Record<string, unknown>,
): ToolResult<GraphQueryOutput> {
  switch (query_type) {
    case "search":
      return dispatchSearch(kq, target, options);
    case "dead_code": {
      const results = kq.findDeadCode({
        includeTests: (options.include_tests as boolean | undefined) ?? false,
      });
      return toolOk({ count: results.length, query_type, results, target });
    }
    case "callers":
    case "callees":
    case "blast_radius":
      return dispatchEntityQuery(kq, query_type, target, options);
    case "context_for_file":
      return dispatchContextQuery(query_type, target, (path) => kq.getContextForFile(path));
    case "supersedes_chain":
      return dispatchContextQuery(query_type, target, (adrId) => kq.getSupersedesChain(adrId));
    default: {
      const exhaustive: never = query_type;
      throw new Error(`Unknown query_type: ${String(exhaustive)}`);
    }
  }
}

export function graphQuery(
  input: GraphQueryInput,
  projectDir: string,
): ToolResult<GraphQueryOutput> {
  const { query_type, target, options = {} } = input;

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) {
    return toolError(
      "KG_NOT_INDEXED",
      `Knowledge graph database not found at "${dbPath}". Run the codebase_graph tool first to index your codebase.`,
      true,
    );
  }

  const db = initDatabase(dbPath);
  const kq = new KgQuery(db);

  try {
    return dispatchQuery(kq, query_type, target, options);
  } finally {
    db.close();
  }
}
