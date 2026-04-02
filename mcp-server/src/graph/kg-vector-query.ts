/**
 * KgVectorQuery
 *
 * Semantic search across entity and summary vec0 tables.
 * Merges results from both tables, deduplicates by entity_id,
 * and returns ranked SemanticSearchResult[].
 *
 * This class throws on errors (it is internal infrastructure, not an MCP
 * tool handler). Callers that need graceful degradation should catch errors.
 */

import type Database from "better-sqlite3";
import type { EmbeddingService } from "./kg-embedding.ts";
import type { EntityKind, SemanticSearchResult } from "./kg-types.ts";

export class KgVectorQuery {
  constructor(
    private readonly db: Database.Database,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Semantic search across entity and summary vectors.
   *
   * Steps:
   * 1. Embed the query text (async)
   * 2. KNN query entity_vectors (sync) if scope includes entities
   * 3. KNN query summary_vectors (sync) if scope includes summaries
   * 4. Merge: deduplicate by entity_id (lower distance wins), sort by distance, apply limit
   */
  async semanticSearch(
    query: string,
    options?: {
      limit?: number;
      kind_filter?: EntityKind[];
      scope?: "entities" | "summaries" | "both";
      threshold?: number;
    },
  ): Promise<SemanticSearchResult[]> {
    const limit = options?.limit ?? 20;
    const scope = options?.scope ?? "both";
    const kindFilter = options?.kind_filter;
    const threshold = options?.threshold;

    // Fetch more candidates than limit to allow for dedup/merge across both tables
    const fetchLimit = limit * 3;

    // 1. Embed the query text (async)
    const queryVec = await this.embeddingService.embedOne(query);
    const queryBuf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

    const allResults: SemanticSearchResult[] = [];

    // 2. Query entity_vectors if scope includes entities
    if (scope === "entities" || scope === "both") {
      const entityResults = this._queryEntityVectors(queryBuf, fetchLimit, kindFilter, threshold);
      allResults.push(...entityResults);
    }

    // 3. Query summary_vectors if scope includes summaries
    if (scope === "summaries" || scope === "both") {
      const summaryResults = this._querySummaryVectors(queryBuf, fetchLimit, threshold);
      allResults.push(...summaryResults);
    }

    // 4. Merge: deduplicate by entity_id (lower distance wins), sort by distance, apply limit
    return this._mergeAndRank(allResults, limit);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _queryEntityVectors(
    queryBuf: Buffer,
    limit: number,
    kindFilter: EntityKind[] | undefined,
    threshold: number | undefined,
  ): SemanticSearchResult[] {
    // Build WHERE clause for kind filter
    let kindClause = "";
    let kindParams: string[] = [];
    if (kindFilter && kindFilter.length > 0) {
      kindClause = `AND e.kind IN (${kindFilter.map(() => "?").join(",")})`;
      kindParams = kindFilter;
    }

    // Build threshold clause — use a bound parameter to avoid NaN/Infinity issues
    let thresholdClause = "";
    let thresholdParams: number[] = [];
    if (threshold != null) {
      thresholdClause = `AND ev.distance <= ?`;
      thresholdParams = [threshold];
    }

    // vec0 KNN requires LIMIT as a WHERE constraint (k = ?) not a trailing LIMIT clause
    const sql = `
      SELECT
        ev.entity_id,
        ev.distance,
        e.file_id,
        e.name,
        e.qualified_name,
        e.kind,
        f.path AS file_path
      FROM entity_vectors ev
      JOIN entities e ON e.entity_id = ev.entity_id
      JOIN files f ON f.file_id = e.file_id
      WHERE ev.embedding MATCH ?
        AND k = ?
        ${kindClause}
        ${thresholdClause}
      ORDER BY ev.distance
    `;

    const rows = this.db.prepare(sql).all(queryBuf, limit, ...kindParams, ...thresholdParams) as Array<{
      entity_id: number;
      distance: number;
      file_id: number;
      name: string;
      qualified_name: string;
      kind: EntityKind;
      file_path: string;
    }>;

    return rows.map((row) => ({
      entity_id: row.entity_id,
      file_id: row.file_id,
      name: row.name,
      qualified_name: row.qualified_name,
      kind: row.kind,
      distance: row.distance,
      source: "entity" as const,
      file_path: row.file_path,
    }));
  }

  private _querySummaryVectors(queryBuf: Buffer, limit: number, threshold: number | undefined): SemanticSearchResult[] {
    // Build threshold clause — use a bound parameter to avoid NaN/Infinity issues
    let thresholdClause = "";
    let thresholdParams: number[] = [];
    if (threshold != null) {
      thresholdClause = `AND sv.distance <= ?`;
      thresholdParams = [threshold];
    }

    // vec0 KNN requires LIMIT as a WHERE constraint (k = ?) not a trailing LIMIT clause
    const sql = `
      SELECT
        sv.summary_id,
        sv.distance,
        s.entity_id,
        s.file_id,
        s.summary,
        e.name,
        e.qualified_name,
        e.kind,
        f.path AS file_path
      FROM summary_vectors sv
      JOIN summaries s ON s.summary_id = sv.summary_id
      LEFT JOIN entities e ON e.entity_id = s.entity_id
      JOIN files f ON f.file_id = s.file_id
      WHERE sv.embedding MATCH ?
        AND k = ?
        ${thresholdClause}
      ORDER BY sv.distance
    `;

    const rows = this.db.prepare(sql).all(queryBuf, limit, ...thresholdParams) as Array<{
      summary_id: number;
      distance: number;
      entity_id: number | null;
      file_id: number;
      summary: string;
      name: string | null;
      qualified_name: string | null;
      kind: EntityKind | null;
      file_path: string;
    }>;

    return rows.map((row) => ({
      entity_id: row.entity_id ?? 0,
      file_id: row.file_id,
      name: row.name ?? row.file_path,
      qualified_name: row.qualified_name ?? row.file_path,
      kind: (row.kind ?? "file") as EntityKind,
      distance: row.distance,
      source: "summary" as const,
      summary: row.summary,
      file_path: row.file_path,
    }));
  }

  /**
   * Merge results from entity and summary queries:
   * - Deduplicate by entity_id (keep lower distance)
   * - Sort ascending by distance
   * - Apply final limit
   */
  private _mergeAndRank(results: SemanticSearchResult[], limit: number): SemanticSearchResult[] {
    if (results.length === 0) return [];

    // Use a Map keyed by entity_id to deduplicate (lower distance wins)
    // entity_id=0 is used for file-level summaries with no entity; don't dedup those
    const entityMap = new Map<number, SemanticSearchResult>();
    const fileOnlySummaries: SemanticSearchResult[] = [];

    for (const result of results) {
      if (result.source === "summary" && result.entity_id === 0) {
        // File-level summary: no entity_id to dedup on — keep all
        fileOnlySummaries.push(result);
        continue;
      }

      const existing = entityMap.get(result.entity_id);
      if (!existing || result.distance < existing.distance) {
        entityMap.set(result.entity_id, result);
      }
    }

    const merged = [...entityMap.values(), ...fileOnlySummaries];
    merged.sort((a, b) => a.distance - b.distance);

    return merged.slice(0, limit);
  }
}
