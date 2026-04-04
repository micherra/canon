import { readFile } from "node:fs/promises";
import path, { isAbsolute, join } from "node:path";
import { gitExecAsync } from "../adapters/git-adapter-async.ts";
import { CANON_DIR, CANON_FILES, extractSummary } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import { extractImports, type PathAlias, resolveImport } from "../graph/import-parser.ts";
import { type CodebaseInsights, generateInsights } from "../graph/insights.ts";
import { runPipeline } from "../graph/kg-pipeline.ts";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { buildNameMaps, classifyMdNode, inferMdRelations } from "../graph/md-relations.ts";
import { scanSourceFiles } from "../graph/scanner.ts";
import { loadAllPrinciples } from "../matcher.ts";
import {
  buildLayerInferrer,
  deriveSourceDirsFromLayers,
  loadGraphCompositionConfig,
  loadLayerMappings,
  loadLayerMappingsStrict,
} from "../utils/config.ts";
import { isNotFound } from "../utils/errors.ts";
import { sanitizeGitRef } from "../utils/git-ref.ts";
import { loadPathAliases, toPosix } from "../utils/paths.ts";

const FALLBACK_LAYER_COLOR = "#BDC3C7";

function colorFromLayerName(layer: string): string {
  // Deterministic hash-to-color mapping so custom layer names remain stable.
  let hash = 0;
  for (let i = 0; i < layer.length; i++) {
    hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 62%, 56%)`;
}

export type GraphNode = {
  id: string;
  layer: string;
  color: string;
  extension: string;
  violation_count: number;
  top_violations: string[];
  last_verdict: string | null;
  compliance_score: number | null;
  changed: boolean;
  kind?: string;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: "import" | "re-export" | "composition";
  confidence?: number;
  evidence?: string;
  origin?: "source-scan" | "inferred-llm";
  relation?: string;
};

export type CodebaseGraphInput = {
  root_dir?: string;
  source_dirs?: string[];
  include_extensions?: string[];
  exclude_dirs?: string[];
  diff_base?: string;
  changed_files?: string[];
  /** Controls graph resolution: 'file' (default) shows file-level nodes/edges,
   *  'entity' includes entity-level enrichment (counts, exports, dead code). */
  detail_level?: "file" | "entity";
};

export type CodebaseGraphOutput = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: Array<{ name: string; color: string; file_count: number; index: number }>;
  principles: Record<string, { title: string; severity: string; summary: string }>;
  insights: CodebaseInsights;
  generated_at: string;
};

async function gitCurrentBranch(cwd: string): Promise<string | null> {
  const result = await gitExecAsync(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function gitChangedFiles(cwd: string, base: string): Promise<string[]> {
  const result = await gitExecAsync(["diff", "--name-only", `${base}...HEAD`], cwd);
  if (!result.ok) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const result = await gitExecAsync(["rev-parse", "--verify", ref], cwd);
  return result.ok;
}

/** Scan project directories and return sorted file paths. */
/** Canon directories to scan for .md nodes (agents, flows, templates, principles). */
const CANON_SCAN_DIRS = ["agents", "flows", "templates", "principles", "commands"];

/** Scan files from configured source directories. */
async function scanFromSourceDirs(
  sourceDirs: string[],
  projectDir: string,
  input: CodebaseGraphInput,
): Promise<string[]> {
  const dirResults = await Promise.all(
    sourceDirs.map(async (dir) => {
      const absDir = join(projectDir, dir);
      const scanned = await scanSourceFiles(absDir, {
        excludeDirs: input.exclude_dirs,
        includeExtensions: input.include_extensions,
      });
      return scanned.map((f) => toPosix(join(dir, f)));
    }),
  );
  return dirResults.flat();
}

/** Scan files from a root directory fallback. */
async function scanFromRootDir(
  rootDir: string,
  projectDir: string,
  input: CodebaseGraphInput,
): Promise<string[]> {
  const abs = isAbsolute(rootDir);
  const resolvedDir = rootDir === "." || abs ? rootDir : join(projectDir, rootDir);
  const scanned = await scanSourceFiles(resolvedDir, {
    excludeDirs: input.exclude_dirs,
    includeExtensions: input.include_extensions,
  });
  const prefix = rootDir === "." || abs ? "" : rootDir;
  return prefix ? scanned.map((f) => toPosix(join(prefix, f))) : scanned.map(toPosix);
}

/** Scan Canon .md directories not covered by source dirs. */
async function scanCanonDirs(coveredDirs: Set<string>, projectDir: string): Promise<string[]> {
  const activeDirs = CANON_SCAN_DIRS.filter((d) => !coveredDirs.has(d));
  const dirResults = await Promise.all(
    activeDirs.map(async (canonDir) => {
      try {
        const absDir = join(projectDir, canonDir);
        const scanned = await scanSourceFiles(absDir, { includeExtensions: [".md"] });
        return scanned.map((f) => toPosix(join(canonDir, f)));
      } catch {
        /* Directory may not exist */
        return [];
      }
    }),
  );
  return dirResults.flat();
}

async function scanProjectFiles(input: CodebaseGraphInput, projectDir: string): Promise<string[]> {
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs;
  let baseFiles: string[] = [];

  if (sourceDirs && sourceDirs.length > 0) {
    baseFiles = await scanFromSourceDirs(sourceDirs, projectDir, input);
  } else if (input.root_dir) {
    baseFiles = await scanFromRootDir(input.root_dir, projectDir, input);
  }

  const coveredDirs = new Set((sourceDirs || []).map(toPosix));
  const canonFiles = await scanCanonDirs(coveredDirs, projectDir);
  baseFiles.push(...canonFiles);

  return Array.from(new Set(baseFiles)).sort();
}

/** Detect changed files via git diff or explicit input. */
/** Determine the diff base ref for changed-file detection. */
async function resolveDiffBase(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<string | null> {
  if (input.diff_base) return input.diff_base;
  if (await gitRefExists(projectDir, "origin/main")) return "origin/main";
  if (await gitRefExists(projectDir, "origin/master")) return "origin/master";
  return null;
}

async function detectChangedFiles(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<Set<string>> {
  if (input.changed_files && input.changed_files.length > 0) {
    return new Set(input.changed_files.map(toPosix));
  }

  const branch = await gitCurrentBranch(projectDir);
  if (!branch || branch === "main" || branch === "master") {
    return new Set<string>();
  }

  const rawBase = await resolveDiffBase(input, projectDir);
  if (!rawBase) return new Set<string>();

  let base: string;
  try {
    base = sanitizeGitRef(rawBase);
  } catch {
    console.warn(
      `codebase-graph: invalid diff_base "${rawBase}" — skipping changed-file detection`,
    );
    return new Set<string>();
  }

  const changedFiles = await gitChangedFiles(projectDir, base);
  return new Set(changedFiles.map(toPosix));
}

/** Per-file compliance overlay data. */
type ComplianceOverlay = {
  fileViolations: Map<string, Map<string, number>>;
  fileVerdicts: Map<string, { timestamp: string; verdict: string }>;
};

/** Update file verdicts map from a single review. */
function updateFileVerdicts(
  review: { files: string[]; timestamp: string; verdict: string },
  fileVerdicts: Map<string, { timestamp: string; verdict: string }>,
): void {
  for (const file of review.files) {
    const existing = fileVerdicts.get(file);
    if (!existing || review.timestamp > existing.timestamp) {
      fileVerdicts.set(file, { timestamp: review.timestamp, verdict: review.verdict });
    }
  }
}

/** Accumulate violation counts from a single review. */
function accumulateViolations(
  review: { files: string[]; violations: Array<{ file_path?: string; principle_id: string }> },
  fileViolations: Map<string, Map<string, number>>,
): void {
  for (const v of review.violations) {
    const targetFile = v.file_path || review.files[0];
    if (!targetFile) continue;
    if (!fileViolations.has(targetFile)) fileViolations.set(targetFile, new Map());
    const counts = fileViolations.get(targetFile)!;
    counts.set(v.principle_id, (counts.get(v.principle_id) || 0) + 1);
  }
}

/** Build per-file violation counts and verdicts from reviews. */
async function buildComplianceOverlay(projectDir: string): Promise<ComplianceOverlay> {
  const store = new DriftStore(projectDir);
  const reviews = await store.getReviews();
  const fileViolations = new Map<string, Map<string, number>>();
  const fileVerdicts = new Map<string, { timestamp: string; verdict: string }>();

  for (const review of reviews) {
    updateFileVerdicts(review, fileVerdicts);
    accumulateViolations(review, fileViolations);
  }

  return { fileVerdicts, fileViolations };
}

/** Options for building a single GraphNode. */
type BuildGraphNodeOptions = {
  layerColors: Record<string, string>;
  changedSet: Set<string>;
  overlay: ComplianceOverlay;
};

/** Build a single GraphNode from a file path and compliance data. */
function buildGraphNode(
  filePath: string,
  layer: string,
  options: BuildGraphNodeOptions,
): GraphNode {
  const { layerColors, changedSet, overlay } = options;
  const violations = overlay.fileViolations.get(filePath);
  const violationCount = violations
    ? Array.from(violations.values()).reduce((a, b) => a + b, 0)
    : 0;
  const topViolations = violations
    ? Array.from(violations.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id)
    : [];

  const node: GraphNode = {
    changed: changedSet.has(filePath),
    color: layerColors[layer] || FALLBACK_LAYER_COLOR,
    compliance_score: null,
    extension: filePath.split(".").pop() || "",
    id: filePath,
    last_verdict: overlay.fileVerdicts.get(filePath)?.verdict || null,
    layer,
    top_violations: topViolations,
    violation_count: violationCount,
  };
  const kind = classifyMdNode(filePath);
  if (kind) node.kind = kind;
  return node;
}

/** Options for building graph nodes. */
type BuildNodesOptions = {
  inferLayer: (filePath: string) => string;
  layerColors: Record<string, string>;
  changedSet: Set<string>;
};

/** Build graph nodes from file paths, enriched with compliance data. */
async function buildNodes(
  filePaths: string[],
  projectDir: string,
  options: BuildNodesOptions,
): Promise<{ nodes: GraphNode[]; layerCounts: Map<string, number> }> {
  const { inferLayer, layerColors, changedSet } = options;
  const overlay = await buildComplianceOverlay(projectDir);
  const nodes: GraphNode[] = [];
  const layerCounts = new Map<string, number>();

  for (const filePath of filePaths) {
    const layer = inferLayer(filePath) || "unknown";
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
    nodes.push(buildGraphNode(filePath, layer, { changedSet, layerColors, overlay }));
  }

  return { layerCounts, nodes };
}

/** Build import edges by reading each file and resolving imports. */
async function buildEdges(
  filePaths: string[],
  fileSet: Set<string>,
  aliases: PathAlias[],
  projectDir: string,
): Promise<GraphEdge[]> {
  const fileEdges = await Promise.all(
    filePaths.map(async (filePath): Promise<GraphEdge[]> => {
      try {
        const content = await readFile(join(projectDir, filePath), "utf-8");
        const imports = extractImports(content, filePath);
        return imports
          .map((imp) => resolveImport(imp, filePath, fileSet, aliases))
          .filter((resolved): resolved is string => resolved !== null && resolved !== filePath)
          .map((resolved) => ({ source: filePath, target: resolved, type: "import" as const }));
      } catch (err: unknown) {
        if (isNotFound(err)) return [];
        throw err;
      }
    }),
  );
  return fileEdges.flat();
}

function shouldInspectForComposition(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some((pattern) => lower.endsWith(pattern.toLowerCase()));
}

/** Try to find a candidate path in the file set, including with common extensions. */
function findInFileSet(candidate: string, fileSet: Set<string>): string | null {
  if (fileSet.has(candidate)) return candidate;
  for (const ext of [".md", ".yaml", ".yml", ".json"]) {
    if (fileSet.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  return null;
}

function resolveCompositionTarget(
  rawRef: string,
  sourcePath: string,
  fileSet: Set<string>,
): string | null {
  const normalized = toPosix(rawRef.trim().replace(/^['"]|['"]$/g, ""));
  if (!normalized) return null;

  const candidates = new Set<string>();
  candidates.add(normalized);
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    const sourceDir = sourcePath.split("/").slice(0, -1).join("/");
    candidates.add(toPosix(join(sourceDir, normalized)));
  }
  candidates.add(normalized.replace(/^\.?\//, ""));

  for (const candidate of candidates) {
    const found = findInFileSet(candidate, fileSet);
    if (found) return found;
  }
  return null;
}

/** Options for upserting a composition edge. */
type UpsertCompositionEdgeOptions = {
  fileSet: Set<string>;
  confidence: number;
  minConfidence: number;
  evidence: string;
};

/** Try to add or update a composition edge in the edge map. */
function upsertCompositionEdge(
  edgesByKey: Map<string, GraphEdge>,
  source: string,
  rawRef: string,
  options: UpsertCompositionEdgeOptions,
): void {
  const { fileSet, confidence, minConfidence, evidence } = options;
  const target = resolveCompositionTarget(rawRef, source, fileSet);
  if (!target || target === source) return;
  if (confidence < minConfidence) return;
  const key = `${source}|${target}|composition`;
  const existing = edgesByKey.get(key);
  if (!existing || (existing.confidence || 0) < confidence) {
    edgesByKey.set(key, {
      confidence,
      evidence: evidence.trim().slice(0, 140),
      origin: "inferred-llm",
      source,
      target,
      type: "composition",
    });
  }
}

/** Options for extracting composition edges from file content. */
type ExtractCompositionOptions = {
  fileSet: Set<string>;
  markerRegex: RegExp | null;
  maxRefs: number;
  minConfidence: number;
  edgesByKey: Map<string, GraphEdge>;
};

/** Extract composition edges from a single file's content using marker and interpolation regexes. */
function extractCompositionEdgesFromContent(
  filePath: string,
  content: string,
  options: ExtractCompositionOptions,
): void {
  const { fileSet, markerRegex, maxRefs, minConfidence, edgesByKey } = options;
  let refCount = 0;

  if (markerRegex) {
    markerRegex.lastIndex = 0;
    let match = markerRegex.exec(content);
    while (match !== null) {
      if (refCount >= maxRefs) return;
      refCount += 1;
      upsertCompositionEdge(edgesByKey, filePath, match[1], {
        confidence: 0.9,
        evidence: match[0],
        fileSet,
        minConfidence,
      });
      match = markerRegex.exec(content);
    }
  }

  const interpolationRegex = /\{\{\s*([\w./-]+)\s*\}\}/g;
  let interpolationMatch = interpolationRegex.exec(content);
  while (interpolationMatch !== null) {
    if (refCount >= maxRefs) return;
    refCount += 1;
    upsertCompositionEdge(edgesByKey, filePath, interpolationMatch[1], {
      confidence: 0.75,
      evidence: interpolationMatch[0],
      fileSet,
      minConfidence,
    });
    interpolationMatch = interpolationRegex.exec(content);
  }
}

async function buildCompositionEdges(
  filePaths: string[],
  fileSet: Set<string>,
  projectDir: string,
): Promise<GraphEdge[]> {
  const compositionConfig = await loadGraphCompositionConfig(projectDir);
  if (!compositionConfig.enabled) return [];

  const markerAlternation = compositionConfig.markers
    .map((marker: string) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const markerRegex =
    markerAlternation.length > 0
      ? new RegExp(`(?:${markerAlternation})\\s*[:=]\\s*["']?([\\w./-]+)["']?`, "gi")
      : null;

  const activePaths = filePaths.filter((fp) =>
    shouldInspectForComposition(fp, compositionConfig.file_patterns),
  );

  const perFileEdges = await Promise.all(
    activePaths.map(async (filePath) => {
      let content = "";
      try {
        content = await readFile(join(projectDir, filePath), "utf-8");
      } catch (err: unknown) {
        if (isNotFound(err)) return new Map<string, GraphEdge>();
        throw err;
      }
      const edgesByKey = new Map<string, GraphEdge>();
      extractCompositionEdgesFromContent(filePath, content, {
        edgesByKey,
        fileSet,
        markerRegex,
        maxRefs: compositionConfig.max_refs_per_file,
        minConfidence: compositionConfig.min_confidence,
      });
      return edgesByKey;
    }),
  );

  const merged = new Map<string, GraphEdge>();
  for (const fileMap of perFileEdges) {
    for (const [key, edge] of fileMap) {
      if (!merged.has(key)) merged.set(key, edge);
    }
  }
  return Array.from(merged.values());
}

function mergeEdges(baseEdges: GraphEdge[], inferredEdges: GraphEdge[]): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();
  for (const edge of baseEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    byKey.set(key, edge);
  }
  for (const edge of inferredEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, edge);
      continue;
    }
    if ((edge.confidence || 0) > (existing.confidence || 0)) {
      byKey.set(key, edge);
    }
  }
  return Array.from(byKey.values());
}

type StructuralPrincipleIds = {
  layerBoundary: string;
  circularDep: string;
};

/** Build a map of source file -> layer violation count from insights. */
function buildLayerViolationMap(insights: CodebaseInsights): Map<string, number> {
  const map = new Map<string, number>();
  for (const lv of insights.layer_violations) {
    map.set(lv.source, (map.get(lv.source) || 0) + 1);
  }
  return map;
}

/** Build a set of all nodes that participate in circular dependencies. */
function buildCycleMemberSet(insights: CodebaseInsights): Set<string> {
  const set = new Set<string>();
  for (const cycle of insights.circular_dependencies) {
    for (const node of cycle) set.add(node);
  }
  return set;
}

/** Fold structural violations (layer crossings, cycles) into node violation counts. */
function enrichNodesWithInsights(
  nodes: GraphNode[],
  insights: CodebaseInsights,
  principleIds: StructuralPrincipleIds,
): void {
  const layerViolationsBySource = buildLayerViolationMap(insights);
  const cycleMembers = buildCycleMemberSet(insights);

  for (const node of nodes) {
    const lvCount = layerViolationsBySource.get(node.id) || 0;
    if (lvCount > 0) {
      node.violation_count += lvCount;
      if (!node.top_violations.includes(principleIds.layerBoundary)) {
        node.top_violations.push(principleIds.layerBoundary);
      }
    }
    if (cycleMembers.has(node.id)) {
      node.violation_count += 1;
      if (!node.top_violations.includes(principleIds.circularDep)) {
        node.top_violations.push(principleIds.circularDep);
      }
    }
  }
}

/** Map DB edge type string to GraphEdge type. */
function mapEdgeType(edgeType: string): GraphEdge["type"] {
  if (edgeType === "imports") return "import";
  if (edgeType === "re-exports") return "re-export";
  if (edgeType === "composition") return "composition";
  return "import";
}

type RawGraphData = {
  rawNodes: Array<{ id: string; layer: string; extension: string }>;
  rawEdges: Array<{
    source: string;
    target: string;
    type: GraphEdge["type"];
    confidence: number;
    relation?: string;
  }>;
};

/** Read raw nodes and edges from the KG database. */
function readRawGraphFromDb(dbPath: string): RawGraphData {
  const db = initDatabase(dbPath);
  try {
    const kgQuery = new KgQuery(db);
    const filesWithStats = kgQuery.getAllFilesWithStats();
    const rawNodes = filesWithStats
      .filter((f) => f.file_id !== undefined)
      .map((f) => ({
        extension: path.extname(f.path).replace(".", "") || "",
        id: f.path,
        layer: f.layer || "unknown",
      }));

    const fileEdgeRows = db
      .prepare(`
      SELECT fe.edge_type, fe.confidence, fe.relation,
             src.path AS source_path, tgt.path AS target_path
      FROM file_edges fe
      JOIN files src ON src.file_id = fe.source_file_id
      JOIN files tgt ON tgt.file_id = fe.target_file_id
    `)
      .all() as Array<{
      edge_type: string;
      confidence: number;
      relation: string | null;
      source_path: string;
      target_path: string;
    }>;

    const rawEdges = fileEdgeRows.map((row) => ({
      confidence: row.confidence,
      relation: row.relation ?? undefined,
      source: row.source_path,
      target: row.target_path,
      type: mapEdgeType(row.edge_type),
    }));

    return { rawEdges, rawNodes };
  } finally {
    db.close();
  }
}

/** Filter nodes and edges to the requested scope. */
function filterToScope(
  rawNodes: RawGraphData["rawNodes"],
  rawEdges: RawGraphData["rawEdges"],
  requestedFileSet: Set<string>,
): { filteredNodes: RawGraphData["rawNodes"]; filteredEdges: RawGraphData["rawEdges"] } {
  const filteredNodes = rawNodes.filter(
    (n) => requestedFileSet.size === 0 || requestedFileSet.has(n.id),
  );
  const filteredNodeSet = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = rawEdges.filter(
    (e) => filteredNodeSet.has(e.source) && filteredNodeSet.has(e.target),
  );
  return { filteredEdges, filteredNodes };
}

/** Load layer config with strict fallback. */
async function loadLayerConfig(projectDir: string): Promise<{
  layerMappings: Awaited<ReturnType<typeof loadLayerMappingsStrict>>;
  layerEntries: string[];
  layerColors: Record<string, string>;
  inferLayer: ReturnType<typeof buildLayerInferrer>;
}> {
  let layerMappings: Awaited<ReturnType<typeof loadLayerMappingsStrict>>;
  try {
    layerMappings = await loadLayerMappingsStrict(projectDir);
  } catch {
    layerMappings = await loadLayerMappings(projectDir);
  }
  const layerEntries = Object.keys(layerMappings);
  const layerColors: Record<string, string> = {};
  for (const layer of layerEntries) layerColors[layer] = colorFromLayerName(layer);
  layerColors.unknown = FALLBACK_LAYER_COLOR;
  return {
    inferLayer: buildLayerInferrer(layerMappings),
    layerColors,
    layerEntries,
    layerMappings,
  };
}

/** Options for building the final graph output. */
type BuildGraphOutputOptions = {
  layerEntries: string[];
  layerColors: Record<string, string>;
  allPrinciples: Awaited<ReturnType<typeof loadAllPrinciples>>;
};

/** Build the final graph output from nodes, edges, principles, and insights. */
function buildGraphOutput(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: BuildGraphOutputOptions,
): CodebaseGraphOutput {
  const { layerEntries, layerColors, allPrinciples } = options;
  const structuralIds: StructuralPrincipleIds = {
    circularDep:
      allPrinciples.find((p) => p.tags.includes("architecture"))?.id ?? "circular-dependency",
    layerBoundary:
      allPrinciples.find((p) => p.tags.includes("boundaries"))?.id ?? "layer-boundary-crossing",
  };

  const insights = generateInsights(
    nodes.map((n) => ({ id: n.id, layer: n.layer })),
    edges.map((e) => ({ source: e.source, target: e.target })),
  );
  enrichNodesWithInsights(nodes, insights, structuralIds);

  const layerCounts = new Map<string, number>();
  for (const node of nodes) layerCounts.set(node.layer, (layerCounts.get(node.layer) || 0) + 1);

  const layerIndex = new Map<string, number>();
  for (const [idx, layer] of layerEntries.entries()) layerIndex.set(layer, idx);
  if (layerCounts.has("unknown")) layerIndex.set("unknown", layerEntries.length);

  const layers = Array.from(layerCounts.entries())
    .map(([name, file_count]) => ({
      color: layerColors[name] || FALLBACK_LAYER_COLOR,
      file_count,
      index: layerIndex.get(name) ?? Number.MAX_SAFE_INTEGER,
      name,
    }))
    .sort((a, b) => a.index - b.index || b.file_count - a.file_count);

  const principles: Record<string, { title: string; severity: string; summary: string }> = {};
  for (const p of allPrinciples) {
    principles[p.id] = { severity: p.severity, summary: extractSummary(p.body), title: p.title };
  }

  return { edges, generated_at: new Date().toISOString(), insights, layers, nodes, principles };
}

/** Build supplemental edges from legacy scanners (aliases, composition, markdown). */
async function buildSupplementalEdges(
  filePaths: string[],
  fileSet: Set<string>,
  projectDir: string,
): Promise<GraphEdge[]> {
  const aliases = await loadPathAliases(projectDir);
  const importEdges = await buildEdges(filePaths, fileSet, aliases, projectDir);
  const compositionEdges = await buildCompositionEdges(filePaths, fileSet, projectDir);
  const nameMaps = await buildNameMaps(filePaths, projectDir);
  const mdEdges = await inferMdRelations(filePaths, fileSet, nameMaps, projectDir);
  return mergeEdges(importEdges, mergeEdges(compositionEdges, mdEdges));
}

export async function codebaseGraph(
  input: CodebaseGraphInput,
  projectDir: string,
  pluginDir: string,
): Promise<CodebaseGraphOutput> {
  const { layerEntries, layerColors, inferLayer } = await loadLayerConfig(projectDir);

  const requestedFilePaths = await scanProjectFiles(input, projectDir);
  const requestedFileSet = new Set(requestedFilePaths);
  const changedSet = await detectChangedFiles(input, projectDir);

  let nodes: GraphNode[];
  let edges: GraphEdge[];

  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const pipelineSourceDirs = explicitSourceDirs || configSourceDirs || undefined;

  try {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    await runPipeline(projectDir, { dbPath, sourceDirs: pipelineSourceDirs });

    const { rawNodes, rawEdges } = readRawGraphFromDb(dbPath);
    const { filteredNodes, filteredEdges } = filterToScope(rawNodes, rawEdges, requestedFileSet);
    const supplementEdges = await buildSupplementalEdges(
      requestedFilePaths,
      requestedFileSet,
      projectDir,
    );
    const overlay = await buildComplianceOverlay(projectDir);

    nodes = filteredNodes.map((n) => {
      const layer = inferLayer(n.id) || n.layer || "unknown";
      return buildGraphNode(n.id, layer, { changedSet, layerColors, overlay });
    });
    edges = mergeEdges(filteredEdges, supplementEdges);
  } catch (pipelineErr) {
    console.warn(
      `[codebase-graph] pipeline unavailable, using legacy scanner: ${(pipelineErr as Error).message}`,
    );
    const { nodes: legacyNodes } = await buildNodes(requestedFilePaths, projectDir, {
      changedSet,
      inferLayer,
      layerColors,
    });
    nodes = legacyNodes;
    edges = await buildSupplementalEdges(requestedFilePaths, requestedFileSet, projectDir);
  }

  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  return buildGraphOutput(nodes, edges, { allPrinciples, layerColors, layerEntries });
}

/**
 * Read and format the codebase graph from an existing KG DB without re-running the pipeline.
 *
 * This is the read-only path used by codebase_graph_materialize after the background job
 * has already populated the DB. Skips runPipeline — assumes the DB is current.
 *
 * Steps: load layer config → scan requested files → detect changed files →
 *        read nodes/edges from DB → apply compliance overlay → load principles →
 *        generate insights → return CodebaseGraphOutput.
 */
export async function readGraphFromDb(
  input: CodebaseGraphInput,
  projectDir: string,
  pluginDir: string,
): Promise<CodebaseGraphOutput> {
  const { layerEntries, layerColors, inferLayer } = await loadLayerConfig(projectDir);

  const requestedFilePaths = await scanProjectFiles(input, projectDir);
  const requestedFileSet = new Set(requestedFilePaths);
  const changedSet = await detectChangedFiles(input, projectDir);

  let nodes: GraphNode[];
  let edges: GraphEdge[];

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

  try {
    const { rawNodes, rawEdges } = readRawGraphFromDb(dbPath);
    const { filteredNodes, filteredEdges } = filterToScope(rawNodes, rawEdges, requestedFileSet);

    const overlay = await buildComplianceOverlay(projectDir);
    nodes = filteredNodes.map((n) => {
      const layer = inferLayer(n.id) || n.layer || "unknown";
      return buildGraphNode(n.id, layer, { changedSet, layerColors, overlay });
    });
    edges = filteredEdges;
  } catch {
    const { nodes: legacyNodes } = await buildNodes(requestedFilePaths, projectDir, {
      changedSet,
      inferLayer,
      layerColors,
    });
    const aliases = await loadPathAliases(projectDir);
    const importEdges = await buildEdges(requestedFilePaths, requestedFileSet, aliases, projectDir);
    const compositionEdges = await buildCompositionEdges(
      requestedFilePaths,
      requestedFileSet,
      projectDir,
    );
    const nameMaps = await buildNameMaps(requestedFilePaths, projectDir);
    const mdEdges = await inferMdRelations(
      requestedFilePaths,
      requestedFileSet,
      nameMaps,
      projectDir,
    );
    nodes = legacyNodes;
    edges = mergeEdges(importEdges, mergeEdges(compositionEdges, mdEdges));
  }

  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);

  return buildGraphOutput(nodes, edges, { allPrinciples, layerColors, layerEntries });
}

/** Compact summary for MCP response — full graph is on disk. */
export function summarizeGraph(graph: CodebaseGraphOutput) {
  const violationFiles = graph.nodes
    .filter((n) => n.violation_count > 0)
    .sort((a, b) => b.violation_count - a.violation_count)
    .slice(0, 10)
    .map((n) => ({
      path: n.id,
      top_violations: n.top_violations,
      violation_count: n.violation_count,
    }));

  return {
    generated_at: graph.generated_at,
    insights: graph.insights,
    layers: graph.layers,
    total_edges: graph.edges.length,
    total_nodes: graph.nodes.length,
    violations: violationFiles,
  };
}

/** Index-encoded compact graph for the UI.
 *  Node IDs are replaced with numeric indices to avoid repeating long file paths
 *  in the edge list. Scales to large codebases — ~37K for 316 nodes vs 237K raw. */
export type CompactGraphOutput = {
  /** Ordered node IDs — index in this array is the numeric key used in edges/nodes. */
  node_ids: string[];
  /** Per-node data (same order as node_ids). Only non-default fields included. */
  nodes: Array<{
    /** layer name */
    l: string;
    /** violation count (omitted when 0) */
    v?: number;
    /** top violation IDs (omitted when empty) */
    t?: string[];
    /** changed flag (omitted when false) */
    c?: boolean;
    /** node kind e.g. "agent", "flow" (omitted when absent) */
    k?: string;
  }>;
  /** Edges as [sourceIndex, targetIndex] pairs. */
  edges: [number, number][];
  layers: CodebaseGraphOutput["layers"];
  generated_at: string;
  /** Signals this is index-encoded so the UI knows to decode. */
  _compact: true;
};

export function compactGraph(graph: CodebaseGraphOutput): CompactGraphOutput {
  const nodeIds = graph.nodes.map((n) => n.id);
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < nodeIds.length; i++) idToIndex.set(nodeIds[i], i);

  const nodes = graph.nodes.map((n) => {
    const compact: CompactGraphOutput["nodes"][number] = { l: n.layer };
    if (n.violation_count) compact.v = n.violation_count;
    if (n.top_violations?.length) compact.t = n.top_violations;
    if (n.changed) compact.c = true;
    if (n.kind) compact.k = n.kind;
    return compact;
  });

  const edges: [number, number][] = [];
  for (const e of graph.edges) {
    const si = idToIndex.get(e.source);
    const ti = idToIndex.get(e.target);
    if (si !== undefined && ti !== undefined) edges.push([si, ti]);
  }

  return {
    _compact: true,
    edges,
    generated_at: graph.generated_at,
    layers: graph.layers,
    node_ids: nodeIds,
    nodes,
  };
}
