/** Get rich context for a file — contents, graph relationships, exports.
 * Designed to give Claude everything needed to write a meaningful summary. */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { CANON_DIR, CANON_FILES, FILE_PREVIEW_MAX_LINES } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import { extractExports } from "../graph/export-parser.ts";
import { extractImports, resolveImport } from "../graph/import-parser.ts";
import {
  computeUnifiedBlastRadius,
  type UnifiedBlastRadiusReport,
} from "../graph/kg-blast-radius.ts";
import { computeFileInsightMaps, computeImpactScore, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EntityKind, FileMetrics } from "../graph/kg-types.ts";
import { scanSourceFiles } from "../graph/scanner.ts";
import {
  buildLayerInferrer,
  deriveSourceDirsFromLayers,
  loadLayerMappings,
} from "../utils/config.ts";
import { isNotFound } from "../utils/errors.ts";
import { loadPathAliases, toPosix } from "../utils/paths.ts";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

export type FileContextInput = {
  file_path: string;
};

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

/** Violation detail from the most recent review that includes this file. */
export type FileViolationDetail = {
  principle_id: string;
  severity: string;
  message?: string;
};

export type FileContextOutput = {
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

/** Derive a human-readable shape characterization from graph metrics. */
function deriveShape(metrics: FileGraphMetrics | undefined): {
  label: string;
  description: string;
} {
  if (!metrics) {
    return { description: "Moderate connectivity, typical file.", label: "Internal" };
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
    description,
    label: in_cycle ? `Cycle member — ${label}` : label,
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

/** Read and truncate file content. Returns error result or content string. */
async function readFileContent(
  absPath: string,
  filePath: string,
): Promise<ToolResult<FileContextOutput> | string> {
  try {
    const raw = await readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    return lines.length > FILE_PREVIEW_MAX_LINES
      ? `${lines.slice(0, FILE_PREVIEW_MAX_LINES).join("\n")}\n... (truncated)`
      : raw;
  } catch (err: unknown) {
    if (isNotFound(err)) return toolError("INVALID_INPUT", `File not found: ${filePath}`);
    throw err;
  }
}

/** Scan all project source files and return their paths. */
async function scanAllProjectFiles(projectDir: string): Promise<string[]> {
  const sourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const allFiles: string[] = [];
  if (sourceDirs && sourceDirs.length > 0) {
    for (const dir of sourceDirs) {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {});
      for (const f of files) allFiles.push(toPosix(join(dir, f)));
    }
  }
  return allFiles;
}

/** Load compliance data (violations, verdicts) for a file from DriftStore. */
async function loadComplianceData(
  projectDir: string,
  filePath: string,
): Promise<{
  violation_count: number;
  last_verdict: string | null;
  violations: FileViolationDetail[];
}> {
  let violation_count = 0;
  let last_verdict: string | null = null;
  let violations: FileViolationDetail[] = [];
  let lastReviewedAt: string | null = null;

  try {
    const store = new DriftStore(projectDir);
    const reviews = await store.getReviews();
    for (const review of reviews) {
      if (!review.files.includes(filePath)) continue;

      if (!lastReviewedAt || review.timestamp > lastReviewedAt) {
        lastReviewedAt = review.timestamp;
        last_verdict = review.verdict;
        const hasPerFile = review.violations.some((v) => v.file_path);
        const filteredViolations = hasPerFile
          ? review.violations.filter((v) => v.file_path === filePath)
          : review.violations;
        violations = filteredViolations.map((v) => ({
          principle_id: v.principle_id,
          severity: v.severity,
          ...(v.message !== undefined && { message: v.message }),
        }));
      }

      const hasPerFile = review.violations.some((v) => v.file_path);
      violation_count += hasPerFile
        ? review.violations.filter((v) => v.file_path === filePath).length
        : review.violations.length;
    }
  } catch {
    // no compliance data
  }

  return { last_verdict, violation_count, violations };
}

/** Load graph data from the KG database. */
function loadKgData(
  dbPath: string,
  filePath: string,
): {
  graph_metrics?: FileGraphMetrics;
  project_max_impact: number;
  entities?: FileEntitySummary[];
  blast_radius?: UnifiedBlastRadiusReport;
  summary: string | null;
  imported_by: string[];
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
  } catch {
    // KG unavailable — skip graph data gracefully
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
  } catch {
    /* ignore DB summary errors */
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

/** Options for import resolution scanning. */
type ImportScanOptions = {
  fileSet: Set<string>;
  aliases: Awaited<ReturnType<typeof loadPathAliases>>;
  projectDir: string;
};

/** Check if a single file imports the target file. */
async function fileImportsTarget(
  otherFile: string,
  filePath: string,
  options: ImportScanOptions,
): Promise<boolean> {
  const { fileSet, aliases, projectDir } = options;
  const otherContent = await readFile(join(projectDir, otherFile), "utf-8");
  const otherImports = extractImports(otherContent, otherFile);
  for (const imp of otherImports) {
    const resolved = resolveImport(imp, otherFile, fileSet, aliases);
    if (resolved === filePath) return true;
  }
  return false;
}

/** Fall back to O(n) file scan for imported_by when DB is absent. */
async function scanImportedByFallback(
  filePath: string,
  allFiles: string[],
  options: ImportScanOptions,
): Promise<string[]> {
  const imported_by: string[] = [];
  try {
    for (const otherFile of allFiles) {
      if (otherFile === filePath) continue;
      try {
        if (await fileImportsTarget(otherFile, filePath, options)) {
          imported_by.push(otherFile);
        }
      } catch (err: unknown) {
        if (isNotFound(err)) continue;
        throw err;
      }
    }
  } catch {
    /* fallback failed */
  }
  return imported_by;
}

/** Group paths by their inferred layer. */
function groupByLayer(
  paths: string[],
  inferLayer: (p: string) => string,
): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const p of paths) {
    const layer = inferLayer(p) || "unknown";
    if (!groups[layer]) groups[layer] = [];
    groups[layer].push(p);
  }
  return groups;
}

/** Resolve imports and imported_by for a file. */
async function resolveFileRelationships(
  filePath: string,
  content: string,
  projectDir: string,
): Promise<{
  imports: string[];
  imported_by: string[];
  aliases: Awaited<ReturnType<typeof loadPathAliases>>;
}> {
  const rawImports = extractImports(content, filePath);
  const aliases = await loadPathAliases(projectDir);
  const allFiles = await scanAllProjectFiles(projectDir);
  const fileSet = new Set(allFiles);

  const imports: string[] = [];
  for (const imp of rawImports) {
    const resolved = resolveImport(imp, filePath, fileSet, aliases);
    if (resolved) imports.push(resolved);
  }

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  let kgData = {
    imported_by: [] as string[],
    project_max_impact: 0,
    summary: null as string | null,
  } as ReturnType<typeof loadKgData>;

  if (existsSync(dbPath)) {
    kgData = loadKgData(dbPath, filePath);
  }

  let imported_by = kgData.imported_by;
  if (!existsSync(dbPath)) {
    imported_by = await scanImportedByFallback(filePath, allFiles, {
      aliases,
      fileSet,
      projectDir,
    });
  }

  return { aliases, imported_by, imports };
}

export async function getFileContext(
  input: FileContextInput,
  projectDir: string,
): Promise<ToolResult<FileContextOutput>> {
  const filePath = toPosix(input.file_path);
  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  const absPath = resolve(projectDir, filePath);
  const projectRoot = resolve(projectDir) + sep;
  if (absPath !== resolve(projectDir) && !absPath.startsWith(projectRoot)) {
    return toolError("INVALID_INPUT", "File path traverses outside project directory");
  }

  const contentResult = await readFileContent(absPath, filePath);
  if (typeof contentResult !== "string") return contentResult;
  const content = contentResult;

  const layer = inferLayer(filePath) || "unknown";
  const exports = extractExports(content, filePath);
  const { imports, imported_by } = await resolveFileRelationships(filePath, content, projectDir);
  const compliance = await loadComplianceData(projectDir, filePath);

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const kgData = existsSync(dbPath)
    ? loadKgData(dbPath, filePath)
    : ({
        blast_radius: undefined,
        entities: undefined,
        graph_metrics: undefined,
        imported_by: [],
        project_max_impact: 0,
        summary: null,
      } as ReturnType<typeof loadKgData>);

  return toolOk({
    content,
    exports,
    file_path: filePath,
    imported_by,
    imports,
    layer,
    ...compliance,
    graph_metrics: kgData.graph_metrics,
    imported_by_layer: groupByLayer(imported_by, inferLayer),
    imports_by_layer: groupByLayer(imports, inferLayer),
    layer_stack: Object.keys(layerMappings).sort(),
    project_max_impact: kgData.project_max_impact,
    role: deriveRole(kgData.graph_metrics),
    shape: deriveShape(kgData.graph_metrics),
    summary: kgData.summary,
    ...(kgData.entities !== undefined && { entities: kgData.entities }),
    ...(kgData.blast_radius !== undefined && { blast_radius: kgData.blast_radius }),
  });
}
