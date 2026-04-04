/** MCP tool handler for semantic_search — natural language search over the knowledge graph. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { EmbeddingService } from "../graph/kg-embedding.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import type { EntityKind, SemanticSearchResult } from "../graph/kg-types.ts";
import { KgVectorQuery } from "../graph/kg-vector-query.ts";
import { type ToolResult, toolError, toolOk } from "../shared/lib/tool-result.ts";

export type SemanticSearchInput = {
  query: string;
  kind_filter?: string[];
  scope?: string;
  limit?: number;
  threshold?: number;
};

export type SemanticSearchOutput = {
  query: string;
  results: SemanticSearchResult[];
  count: number;
};

export async function semanticSearch(
  input: SemanticSearchInput,
  projectDir: string,
): Promise<ToolResult<SemanticSearchOutput>> {
  const { query, kind_filter, scope, limit, threshold } = input;

  if (!query || query.trim().length === 0) {
    return toolError("INVALID_INPUT", "query is required and must not be empty.");
  }

  // 1. Locate DB
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) {
    return toolError(
      "KG_NOT_INDEXED",
      `Knowledge graph database not found at "${dbPath}". Run the codebase_graph tool first.`,
      true,
    );
  }

  const db = initDatabase(dbPath);
  const embeddingService = new EmbeddingService();

  try {
    const vectorQuery = new KgVectorQuery(db, embeddingService);

    const results = await vectorQuery.semanticSearch(query, {
      kind_filter: kind_filter as EntityKind[] | undefined,
      limit,
      scope: scope as "entities" | "summaries" | "both" | undefined,
      threshold,
    });

    return toolOk({ count: results.length, query, results });
  } catch (err) {
    const msg = (err as Error).message;
    // If the model isn't loaded yet (first use, download in progress)
    if (msg.includes("fetch") || msg.includes("download") || msg.includes("network")) {
      return toolError(
        "UNEXPECTED",
        `Embedding model not ready. The model may be downloading (~22MB). Please retry in a moment.`,
        true,
      );
    }
    throw err; // Let wrapHandler catch unexpected errors
  } finally {
    embeddingService.dispose();
    db.close();
  }
}
