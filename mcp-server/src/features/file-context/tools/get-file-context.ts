/** Get rich context for a file — contents, graph relationships, exports. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ensureGraphFresh } from "@features/knowledge-graph/ensure-graph-fresh.ts";
import type {
  CoChangePartner,
  HotspotScoreOutput,
} from "@features/knowledge-graph/git-intel/git-intel-types.ts";
import { extractExports } from "@graph/export-parser.ts";
import { extractImports, resolveImport } from "@graph/import-parser.ts";
import type { UnifiedBlastRadiusReport } from "@graph/kg-blast-radius.ts";
import { scanSourceFiles } from "@graph/scanner.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { CANON_DIR, CANON_FILES, FILE_PREVIEW_MAX_LINES } from "@shared/constants.ts";
import {
  buildLayerInferrer,
  deriveSourceDirsFromLayers,
  loadLayerMappings,
} from "@shared/lib/config.ts";
import { isNotFound } from "@shared/lib/errors.ts";
import { loadPathAliases, toPosix } from "@shared/lib/paths.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { buildFileContextOutput } from "./file-context-assembler.ts";
import { applyFileContextDisclosure } from "./file-context-disclosure.ts";
import {
  type FileEntitySummary,
  type FileGraphMetrics,
  loadKgData,
} from "./get-file-context-kg.ts";

export type { FileEntitySummary, FileGraphMetrics };
// Re-export extracted structural-KG loaders/types for backward compatibility —
// existing tests and file-context-assembler.ts import these from this module.
export { loadKgData };

export type FileContextInput = {
  file_path: string;
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
  /** Git-history-derived hotspot score. Present when git intel data is available. */
  hotspot_score?: HotspotScoreOutput;
  /** Co-change partners from git history. Present when git intel data is available. */
  co_change_partners?: Array<CoChangePartner>;
  /** Computed tags from community detection and tag propagation pipeline. */
  computed_tags?: string[];
  /** When true, response was truncated due to size. Full data at full_data_path. */
  truncated?: boolean;
  /** Path to the full response JSON when truncated is true. */
  full_data_path?: string;
};

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
  if (!sourceDirs || sourceDirs.length === 0) return [];
  const dirResults = await Promise.all(
    sourceDirs.map(async (dir) => {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {});
      return files.map((f) => toPosix(join(dir, f)));
    }),
  );
  return dirResults.flat();
}

/** Mutable accumulator for compliance stats built from DriftStore reviews. */
type ComplianceAccumulator = {
  violation_count: number;
  last_verdict: string | null;
  violations: FileViolationDetail[];
  lastReviewedAt: string | null;
};

/** Extract violations applicable to filePath from a single review entry. */
function extractFileViolations(review: ReviewEntry, filePath: string): FileViolationDetail[] {
  const hasPerFile = review.violations.some((v) => v.file_path);
  const filtered = hasPerFile
    ? review.violations.filter((v) => v.file_path === filePath)
    : review.violations;
  return filtered.map((v) => ({
    principle_id: v.principle_id,
    severity: v.severity,
    ...(v.message !== undefined && { message: v.message }),
  }));
}

/** Accumulate compliance stats for one review entry into acc. */
function accumulateReviewEntry(
  review: ReviewEntry,
  filePath: string,
  acc: ComplianceAccumulator,
): void {
  if (!review.files.includes(filePath)) return;

  if (!acc.lastReviewedAt || review.timestamp > acc.lastReviewedAt) {
    acc.lastReviewedAt = review.timestamp;
    acc.last_verdict = review.verdict;
    acc.violations = extractFileViolations(review, filePath);
  }

  const hasPerFile = review.violations.some((v) => v.file_path);
  acc.violation_count += hasPerFile
    ? review.violations.filter((v) => v.file_path === filePath).length
    : review.violations.length;
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
  const acc: ComplianceAccumulator = {
    last_verdict: null,
    lastReviewedAt: null,
    violation_count: 0,
    violations: [],
  };

  try {
    const store = new DriftStore(projectDir);
    const reviews = await store.getReviews();
    for (const review of reviews) {
      accumulateReviewEntry(review, filePath, acc);
    }
  } catch (err) {
    // best-effort: compliance data is optional enrichment; primary file context still returned
    console.warn(
      "[canon] get-file-context: compliance data unavailable for",
      filePath,
      ":",
      err instanceof Error ? err.message : err,
    );
  }

  return {
    last_verdict: acc.last_verdict,
    violation_count: acc.violation_count,
    violations: acc.violations,
  };
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
  try {
    const otherFiles = allFiles.filter((f) => f !== filePath);
    const results = await Promise.all(
      otherFiles.map(async (otherFile) => {
        try {
          const imports = await fileImportsTarget(otherFile, filePath, options);
          return imports ? otherFile : null;
        } catch (err: unknown) {
          if (isNotFound(err)) return null;
          throw err;
        }
      }),
    );
    return results.filter((f): f is string => f !== null);
  } catch (err) {
    // best-effort: imported_by fallback scan is optional enrichment
    console.warn(
      "[canon] get-file-context: imported_by fallback scan failed for",
      filePath,
      ":",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
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

  // Lazily refresh the structural KG when HEAD moved (prunes deleted files,
  // re-stamps the marker). Fail-open: never throws, no-op when fresh. Also
  // covers the get_context composite, which reaches this function per file.
  await ensureGraphFresh(projectDir);

  const contentResult = await readFileContent(absPath, filePath);
  if (typeof contentResult !== "string") return contentResult;

  const layer = inferLayer(filePath) || "unknown";
  const exports = extractExports(contentResult, filePath);
  const { imports, imported_by } = await resolveFileRelationships(
    filePath,
    contentResult,
    projectDir,
  );
  const compliance = await loadComplianceData(projectDir, filePath);

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const kgData = existsSync(dbPath)
    ? loadKgData(dbPath, filePath, projectDir)
    : ({
        blast_radius: undefined,
        entities: undefined,
        graph_metrics: undefined,
        imported_by: [],
        project_max_impact: 0,
        summary: null,
      } as ReturnType<typeof loadKgData>);

  const output = buildFileContextOutput({
    compliance,
    content: contentResult,
    exports,
    filePath,
    imported_by,
    imports,
    inferLayer,
    kgData,
    layer,
    layerStack: Object.keys(layerMappings).sort(),
  });

  return toolOk(await applyFileContextDisclosure(output, projectDir));
}
