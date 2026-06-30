/**
 * kg-doc-query.ts
 *
 * DocVectorQuery — semantic KNN over doc_chunks / doc_vectors.
 *
 * Mirrors KgVectorQuery design:
 * - Async embed (calls EmbeddingService)
 * - Sync KNN query (vec0 MATCH idiom with k = ?)
 * - Returns verbatim content from doc_chunks.content (no truncation)
 * - trust_tier filter: "internal" restricts to internal-tier chunks; "any" skips filter
 *
 * This class throws on errors — it is internal infrastructure, not an MCP tool
 * handler. Callers that need graceful degradation should wrap in try/catch.
 */

import type Database from "better-sqlite3";
import type { EmbeddingServiceLike } from "./kg-embedding.ts";

export type DocSearchResult = {
  chunk_id: number;
  corpus: string;
  doc_path: string;
  heading_path: string | null;
  chunk_index: number;
  content: string;
  trust_tier: string;
  distance: number;
};

export type DocQueryOptions = {
  /** Maximum results to return (default: 10). */
  limit?: number;
  /** Trust-tier filter: "internal" (default) | "any" */
  trust?: "internal" | "any";
  /** Restrict results to these corpora. When undefined, all corpora are searched. */
  corpora?: string[];
};

export class DocVectorQuery {
  constructor(
    private readonly db: Database.Database,
    private readonly embeddingService: EmbeddingServiceLike,
  ) {}

  /**
   * Semantic search over the doc knowledge corpus.
   *
   * Steps:
   * 1. Embed the query text (async)
   * 2. KNN query doc_vectors via vec0 MATCH / k = ? idiom (sync)
   * 3. JOIN doc_chunks for content + metadata
   * 4. Apply trust_tier filter and corpus filter
   * 5. Return ranked results (lower distance = better)
   */
  async queryDocs(query: string, opts?: DocQueryOptions): Promise<DocSearchResult[]> {
    const limit = opts?.limit ?? 10;
    const trust = opts?.trust ?? "internal";
    const corpora = opts?.corpora;

    // 1. Embed the query (async — outside any transaction)
    const queryVec = await this.embeddingService.embedOne(query);
    const queryBuf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

    // 2. Build SQL — vec0 KNN via MATCH + k = ? (bound params work for queries, only writes bug out)
    const trustClause = trust === "internal" ? "AND dc.trust_tier = 'internal'" : "";

    let corporaClause = "";
    let corporaParams: string[] = [];
    if (corpora && corpora.length > 0) {
      corporaClause = `AND dc.corpus IN (${corpora.map(() => "?").join(",")})`;
      corporaParams = corpora;
    }

    const sql = `
      SELECT
        dv.chunk_id,
        dv.distance,
        dc.corpus,
        dc.doc_path,
        dc.heading_path,
        dc.chunk_index,
        dc.content,
        dc.trust_tier
      FROM doc_vectors dv
      JOIN doc_chunks dc ON dc.chunk_id = dv.chunk_id
      WHERE dv.embedding MATCH ?
        AND k = ?
        ${trustClause}
        ${corporaClause}
      ORDER BY dv.distance
    `;

    const rows = this.db.prepare(sql).all(queryBuf, limit, ...corporaParams) as Array<{
      chunk_id: number;
      distance: number;
      corpus: string;
      doc_path: string;
      heading_path: string | null;
      chunk_index: number;
      content: string;
      trust_tier: string;
    }>;

    return rows.map((row) => ({
      chunk_id: row.chunk_id,
      chunk_index: row.chunk_index,
      content: row.content, // verbatim, no truncation
      corpus: row.corpus,
      distance: row.distance,
      doc_path: row.doc_path,
      heading_path: row.heading_path,
      trust_tier: row.trust_tier,
    }));
  }
}
