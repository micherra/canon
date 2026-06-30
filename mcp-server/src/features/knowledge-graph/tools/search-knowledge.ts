/**
 * MCP tool handler for search_knowledge — semantic search over the Canon
 * knowledge corpus (principles, references, agents, primers, memory digest).
 *
 * Mirrors the semantic_search handler design:
 * - Checks DB exists (KG_NOT_INDEXED if absent)
 * - Calls ensureDocCorpusFresh before querying
 * - Uses DocVectorQuery for KNN
 * - Returns verbatim content (residual-R1 contract: no truncation)
 * - Fail-open: model-download errors return a retryable UNEXPECTED
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDocCorpusFresh } from "@features/knowledge-graph/ensure-doc-corpus-fresh.ts";
import { type DocSearchResult, DocVectorQuery } from "@graph/kg-doc-query.ts";
import { EmbeddingService } from "@graph/kg-embedding.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import {
  CANON_DIR,
  CANON_FILES,
  DEFAULT_DOC_CORPUS_SOURCES,
  type DocCorpusSource,
} from "@shared/constants.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

export type SearchKnowledgeInput = {
  query: string;
  /** Trust-tier filter: "internal" (default) | "any" */
  trust?: "internal" | "any";
  /** Maximum results to return (default: 10). */
  limit?: number;
  /** Restrict results to specific corpus names. */
  corpora?: string[];
};

export type SearchKnowledgeOutput = {
  query: string;
  results: DocSearchResult[];
  count: number;
};

/**
 * Resolve the default corpus sources for `projectDir`.
 * In-repo sources (principles/, references/, agents/, primers/) are resolved
 * relative to the plugin root (projectDir). The digest source is resolved from
 * the user's memory directory.
 */
function resolveDefaultSources(projectDir: string): DocCorpusSource[] {
  const digestRoot = (() => {
    const sanitized = projectDir.replace(/\//g, "-");
    return join(homedir(), ".claude", "projects", sanitized, "memory");
  })();

  return DEFAULT_DOC_CORPUS_SOURCES.map((src) => ({
    ...src,
    root: src.corpus === "digest" ? digestRoot : join(projectDir, src.corpus),
  }));
}

export async function searchKnowledge(
  input: SearchKnowledgeInput,
  projectDir: string,
): Promise<ToolResult<SearchKnowledgeOutput>> {
  const { query, trust, limit, corpora } = input;

  if (!query || query.trim().length === 0) {
    return toolError("INVALID_INPUT", "query is required and must not be empty.");
  }

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) {
    return toolError(
      "KG_NOT_INDEXED",
      `Knowledge corpus not indexed at "${dbPath}". Run the codebase_graph tool first to initialize the database.`,
      true,
    );
  }

  const embeddingService = new EmbeddingService();
  const db = initDatabase(dbPath);

  try {
    // Ensure the corpus is fresh (lazy ingest on content-hash mismatch)
    const sources = resolveDefaultSources(projectDir);
    await ensureDocCorpusFresh(dbPath, sources, embeddingService);

    const vectorQuery = new DocVectorQuery(db, embeddingService);
    const results = await vectorQuery.queryDocs(query, { corpora, limit, trust });

    return toolOk({ count: results.length, query, results });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("fetch") || msg.includes("download") || msg.includes("network")) {
      return toolError(
        "UNEXPECTED",
        "Embedding model not ready. The model may be downloading (~22MB). Please retry in a moment.",
        true,
      );
    }
    throw err; // Let wrapHandler catch unexpected errors
  } finally {
    embeddingService.dispose();
    db.close();
  }
}
