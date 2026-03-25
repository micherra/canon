/** Get rich context for a file — contents, graph relationships, exports.
 * Designed to give Claude everything needed to write a meaningful summary. */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, sep } from "path";
import { extractImports, resolveImport } from "../graph/import-parser.js";
import { extractExports } from "../graph/export-parser.js";
import { scanSourceFiles } from "../graph/scanner.js";
import { DriftStore } from "../drift/store.js";
import { loadSourceDirs, loadLayerMappings, buildLayerInferrer } from "../utils/config.js";
import { isNotFound } from "../utils/errors.js";
import { loadCachedGraph, getNodeMetrics, type GraphMetrics } from "../graph/query.js";
import { toPosix, loadPathAliases } from "../utils/paths.js";
import { CANON_DIR, CANON_FILES, FILE_PREVIEW_MAX_LINES } from "../constants.js";
import { initDatabase } from "../graph/kg-schema.js";
import { KgStore } from "../graph/kg-store.js";
import { KgQuery } from "../graph/kg-query.js";
import type { EntityKind } from "../graph/kg-types.js";

export interface FileContextInput {
  file_path: string;
}

export type FileGraphMetrics = Pick<
  GraphMetrics,
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

/** One reachable entity in the blast radius of this file's exports. */
export interface FileBlastRadiusEntry {
  name: string;
  qualified_name: string;
  kind: EntityKind;
  depth: number;
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
  graph_metrics?: FileGraphMetrics;
  entities?: FileEntitySummary[];
  blast_radius?: FileBlastRadiusEntry[];
}


export async function getFileContext(
  input: FileContextInput,
  projectDir: string,
): Promise<FileContextOutput> {
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
  });

  // Prevent path traversal outside the project directory
  const absPath = resolve(projectDir, filePath);
  const projectRoot = resolve(projectDir) + sep;
  if (absPath !== resolve(projectDir) && !absPath.startsWith(projectRoot)) {
    return emptyResult("unknown");
  }

  let content: string;
  try {
    const raw = await readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    content = lines.length > FILE_PREVIEW_MAX_LINES
      ? lines.slice(0, FILE_PREVIEW_MAX_LINES).join("\n") + "\n... (truncated)"
      : raw;
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return emptyResult(inferLayer(filePath) || "unknown");
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
  const sourceDirs = await loadSourceDirs(projectDir);
  let allFiles: string[] = [];

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

  // Find files that import this file (reverse dependencies).
  // Try the cached reverse index first (O(1)), fall back to O(n) scan.
  let imported_by: string[] = [];
  try {
    const raw = await readFile(join(projectDir, CANON_DIR, CANON_FILES.REVERSE_DEPS), "utf-8");
    const reverseIndex = JSON.parse(raw) as Record<string, string[]>;
    imported_by = reverseIndex[filePath] || [];
  } catch {
    // No reverse index — fall back to scanning all files
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
  }

  // Load compliance data
  let violation_count = 0;
  let last_verdict: string | null = null;
  let lastReviewedAt: string | null = null;
  try {
    const store = new DriftStore(projectDir);
    const reviews = await store.getReviews();
    for (const review of reviews) {
      if (review.files.includes(filePath)) {
        if (!lastReviewedAt || review.timestamp > lastReviewedAt) {
          lastReviewedAt = review.timestamp;
          last_verdict = review.verdict;
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

  // Load graph metrics if graph data exists
  let graph_metrics: FileGraphMetrics | undefined;
  const graph = await loadCachedGraph(projectDir);
  if (graph) {
    const metrics = getNodeMetrics(graph, filePath);
    if (metrics) {
      graph_metrics = {
        in_degree: metrics.in_degree,
        out_degree: metrics.out_degree,
        is_hub: metrics.is_hub,
        in_cycle: metrics.in_cycle,
        cycle_peers: metrics.cycle_peers,
        layer_violation_count: metrics.layer_violation_count,
        impact_score: metrics.impact_score,
      };
    }
  }

  // Load entity data from the knowledge graph DB if it exists
  let entities: FileEntitySummary[] | undefined;
  let blast_radius: FileBlastRadiusEntry[] | undefined;
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (existsSync(dbPath)) {
    let db: ReturnType<typeof initDatabase> | undefined;
    try {
      db = initDatabase(dbPath);
      const store = new KgStore(db);
      const query = new KgQuery(db);

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

        // Blast radius from exported entities only
        const exportedIds = entityRows
          .filter((e) => e.is_exported && e.entity_id !== undefined)
          .map((e) => e.entity_id as number);

        if (exportedIds.length > 0) {
          const blastRows = query.getBlastRadius(exportedIds);
          blast_radius = blastRows.map((r) => ({
            name: r.name,
            qualified_name: r.qualified_name,
            kind: r.kind,
            depth: r.depth,
          }));
        } else {
          blast_radius = [];
        }
      }
    } catch {
      // KG unavailable — skip entity data gracefully
    } finally {
      db?.close();
    }
  }

  return {
    file_path: filePath,
    layer,
    content,
    imports,
    imported_by,
    exports,
    violation_count,
    last_verdict,
    graph_metrics,
    ...(entities !== undefined && { entities }),
    ...(blast_radius !== undefined && { blast_radius }),
  };
}
