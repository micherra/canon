/** Get rich context for a file — contents, graph relationships, exports.
 * Designed to give Claude everything needed to write a meaningful summary. */

import { readFile } from "fs/promises";
import { join, normalize, resolve, sep } from "path";
import { extractImports, resolveImport, parseTsconfigPaths, type PathAlias } from "../graph/import-parser.js";
import { extractExports } from "../graph/export-parser.js";
import { scanSourceFiles } from "../graph/scanner.js";
import { DriftStore } from "../drift/store.js";
import { loadSourceDirs, loadLayerMappings, buildLayerInferrer } from "../utils/config.js";
import { isNotFound } from "../utils/errors.js";
import { loadCachedGraph, getNodeMetrics } from "../graph/query.js";

export interface GetFileContextInput {
  file_path: string;
}

export interface FileGraphMetrics {
  in_degree: number;
  out_degree: number;
  is_hub: boolean;
  in_cycle: boolean;
  cycle_peers: string[];
  layer_violation_count: number;
  impact_score: number;
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
}


export async function getFileContext(
  input: GetFileContextInput,
  projectDir: string,
): Promise<FileContextOutput> {
  const filePath = normalize(input.file_path);

  // Load user-configurable layer mappings
  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  // Prevent path traversal outside the project directory
  const absPath = resolve(projectDir, filePath);
  const projectRoot = resolve(projectDir) + sep;
  if (absPath !== resolve(projectDir) && !absPath.startsWith(projectRoot)) {
    return {
      file_path: filePath,
      layer: "unknown",
      content: "",
      imports: [],
      imported_by: [],
      exports: [],
      violation_count: 0,
      last_verdict: null,
    };
  }

  // Read file content (truncate at 200 lines)
  let content: string;
  try {
    const raw = await readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    content = lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n... (truncated)" : raw;
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return {
        file_path: filePath,
        layer: inferLayer(filePath) || "unknown",
        content: "",
        imports: [],
        imported_by: [],
        exports: [],
        violation_count: 0,
        last_verdict: null,
      };
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
  let aliases: PathAlias[] = [];
  try {
    const tsconfigRaw = await readFile(join(projectDir, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(tsconfigRaw);
    const paths = tsconfig.compilerOptions?.paths;
    if (paths) {
      aliases = parseTsconfigPaths(paths, tsconfig.compilerOptions.baseUrl);
    }
  } catch { /* no tsconfig or no paths */ }

  // Scan all project files to resolve this file's imports
  const sourceDirs = await loadSourceDirs(projectDir);
  let allFiles: string[] = [];

  if (sourceDirs && sourceDirs.length > 0) {
    for (const dir of sourceDirs) {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {});
      for (const f of files) {
        allFiles.push(join(dir, f));
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
    const raw = await readFile(join(projectDir, ".canon", "reverse-deps.json"), "utf-8");
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
  };
}
