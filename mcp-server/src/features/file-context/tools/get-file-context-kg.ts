/**
 * Structural-KG loaders for get-file-context.
 *
 * Extracted from get-file-context.ts (decision kg-extract-03) so the tool file
 * stays under the Biome `noExcessiveLinesPerFile` limit. Behaviour-preserving
 * move: these functions open the knowledge-graph.db and read graph metrics,
 * blast radius, entities, summaries, imported_by, and git-intel hotspot /
 * co-change data. `loadKgData` is the single entry point the tool calls.
 */

import { statSync } from "node:fs";
import { ensureGitIntelFresh } from "@features/knowledge-graph/git-intel/git-intel-pipeline.ts";
import type {
  CoChangePartner,
  HotspotRow,
  HotspotScoreOutput,
} from "@features/knowledge-graph/git-intel/git-intel-types.ts";
import {
  computeUnifiedBlastRadius,
  type UnifiedBlastRadiusReport,
} from "@graph/kg-blast-radius.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps, computeImpactScore } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityKind, FileMetrics } from "@graph/kg-types.ts";

export type FileGraphMetrics = Pick<
  FileMetrics,
  | "in_degree"
  | "out_degree"
  | "is_hub"
  | "in_cycle"
  | "cycle_peers"
  | "layer_violation_count"
  | "impact_score"
>;

/** Concise entity descriptor returned alongside file context. */
export type FileEntitySummary = {
  name: string;
  kind: EntityKind;
  is_exported: boolean;
  line_start: number;
  line_end: number;
};

// Module-level cache for project_max_impact
// Computing project_max_impact requires loading all file stats, all file
// degrees, and iterating every node — O(V) per getFileContext call. Since the
// KG DB only changes when the indexer runs, we cache the result keyed by DB
// path + last-modified time. The cache is invalidated automatically when the
// DB file changes.
const _maxImpactCache = new Map<string, number>();

function getCachedMaxImpact(dbPath: string): number | undefined {
  try {
    const mtime = statSync(dbPath).mtimeMs;
    return _maxImpactCache.get(`${dbPath}:${mtime}`);
  } catch {
    return undefined;
  }
}

function setCachedMaxImpact(dbPath: string, value: number): void {
  try {
    const mtime = statSync(dbPath).mtimeMs;
    // Evict stale entries for the same path before storing the fresh one.
    for (const key of _maxImpactCache.keys()) {
      if (key.startsWith(`${dbPath}:`)) {
        _maxImpactCache.delete(key);
      }
    }
    _maxImpactCache.set(`${dbPath}:${mtime}`, value);
  } catch {
    // If stat fails, skip caching — the value will be recomputed next call.
  }
}

/** Load git-intel hotspot and co-change data into the result. */
function loadGitIntelData(
  db: ReturnType<typeof initDatabase>,
  filePath: string,
  projectDir: string,
  result: ReturnType<typeof loadKgData>,
): void {
  try {
    ensureGitIntelFresh(db, projectDir);

    const hotspot = db.prepare("SELECT * FROM hotspot_scores WHERE file_path = ?").get(filePath) as
      | HotspotRow
      | undefined;
    if (hotspot) {
      result.hotspot_score = {
        churn_percentile: hotspot.churn_percentile,
        complexity_percentile: hotspot.complexity_pctile,
        is_hotspot: Boolean(hotspot.is_hotspot),
        score: hotspot.score,
      };
    }

    const partners = db
      .prepare(
        `SELECT file_b AS partner, jaccard FROM co_change_edges WHERE file_a = ?
         UNION
         SELECT file_a AS partner, jaccard FROM co_change_edges WHERE file_b = ?`,
      )
      .all(filePath, filePath) as Array<{ partner: string; jaccard: number }>;

    if (partners.length > 0) {
      result.co_change_partners = partners
        .sort((a, b) => b.jaccard - a.jaccard)
        .slice(0, 10)
        .map((p) => ({ jaccard: p.jaccard, path: p.partner }));
    }
  } catch {
    // Git intel unavailable — skip gracefully
  }
}

/** Load graph data from the KG database.
 *
 * @param dbPath     - absolute path to the knowledge-graph.db file
 * @param filePath   - project-relative file path to query
 * @param projectDir - when provided, triggers git-intel freshness check and
 *                     populates hotspot_score / co_change_partners fields.
 *                     Omit for the import-resolution call to avoid double spawnSync.
 *
 * Exported for unit testing. Not part of the tool's public interface.
 */
export function loadKgData(
  dbPath: string,
  filePath: string,
  projectDir?: string,
): {
  graph_metrics?: FileGraphMetrics;
  project_max_impact: number;
  entities?: FileEntitySummary[];
  blast_radius?: UnifiedBlastRadiusReport;
  summary: string | null;
  imported_by: string[];
  hotspot_score?: HotspotScoreOutput;
  co_change_partners?: Array<CoChangePartner>;
  computed_tags?: string[];
} {
  const result = {
    imported_by: [] as string[],
    project_max_impact: 0,
    summary: null as string | null,
  } as ReturnType<typeof loadKgData>;

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const store = new KgStore(db);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);

    const fileMetrics = kgQuery.getFileMetrics(filePath, {
      cycleMemberPaths: insightMaps.cycleMemberPaths,
      hubPaths: insightMaps.hubPaths,
      layerViolationsByPath: insightMaps.layerViolationsByPath,
    });
    if (fileMetrics) {
      result.graph_metrics = {
        cycle_peers: fileMetrics.cycle_peers,
        impact_score: fileMetrics.impact_score,
        in_cycle: fileMetrics.in_cycle,
        in_degree: fileMetrics.in_degree,
        is_hub: fileMetrics.is_hub,
        layer_violation_count: fileMetrics.layer_violation_count,
        out_degree: fileMetrics.out_degree,
      };
    }

    result.project_max_impact = computeProjectMaxImpact(dbPath, kgQuery, insightMaps);
    loadEntitiesAndSummary(store, filePath, result);
    result.imported_by = loadImportedByFromDb(db, store, filePath);
    result.blast_radius = computeUnifiedBlastRadius(db, filePath, { maxDepth: 2 });

    // Look up computed tags from community detection / tag propagation pipeline
    const tagRows = kgQuery.getFileTagsByPath(filePath);
    if (tagRows.length > 0) {
      result.computed_tags = tagRows.map((r) => r.tag);
    }

    // Git-intel: only when projectDir is provided (second loadKgData call in getFileContext).
    // The first call (inside resolveFileRelationships) intentionally omits projectDir
    // to avoid triggering two spawnSync calls to `git rev-parse HEAD` per tool invocation.
    if (projectDir) {
      loadGitIntelData(db, filePath, projectDir, result);
    }
  } catch (err) {
    // best-effort: KG graph data is optional enrichment; file context still returned
    console.warn(
      "[canon] get-file-context: KG graph data unavailable for",
      filePath,
      ":",
      err instanceof Error ? err.message : err,
    );
  } finally {
    db?.close();
  }

  return result;
}

/** Compute project_max_impact with caching. */
function computeProjectMaxImpact(
  dbPath: string,
  kgQuery: KgQuery,
  insightMaps: ReturnType<typeof computeFileInsightMaps>,
): number {
  const cached = getCachedMaxImpact(dbPath);
  if (cached !== undefined) return cached;

  let maxImpact = 0;
  const allFilesWithStats = kgQuery.getAllFilesWithStats();
  const allDegrees = kgQuery.getAllFileDegrees();
  for (const fileRow of allFilesWithStats) {
    if (fileRow.file_id === undefined) continue;
    const degrees = allDegrees.get(fileRow.file_id) ?? { in_degree: 0, out_degree: 0 };
    const violations_count = insightMaps.layerViolationsByPath.get(fileRow.path)?.length ?? 0;
    const score = computeImpactScore(
      degrees.in_degree,
      violations_count,
      false,
      fileRow.layer || "unknown",
    );
    if (score > maxImpact) maxImpact = score;
  }
  setCachedMaxImpact(dbPath, maxImpact);
  return maxImpact;
}

/** Load entities and summary from KgStore into the result. */
function loadEntitiesAndSummary(
  store: KgStore,
  filePath: string,
  result: { entities?: FileEntitySummary[]; summary: string | null },
): void {
  const fileRow = store.getFile(filePath);
  if (fileRow?.file_id === undefined) return;
  const entityRows = store.getEntitiesByFile(fileRow.file_id);
  result.entities = entityRows.map((e) => ({
    is_exported: e.is_exported,
    kind: e.kind,
    line_end: e.line_end,
    line_start: e.line_start,
    name: e.name,
  }));
  try {
    const summaryRow = store.getSummaryByFile(fileRow.file_id);
    if (summaryRow) result.summary = summaryRow.summary;
  } catch (err) {
    // best-effort: summary is optional enrichment from KG
    console.warn(
      "[canon] get-file-context: DB summary lookup failed for",
      filePath,
      ":",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Load imported_by from DB via file_edges query. */
function loadImportedByFromDb(
  db: ReturnType<typeof initDatabase>,
  store: KgStore,
  filePath: string,
): string[] {
  const fileIdRow = store.getFile(filePath);
  if (fileIdRow?.file_id === undefined) return [];
  const importerRows = db
    .prepare(
      `SELECT DISTINCT f.path FROM file_edges fe JOIN files f ON f.file_id = fe.source_file_id WHERE fe.target_file_id = ? ORDER BY f.path`,
    )
    .all(fileIdRow.file_id) as Array<{ path: string }>;
  return importerRows.map((r) => r.path);
}
