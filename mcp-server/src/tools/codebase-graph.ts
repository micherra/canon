import { readFile, mkdir } from "fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.ts";
import { join, isAbsolute } from "path";
import { gitExecAsync } from "../adapters/git-adapter-async.ts";
import { scanSourceFiles } from "../graph/scanner.ts";
import { extractImports, resolveImport, type PathAlias } from "../graph/import-parser.ts";
import { loadAllPrinciples } from "../matcher.ts";
import { DriftStore } from "../drift/store.ts";
import { generateInsights, type CodebaseInsights } from "../graph/insights.ts";
import {
  deriveSourceDirsFromLayers,
  loadLayerMappings,
  loadLayerMappingsStrict,
  buildLayerInferrer,
  loadGraphCompositionConfig,
} from "../utils/config.ts";
import { isNotFound } from "../utils/errors.ts";
import { extractSummary, CANON_DIR, CANON_FILES } from "../constants.ts";
import { toPosix, loadPathAliases } from "../utils/paths.ts";
import { sanitizeGitRef } from "../utils/git-ref.ts";
import { classifyMdNode, buildNameMaps, inferMdRelations } from "../graph/md-relations.ts";
import { runPipeline } from "../graph/kg-pipeline.ts";
import { materialize } from "../graph/view-materializer.ts";
import { initDatabase } from "../graph/kg-schema.ts";

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

export interface GraphNode {
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
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "import" | "re-export" | "composition";
  confidence?: number;
  evidence?: string;
  origin?: "source-scan" | "inferred-llm";
  relation?: string;
}

export interface CodebaseGraphInput {
  root_dir?: string;
  source_dirs?: string[];
  include_extensions?: string[];
  exclude_dirs?: string[];
  diff_base?: string;
  changed_files?: string[];
  /** Controls graph resolution: 'file' (default) shows file-level nodes/edges,
   *  'entity' includes entity-level enrichment (counts, exports, dead code). */
  detail_level?: "file" | "entity";
}

export interface CodebaseGraphOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: Array<{ name: string; color: string; file_count: number; index: number }>;
  principles: Record<string, { title: string; severity: string; summary: string }>;
  insights: CodebaseInsights;
  generated_at: string;
}

// ── Git helpers ──

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

// ── Graph building steps ──

/** Scan project directories and return sorted file paths. */
/** Canon directories to scan for .md nodes (agents, flows, templates, principles). */
const CANON_SCAN_DIRS = ["agents", "flows", "templates", "principles", "commands"];

async function scanProjectFiles(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<string[]> {
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs;
  let baseFiles: string[] = [];

  if (sourceDirs && sourceDirs.length > 0) {
    for (const dir of sourceDirs) {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {
        includeExtensions: input.include_extensions,
        excludeDirs: input.exclude_dirs,
      });
      for (const f of files) baseFiles.push(toPosix(join(dir, f)));
    }
  } else if (input.root_dir) {
    const abs = isAbsolute(input.root_dir);
    const rootDir = input.root_dir === "." || abs ? input.root_dir : join(projectDir, input.root_dir);
    const scanned = await scanSourceFiles(rootDir, {
      includeExtensions: input.include_extensions,
      excludeDirs: input.exclude_dirs,
    });
    const prefix = (input.root_dir === "." || abs) ? "" : input.root_dir;
    baseFiles = prefix
      ? scanned.map((f) => toPosix(join(prefix, f)))
      : scanned.map(toPosix);
  }

  // Scan Canon .md directories that may not be under source_dirs
  const coveredDirs = new Set((sourceDirs || []).map(toPosix));
  for (const canonDir of CANON_SCAN_DIRS) {
    if (coveredDirs.has(canonDir)) continue;
    try {
      const absDir = join(projectDir, canonDir);
      const files = await scanSourceFiles(absDir, {
        includeExtensions: [".md"],
      });
      for (const f of files) baseFiles.push(toPosix(join(canonDir, f)));
    } catch {
      // Directory may not exist — skip
    }
  }

  return Array.from(new Set(baseFiles)).sort();
}

/** Detect changed files via git diff or explicit input. */
async function detectChangedFiles(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<Set<string>> {
  let changedFiles = input.changed_files || [];
  if (changedFiles.length === 0) {
    const branch = await gitCurrentBranch(projectDir);
    if (branch && branch !== "main" && branch !== "master") {
      const rawBase = input.diff_base
        || (await gitRefExists(projectDir, "origin/main") ? "origin/main"
        : (await gitRefExists(projectDir, "origin/master") ? "origin/master" : null));
      if (rawBase) {
        const base = sanitizeGitRef(rawBase);
        changedFiles = await gitChangedFiles(projectDir, base);
      }
    }
  }
  return new Set(changedFiles.map(toPosix));
}

/** Build graph nodes from file paths, enriched with compliance data. */
async function buildNodes(
  filePaths: string[],
  inferLayer: (filePath: string) => string,
  layerColors: Record<string, string>,
  changedSet: Set<string>,
  projectDir: string,
): Promise<{ nodes: GraphNode[]; layerCounts: Map<string, number> }> {
  const store = new DriftStore(projectDir);
  const reviews = await store.getReviews();

  // Per-file violation counts and verdicts
  const fileViolations = new Map<string, Map<string, number>>();
  const fileVerdicts = new Map<string, { timestamp: string; verdict: string }>();
  for (const review of reviews) {
    for (const file of review.files) {
      const existing = fileVerdicts.get(file);
      if (!existing || review.timestamp > existing.timestamp) {
        fileVerdicts.set(file, { timestamp: review.timestamp, verdict: review.verdict });
      }
    }
    for (const v of review.violations) {
      const targetFile = v.file_path || review.files[0];
      if (!targetFile) continue;
      if (!fileViolations.has(targetFile)) fileViolations.set(targetFile, new Map());
      const counts = fileViolations.get(targetFile)!;
      counts.set(v.principle_id, (counts.get(v.principle_id) || 0) + 1);
    }
  }

  const nodes: GraphNode[] = [];
  const layerCounts = new Map<string, number>();

  for (const filePath of filePaths) {
    const layer = inferLayer(filePath) || "unknown";
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);

    const violations = fileViolations.get(filePath);
    const violationCount = violations
      ? Array.from(violations.values()).reduce((a, b) => a + b, 0) : 0;
    const topViolations = violations
      ? Array.from(violations.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
      : [];

    const node: GraphNode = {
      id: filePath,
      layer,
      color: layerColors[layer] || FALLBACK_LAYER_COLOR,
      extension: filePath.split(".").pop() || "",
      violation_count: violationCount,
      top_violations: topViolations,
      last_verdict: fileVerdicts.get(filePath)?.verdict || null,
      compliance_score: null,
      changed: changedSet.has(filePath),
    };
    const kind = classifyMdNode(filePath);
    if (kind) node.kind = kind;
    nodes.push(node);
  }

  return { nodes, layerCounts };
}

/** Build import edges by reading each file and resolving imports. */
async function buildEdges(
  filePaths: string[],
  fileSet: Set<string>,
  aliases: PathAlias[],
  projectDir: string,
): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  for (const filePath of filePaths) {
    try {
      const content = await readFile(join(projectDir, filePath), "utf-8");
      const imports = extractImports(content, filePath);
      for (const imp of imports) {
        const resolved = resolveImport(imp, filePath, fileSet, aliases);
        if (resolved && resolved !== filePath) {
          edges.push({ source: filePath, target: resolved, type: "import" });
        }
      }
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
  return edges;
}

function shouldInspectForComposition(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some((pattern) => lower.endsWith(pattern.toLowerCase()));
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
    const sourceParts = sourcePath.split("/");
    sourceParts.pop();
    const baseParts = sourceParts.join("/");
    const joined = toPosix(join(baseParts, normalized));
    candidates.add(joined);
  }
  candidates.add(normalized.replace(/^\.?\//, ""));

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
    const withMd = `${candidate}.md`;
    const withYaml = `${candidate}.yaml`;
    const withYml = `${candidate}.yml`;
    const withJson = `${candidate}.json`;
    if (fileSet.has(withMd)) return withMd;
    if (fileSet.has(withYaml)) return withYaml;
    if (fileSet.has(withYml)) return withYml;
    if (fileSet.has(withJson)) return withJson;
  }
  return null;
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
  const markerRegex = markerAlternation.length > 0
    ? new RegExp(`(?:${markerAlternation})\\s*[:=]\\s*["']?([\\w./-]+)["']?`, "gi")
    : null;

  const edgesByKey = new Map<string, GraphEdge>();
  for (const filePath of filePaths) {
    if (!shouldInspectForComposition(filePath, compositionConfig.file_patterns)) continue;

    let content = "";
    try {
      content = await readFile(join(projectDir, filePath), "utf-8");
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }

    let refCount = 0;
    if (markerRegex) {
      markerRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = markerRegex.exec(content)) !== null) {
        if (refCount >= compositionConfig.max_refs_per_file) break;
        refCount += 1;

        const rawRef = match[1];
        const target = resolveCompositionTarget(rawRef, filePath, fileSet);
        if (!target || target === filePath) continue;

        const confidence = 0.9;
        if (confidence < compositionConfig.min_confidence) continue;
        const key = `${filePath}|${target}|composition`;
        const existing = edgesByKey.get(key);
        if (!existing || (existing.confidence || 0) < confidence) {
          edgesByKey.set(key, {
            source: filePath,
            target,
            type: "composition",
            confidence,
            evidence: match[0].trim().slice(0, 140),
            origin: "inferred-llm",
          });
        }
      }
    }

    const interpolationRegex = /\{\{\s*([\w./-]+)\s*\}\}/g;
    let interpolationMatch: RegExpExecArray | null;
    while ((interpolationMatch = interpolationRegex.exec(content)) !== null) {
      if (refCount >= compositionConfig.max_refs_per_file) break;
      refCount += 1;
      const rawRef = interpolationMatch[1];
      const target = resolveCompositionTarget(rawRef, filePath, fileSet);
      if (!target || target === filePath) continue;
      const confidence = 0.75;
      if (confidence < compositionConfig.min_confidence) continue;
      const key = `${filePath}|${target}|composition`;
      const existing = edgesByKey.get(key);
      if (!existing || (existing.confidence || 0) < confidence) {
        edgesByKey.set(key, {
          source: filePath,
          target,
          type: "composition",
          confidence,
          evidence: interpolationMatch[0].trim().slice(0, 140),
          origin: "inferred-llm",
        });
      }
    }
  }
  return Array.from(edgesByKey.values());
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

interface StructuralPrincipleIds {
  layerBoundary: string;
  circularDep: string;
}

/** Fold structural violations (layer crossings, cycles) into node violation counts. */
function enrichNodesWithInsights(
  nodes: GraphNode[],
  insights: CodebaseInsights,
  principleIds: StructuralPrincipleIds,
): void {
  const layerViolationsBySource = new Map<string, number>();
  for (const lv of insights.layer_violations) {
    layerViolationsBySource.set(lv.source, (layerViolationsBySource.get(lv.source) || 0) + 1);
  }
  const cycleMembers = new Set<string>();
  for (const cycle of insights.circular_dependencies) {
    for (const node of cycle) cycleMembers.add(node);
  }
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

// ── Main entry point ──

export async function codebaseGraph(
  input: CodebaseGraphInput,
  projectDir: string,
  pluginDir: string
): Promise<CodebaseGraphOutput> {
  // Load layer mappings — fall back to non-strict defaults when layers are not
  // configured so the tool always produces output instead of hanging.
  let layerMappings: Awaited<ReturnType<typeof loadLayerMappingsStrict>>;
  try {
    layerMappings = await loadLayerMappingsStrict(projectDir);
  } catch {
    layerMappings = await loadLayerMappings(projectDir);
  }
  const layerEntries = Object.keys(layerMappings);
  const layerColors: Record<string, string> = {};
  for (const layer of layerEntries) {
    layerColors[layer] = colorFromLayerName(layer);
  }
  layerColors.unknown = FALLBACK_LAYER_COLOR;
  const inferLayer = buildLayerInferrer(layerMappings);

  // Step 1: Determine which file paths the caller expects (for scope filtering)
  const requestedFilePaths = await scanProjectFiles(input, projectDir);
  const requestedFileSet = new Set(requestedFilePaths);

  // Step 2: Detect changed files
  const changedSet = await detectChangedFiles(input, projectDir);

  // Step 3: Run knowledge graph pipeline to populate/update SQLite DB,
  // then materialize to get file-level nodes and edges.
  // Falls back to the legacy regex-based approach if the pipeline errors.
  let nodes: GraphNode[];
  let edges: GraphEdge[];

  // Resolve source_dirs for pipeline scoping
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const pipelineSourceDirs = explicitSourceDirs || configSourceDirs || undefined;

  try {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    await runPipeline(projectDir, { dbPath, sourceDirs: pipelineSourceDirs });

    const db = initDatabase(dbPath);
    let graphData: ReturnType<typeof materialize>;
    try {
      graphData = materialize(db, projectDir);
    } finally {
      db.close();
    }

    // Filter materialized nodes to only those within the requested scope
    const filteredNodes = graphData.nodes.filter((n) =>
      requestedFileSet.size === 0 || requestedFileSet.has(n.id),
    );
    const filteredNodeSet = new Set(filteredNodes.map((n) => n.id));

    // Filter edges to only those where both endpoints are in scope
    const filteredEdges = graphData.edges.filter(
      (e) => filteredNodeSet.has(e.source) && filteredNodeSet.has(e.target),
    );

    // Supplement pipeline edges with legacy alias-aware import resolution,
    // composition edges, and MD-relation inference. These fill in gaps the
    // SQLite pipeline doesn't yet cover (tsconfig path aliases, composition
    // marker patterns, markdown cross-references).
    const aliases = await loadPathAliases(projectDir);
    const supplementImportEdges = await buildEdges(requestedFilePaths, requestedFileSet, aliases, projectDir);
    const supplementCompositionEdges = await buildCompositionEdges(requestedFilePaths, requestedFileSet, projectDir);
    const nameMaps = await buildNameMaps(requestedFilePaths, projectDir);
    const supplementMdEdges = await inferMdRelations(requestedFilePaths, requestedFileSet, nameMaps, projectDir);
    const supplementEdges = mergeEdges(supplementImportEdges, mergeEdges(supplementCompositionEdges, supplementMdEdges));

    // Apply compliance overlay and layer colors onto materialized nodes
    const store = new DriftStore(projectDir);
    const reviews = await store.getReviews();

    const fileViolations = new Map<string, Map<string, number>>();
    const fileVerdicts = new Map<string, { timestamp: string; verdict: string }>();
    for (const review of reviews) {
      for (const file of review.files) {
        const existing = fileVerdicts.get(file);
        if (!existing || review.timestamp > existing.timestamp) {
          fileVerdicts.set(file, { timestamp: review.timestamp, verdict: review.verdict });
        }
      }
      for (const v of review.violations) {
        const targetFile = v.file_path || review.files[0];
        if (!targetFile) continue;
        if (!fileViolations.has(targetFile)) fileViolations.set(targetFile, new Map());
        const counts = fileViolations.get(targetFile)!;
        counts.set(v.principle_id, (counts.get(v.principle_id) || 0) + 1);
      }
    }

    nodes = filteredNodes.map((n) => {
      const layer = inferLayer(n.id) || n.layer || "unknown";
      const violations = fileViolations.get(n.id);
      const violationCount = violations
        ? Array.from(violations.values()).reduce((a, b) => a + b, 0) : 0;
      const topViolations = violations
        ? Array.from(violations.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
        : [];

      const node: GraphNode = {
        id: n.id,
        layer,
        color: layerColors[layer] || FALLBACK_LAYER_COLOR,
        extension: n.extension || n.id.split(".").pop() || "",
        violation_count: violationCount,
        top_violations: topViolations,
        last_verdict: fileVerdicts.get(n.id)?.verdict || null,
        compliance_score: null,
        changed: changedSet.has(n.id),
      };

      const kind = classifyMdNode(n.id);
      if (kind) node.kind = kind;

      return node;
    });

    // Merge pipeline edges with supplemental legacy edges (deduplication handled by mergeEdges)
    edges = mergeEdges(filteredEdges, supplementEdges);
  } catch (pipelineErr) {
    // Pipeline unavailable (e.g., better-sqlite3 not installed) — fall back
    // to the legacy scanner-based approach.
    console.warn(`[codebase-graph] pipeline unavailable, using legacy scanner: ${(pipelineErr as Error).message}`);

    const fileSet = requestedFileSet;
    const { nodes: legacyNodes } = await buildNodes(
      requestedFilePaths, inferLayer, layerColors, changedSet, projectDir,
    );
    const aliases = await loadPathAliases(projectDir);
    const importEdges = await buildEdges(requestedFilePaths, fileSet, aliases, projectDir);
    const compositionEdges = await buildCompositionEdges(requestedFilePaths, fileSet, projectDir);
    const nameMaps = await buildNameMaps(requestedFilePaths, projectDir);
    const mdEdges = await inferMdRelations(requestedFilePaths, fileSet, nameMaps, projectDir);

    nodes = legacyNodes;
    edges = mergeEdges(importEdges, mergeEdges(compositionEdges, mdEdges));
  }

  // Step 4: Load principles and derive structural violation IDs
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);

  const boundaryPrinciple = allPrinciples.find((p) => p.tags.includes("boundaries"));
  const cyclePrinciple = allPrinciples.find((p) => p.tags.includes("architecture"));
  const structuralIds: StructuralPrincipleIds = {
    layerBoundary: boundaryPrinciple?.id ?? "layer-boundary-crossing",
    circularDep: cyclePrinciple?.id ?? "circular-dependency",
  };

  // Step 5: Generate insights and enrich nodes with structural violations
  const insights = generateInsights(
    nodes.map((n) => ({ id: n.id, layer: n.layer })),
    edges.map((e) => ({ source: e.source, target: e.target })),
  );
  enrichNodesWithInsights(nodes, insights, structuralIds);

  // Step 6: Build layer metadata
  const layerCounts = new Map<string, number>();
  for (const node of nodes) {
    layerCounts.set(node.layer, (layerCounts.get(node.layer) || 0) + 1);
  }

  const layerIndex = new Map<string, number>();
  for (const [idx, layer] of layerEntries.entries()) layerIndex.set(layer, idx);
  if (layerCounts.has("unknown")) {
    layerIndex.set("unknown", layerEntries.length);
  }
  const layers = Array.from(layerCounts.entries())
    .map(([name, file_count]) => ({
      name,
      color: layerColors[name] || FALLBACK_LAYER_COLOR,
      file_count,
      index: layerIndex.get(name) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.index - b.index || b.file_count - a.file_count);

  const principles: Record<string, { title: string; severity: string; summary: string }> = {};
  for (const p of allPrinciples) {
    principles[p.id] = { title: p.title, severity: p.severity, summary: extractSummary(p.body) };
  }

  const fullGraph: CodebaseGraphOutput = {
    nodes, edges, layers, principles, insights,
    generated_at: new Date().toISOString(),
  };

  // Step 6: Persist graph + reverse index
  const reverseIndex: Record<string, string[]> = {};
  for (const edge of edges) {
    if (!reverseIndex[edge.target]) reverseIndex[edge.target] = [];
    reverseIndex[edge.target].push(edge.source);
  }

  const canonDir = join(projectDir, CANON_DIR);
  await mkdir(canonDir, { recursive: true });
  await Promise.all([
    atomicWriteFile(join(canonDir, CANON_FILES.GRAPH_DATA), JSON.stringify(fullGraph, null, 2)),
    atomicWriteFile(join(canonDir, CANON_FILES.REVERSE_DEPS), JSON.stringify(reverseIndex)),
  ]);

  return fullGraph;
}

/** Compact summary for MCP response — full graph is on disk. */
export function summarizeGraph(graph: CodebaseGraphOutput) {
  const violationFiles = graph.nodes
    .filter((n) => n.violation_count > 0)
    .sort((a, b) => b.violation_count - a.violation_count)
    .slice(0, 10)
    .map((n) => ({ path: n.id, violation_count: n.violation_count, top_violations: n.top_violations }));

  return {
    total_nodes: graph.nodes.length,
    total_edges: graph.edges.length,
    layers: graph.layers,
    violations: violationFiles,
    insights: graph.insights,
    generated_at: graph.generated_at,
    graph_path: `${CANON_DIR}/${CANON_FILES.GRAPH_DATA}`,
  };
}

/** Index-encoded compact graph for the UI.
 *  Node IDs are replaced with numeric indices to avoid repeating long file paths
 *  in the edge list. Scales to large codebases — ~37K for 316 nodes vs 237K raw.
 *  The full graph is always available at .canon/graph-data.json. */
export interface CompactGraphOutput {
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
}

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
    node_ids: nodeIds,
    nodes,
    edges,
    layers: graph.layers,
    generated_at: graph.generated_at,
    _compact: true,
  };
}
