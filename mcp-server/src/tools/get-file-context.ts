/** Get rich context for a file — contents, graph relationships, exports.
 * Designed to give Claude everything needed to write a meaningful summary. */

import { readFile } from "fs/promises";
import { join, normalize, resolve } from "path";
import { extractImports, resolveImport } from "../graph/import-parser.js";
import { extractExports } from "../graph/export-parser.js";
import { scanSourceFiles } from "../graph/scanner.js";
import { DriftStore } from "../drift/store.js";
import { loadSourceDirs, loadLayerMappings, buildLayerInferrer } from "../utils/config.js";
import { isNotFound } from "../utils/errors.js";

export interface GetFileContextInput {
  file_path: string;
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
  const projectRoot = resolve(projectDir) + "/";
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

  // Scan all project files to resolve imports and find reverse dependencies
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
    const resolved = resolveImport(imp, filePath, fileSet);
    if (resolved) imports.push(resolved);
  }

  // Find files that import this file (reverse dependencies)
  const imported_by: string[] = [];
  for (const otherFile of allFiles) {
    if (otherFile === filePath) continue;
    try {
      const otherContent = await readFile(join(projectDir, otherFile), "utf-8");
      const otherImports = extractImports(otherContent, otherFile);
      for (const imp of otherImports) {
        const resolved = resolveImport(imp, otherFile, fileSet);
        if (resolved === filePath) {
          imported_by.push(otherFile);
          break;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
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
        violation_count += review.violations.length;
      }
    }
  } catch {
    // no compliance data
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
  };
}
