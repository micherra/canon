/** Get rich context for a file — contents, graph relationships, exports.
 * Designed to give Claude everything needed to write a meaningful summary. */

import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join, resolve, sep } from "path";
import { CANON_DIR, CANON_FILES, FILE_PREVIEW_MAX_LINES } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import { extractExports } from "../graph/export-parser.ts";
import { extractImports, resolveImport } from "../graph/import-parser.ts";
import { computeUnifiedBlastRadius, type UnifiedBlastRadiusReport } from "../graph/kg-blast-radius.ts";
import { computeFileInsightMaps, computeImpactScore, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EntityKind, FileMetrics } from "../graph/kg-types.ts";
import { scanSourceFiles } from "../graph/scanner.ts";
import { buildLayerInferrer, deriveSourceDirsFromLayers, loadLayerMappings } from "../utils/config.ts";
import { isNotFound } from "../utils/errors.ts";
import { loadPathAliases, toPosix } from "../utils/paths.ts";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

export interface FileContextInput {
  file_path: string;
}

export type FileGraphMetrics = Pick<
  FileMetrics,
  "in_degree" | "out_degree" | "is_hub" | "in_cycle" | "cycle_peers" | "layer_violation_count" | "impact_score"
>;

/** Concise entity descriptor returned alongside file context. */
export interface FileEntitySummary {
  name: string;
  kind: EntityKind;
  is_exported: boolean;
  line_start: number;
  line_end: number;
}

/** Violation detail from the most recent review that includes this file. */
export interface FileViolationDetail {
  principle_id: string;
  severity: string;
  message?: string;
}

export interface FileContextOutput {
  file_path: string;
  layer: string;
  content: string;
  imports: string[];
  imported_by: string[];
  exports: string[];
  violation_count: number;
  last_verdict: string | null;
  /** Plain-English summary from knowledge-graph.db, or null if not available. */
  summary: string | null;
  /** Violation details from the most recent review that includes this file. */
  violations: FileViolationDetail[];
  /** Imports grouped by their inferred layer. */
  imports_by_layer: Record<string, string[]>;
  /** imported_by files grouped by their inferred layer. */
  imported_by_layer: Record<string, string[]>;
  /** All unique layer names from project config, sorted alphabetically. */
  layer_stack: string[];
  /** Derived role based on graph metrics. */
  role: string;
  /** Shape characterization derived from graph metrics. */
  shape: { label: string; description: string };
  /** Maximum impact score across all nodes in the knowledge graph. Used for relative comparison. */
  project_max_impact: number;
  graph_metrics?: FileGraphMetrics;
  entities?: FileEntitySummary[];
  blast_radius?: UnifiedBlastRadiusReport;
}

// ---------------------------------------------------------------------------
// Module-level cache for project_max_impact
// ---------------------------------------------------------------------------
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

/** Derive a human-readable shape characterization from graph metrics. */
function deriveShape(metrics: FileGraphMetrics | undefined): { label: string; description: string } {
  if (!metrics) {
    return { label: "Internal", description: "Moderate connectivity, typical file." };
  }

  const { in_degree, out_degree, in_cycle } = metrics;

  let label = "Internal";
  let description = "Moderate connectivity, typical file.";

  if (in_degree > 8 && out_degree < 4) {
    label = "Sink";
    description = "Many things depend on this, it depends on few. Wide blast radius.";
  } else if (in_degree < 3 && out_degree > 8) {
    label = "High fan-out hub";
    description = "Depends on many, depended on by few. Changes propagate outward.";
  } else if (in_degree > 5 && out_degree > 5) {
    label = "Central hub";
    description = "High connectivity in both directions. Highest-risk change surface.";
  } else if (in_degree === 0) {
    label = "Leaf";
    description = "Nothing depends on this. Safe to change.";
  }

  return {
    label: in_cycle ? `Cycle member — ${label}` : label,
    description,
  };
}

function deriveRole(metrics: FileGraphMetrics | undefined): string {
  if (!metrics) return "internal";
  if (metrics.is_hub) return "hub";
  if (metrics.in_cycle) return "cycle member";
  if (metrics.in_degree === 0) return "entry point";
  if (metrics.out_degree === 0) return "leaf";
  return "internal";
}

export async function getFileContext(
  input: FileContextInput,
  projectDir: string,
): Promise<ToolResult<FileContextOutput>> {
  // Normalize to POSIX separators — graph IDs and layer patterns use '/' consistently
  const filePath = toPosix(input.file_path);

  // Load user-configurable layer mappings
  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  const emptyResult = (layer: string): FileContextOutput => ({
    file_path: filePath,
    layer,
    content: "",
    imports: [],
    imported_by: [],
    exports: [],
    violation_count: 0,
    last_verdict: null,
    summary: null,
    violations: [],
    imports_by_layer: {},
    imported_by_layer: {},
    layer_stack: [],
    role: "internal",
    shape: { label: "Internal", description: "Moderate connectivity, typical file." },
    project_max_impact: 0,
  });

  // Prevent path traversal outside the project directory
  const absPath = resolve(projectDir, filePath);
  const projectRoot = resolve(projectDir) + sep;
  if (absPath !== resolve(projectDir) && !absPath.startsWith(projectRoot)) {
    return toolError("INVALID_INPUT", "File path traverses outside project directory");
  }

  let content: string;
  try {
    const raw = await readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    content =
      lines.length > FILE_PREVIEW_MAX_LINES
        ? lines.slice(0, FILE_PREVIEW_MAX_LINES).join("\n") + "\n... (truncated)"
        : raw;
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return toolError("INVALID_INPUT", `File not found: ${filePath}`);
    }
    throw err;
  }

  // Infer layer
  const layer = inferLayer(filePath) || "unknown";

  // Extract exports
  const exports = extractExports(content, filePath);

  // Extract this file's imports
  const rawImports = extractImports(content, filePath);

  // Load path aliases from tsconfig.json
  const aliases = await loadPathAliases(projectDir);

  // Scan all project files to resolve this file's imports
  const sourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const allFiles: string[] = [];

  if (sourceDirs && sourceDirs.length > 0) {
    for (const dir of sourceDirs) {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {});
      for (const f of files) {
        allFiles.push(toPosix(join(dir, f)));
      }
    }
  }

  const fileSet = new Set(allFiles);

  // Resolve this file's imports to project-relative paths
  const imports: string[] = [];
  for (const imp of rawImports) {
    const resolved = resolveImport(imp, filePath, fileSet, aliases);
    if (resolved) imports.push(resolved);
  }

  // Load compliance data
  let violation_count = 0;
  let last_verdict: string | null = null;
  let violations: FileViolationDetail[] = [];
  let lastReviewedAt: string | null = null;
  try {
    const store = new DriftStore(projectDir);
    const reviews = await store.getReviews();
    for (const review of reviews) {
      if (review.files.includes(filePath)) {
        if (!lastReviewedAt || review.timestamp > lastReviewedAt) {
          lastReviewedAt = review.timestamp;
          last_verdict = review.verdict;
          // Extract violation details from this review for the file
          const hasPerFile = review.violations.some((v) => v.file_path);
          if (hasPerFile) {
            violations = review.violations
              .filter((v) => v.file_path === filePath)
              .map((v) => ({
                principle_id: v.principle_id,
                severity: v.severity,
                ...(v.message !== undefined && { message: v.message }),
              }));
          } else {
            violations = review.violations.map((v) => ({
              principle_id: v.principle_id,
              severity: v.severity,
              ...(v.message !== undefined && { message: v.message }),
            }));
          }
        }
        // Count only violations attributed to this specific file.
        // Falls back to counting all violations if none have file_path (legacy data).
        const hasPerFile = review.violations.some((v) => v.file_path);
        if (hasPerFile) {
          violation_count += review.violations.filter((v) => v.file_path === filePath).length;
        } else {
          violation_count += review.violations.length;
        }
      }
    }
  } catch {
    // no compliance data
  }

  // Load graph metrics, entities, blast_radius, summary, imported_by, and project_max_impact
  // from the KG database. When DB is absent, these fields are either undefined or derived
  // from the file scan fallback.
  let graph_metrics: FileGraphMetrics | undefined;
  let project_max_impact = 0;
  let entities: FileEntitySummary[] | undefined;
  let blast_radius: UnifiedBlastRadiusReport | undefined;
  let summary: string | null = null;
  let imported_by: string[] = [];

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (existsSync(dbPath)) {
    let db: ReturnType<typeof initDatabase> | undefined;
    try {
      db = initDatabase(dbPath);
      const store = new KgStore(db);
      const kgQuery = new KgQuery(db);

      // ---- Compute file insight maps (hub/cycle/violations) once ----
      const insightMaps = computeFileInsightMaps(db);

      // ---- graph_metrics via KgQuery.getFileMetrics ----
      const fileMetrics = kgQuery.getFileMetrics(filePath, {
        hubPaths: insightMaps.hubPaths,
        cycleMemberPaths: insightMaps.cycleMemberPaths,
        layerViolationsByPath: insightMaps.layerViolationsByPath,
      });
      if (fileMetrics) {
        graph_metrics = {
          in_degree: fileMetrics.in_degree,
          out_degree: fileMetrics.out_degree,
          is_hub: fileMetrics.is_hub,
          in_cycle: fileMetrics.in_cycle,
          cycle_peers: fileMetrics.cycle_peers,
          layer_violation_count: fileMetrics.layer_violation_count,
          impact_score: fileMetrics.impact_score,
        };
      }

      // ---- project_max_impact from all files with degree data ----
      // This is O(V) — load all files, all degrees, iterate every node. We
      // cache the result keyed by DB path + mtime so repeated calls within the
      // same indexer run are free. The cache is invalidated automatically when
      // the DB file is updated by the indexer.
      const cached = getCachedMaxImpact(dbPath);
      if (cached !== undefined) {
        project_max_impact = cached;
      } else {
        const allFilesWithStats = kgQuery.getAllFilesWithStats();
        const allDegrees = kgQuery.getAllFileDegrees();
        for (const fileRow of allFilesWithStats) {
          if (fileRow.file_id === undefined) continue;
          const degrees = allDegrees.get(fileRow.file_id) ?? { in_degree: 0, out_degree: 0 };
          const violations_count = insightMaps.layerViolationsByPath.get(fileRow.path)?.length ?? 0;
          const score = computeImpactScore(degrees.in_degree, violations_count, false, fileRow.layer || "unknown");
          if (score > project_max_impact) project_max_impact = score;
        }
        setCachedMaxImpact(dbPath, project_max_impact);
      }

      // ---- entities and summary from KgStore ----
      const fileRow = store.getFile(filePath);
      if (fileRow?.file_id !== undefined) {
        const entityRows = store.getEntitiesByFile(fileRow.file_id);
        entities = entityRows.map((e) => ({
          name: e.name,
          kind: e.kind,
          is_exported: e.is_exported,
          line_start: e.line_start,
          line_end: e.line_end,
        }));

        // Summary from DB — DB is the sole source
        try {
          const summaryRow = store.getSummaryByFile(fileRow.file_id);
          if (summaryRow) {
            summary = summaryRow.summary;
          }
        } catch {
          // ignore DB summary errors
        }
      }

      // ---- imported_by via file_edges SQL query ----
      // SELECT source files that have an edge targeting this file
      const fileIdRow = store.getFile(filePath);
      if (fileIdRow?.file_id !== undefined) {
        const importerRows = db
          .prepare(
            `SELECT DISTINCT f.path FROM file_edges fe JOIN files f ON f.file_id = fe.source_file_id WHERE fe.target_file_id = ? ORDER BY f.path`,
          )
          .all(fileIdRow.file_id) as Array<{ path: string }>;
        imported_by = importerRows.map((r) => r.path);
      }

      // ---- blast_radius ----
      blast_radius = computeUnifiedBlastRadius(db, filePath, { maxDepth: 2 });
    } catch {
      // KG unavailable — skip graph data gracefully
    } finally {
      db?.close();
    }
  }

  // When DB is absent, fall back to O(n) file scan for imported_by
  if (!existsSync(dbPath)) {
    try {
      for (const otherFile of allFiles) {
        if (otherFile === filePath) continue;
        try {
          const otherContent = await readFile(join(projectDir, otherFile), "utf-8");
          const otherImports = extractImports(otherContent, otherFile);
          for (const imp of otherImports) {
            const resolved = resolveImport(imp, otherFile, fileSet, aliases);
            if (resolved === filePath) {
              imported_by.push(otherFile);
              break;
            }
          }
        } catch (err: unknown) {
          if (isNotFound(err)) continue;
          throw err;
        }
      }
    } catch {
      // fallback failed — leave imported_by empty
    }
  }

  // Group imports by layer
  const imports_by_layer: Record<string, string[]> = {};
  for (const imp of imports) {
    const impLayer = inferLayer(imp) || "unknown";
    if (!imports_by_layer[impLayer]) imports_by_layer[impLayer] = [];
    imports_by_layer[impLayer].push(imp);
  }

  // Group imported_by by layer
  const imported_by_layer: Record<string, string[]> = {};
  for (const dep of imported_by) {
    const depLayer = inferLayer(dep) || "unknown";
    if (!imported_by_layer[depLayer]) imported_by_layer[depLayer] = [];
    imported_by_layer[depLayer].push(dep);
  }

  // Derive layer_stack from layer mappings config
  const layer_stack: string[] = Object.keys(layerMappings).sort();

  // Derive role from graph metrics
  const role = deriveRole(graph_metrics);

  // Derive shape characterization from graph metrics
  const shape = deriveShape(graph_metrics);

  return toolOk({
    file_path: filePath,
    layer,
    content,
    imports,
    imported_by,
    exports,
    violation_count,
    last_verdict,
    summary,
    violations,
    imports_by_layer,
    imported_by_layer,
    layer_stack,
    role,
    shape,
    project_max_impact,
    graph_metrics,
    ...(entities !== undefined && { entities }),
    ...(blast_radius !== undefined && { blast_radius }),
  });
}
