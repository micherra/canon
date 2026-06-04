import path, { join } from "node:path";
import { type CodebaseInsights, generateInsights } from "@graph/insights.ts";
import { runPipeline } from "@graph/kg-pipeline.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { buildNameMaps, inferMdRelations } from "@graph/md-relations.ts";
import { CANON_DIR, CANON_FILES, extractSummary } from "@shared/constants.ts";
import {
  buildLayerInferrer,
  deriveSourceDirsFromLayers,
  loadLayerMappings,
  loadLayerMappingsStrict,
} from "@shared/lib/config.ts";
import { loadPathAliases } from "@shared/lib/paths.ts";
import { loadAllPrinciples } from "@shared/matcher.ts";
import {
  buildComplianceOverlay,
  buildGraphNode,
  buildNodes,
  enrichNodesWithInsights,
} from "./codebase-graph-compliance.ts";
import {
  buildCompositionEdges,
  buildEdges,
  colorFromLayerName,
  FALLBACK_LAYER_COLOR,
  mergeEdges,
} from "./codebase-graph-edges.ts";
import { detectChangedFiles, scanProjectFiles } from "./codebase-graph-scan.ts";

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

/** Map DB edge type string to GraphEdge type. */
function mapEdgeType(edgeType: string): GraphEdge["type"] {
  if (edgeType === "imports") return "import";
  if (edgeType === "re-exports") return "re-export";
  if (edgeType === "composition") return "composition";
  return "import";
}

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
  } catch (err) {
    // best-effort: strict layer mappings unavailable; falling back to lenient loader
    console.warn(
      "[canon] codebase-graph: strict layer mapping load failed, falling back to lenient loader:",
      err instanceof Error ? err.message : err,
    );
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
  projectDir: string;
};

/** Build the final graph output from nodes, edges, principles, and insights. */
function buildGraphOutput(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: BuildGraphOutputOptions,
): CodebaseGraphOutput {
  const { layerEntries, layerColors, allPrinciples, projectDir } = options;
  const structuralIds = {
    circularDep:
      allPrinciples.find((p) => p.tags.includes("architecture"))?.id ?? "circular-dependency",
    layerBoundary:
      allPrinciples.find((p) => p.tags.includes("boundaries"))?.id ?? "layer-boundary-crossing",
  };

  const insights = generateInsights(
    nodes.map((n) => ({ id: n.id, layer: n.layer })),
    edges.map((e) => ({ source: e.source, target: e.target })),
    undefined, // layerRules (unchanged)
    projectDir, // explicit scope — was implicitly process.cwd()
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
    const supplementEdges = await buildSupplementalEdgesLocal(
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
    edges = await buildSupplementalEdgesLocal(requestedFilePaths, requestedFileSet, projectDir);
  }

  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  return buildGraphOutput(nodes, edges, { allPrinciples, layerColors, layerEntries, projectDir });
}

/**
 * Read and format the codebase graph from an existing KG DB without re-running the pipeline.
 *
 * This is the read-only path used by codebase_graph_materialize after the background job
 * has already populated the DB. Skips runPipeline — assumes the DB is current.
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
  } catch (err) {
    // best-effort: KG DB unavailable; falling back to live filesystem scan
    console.warn(
      "[canon] codebase-graph: KG DB unavailable, falling back to legacy scanner:",
      err instanceof Error ? err.message : err,
    );
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

  return buildGraphOutput(nodes, edges, { allPrinciples, layerColors, layerEntries, projectDir });
}

/** Build supplemental edges from legacy scanners (aliases, composition, markdown). */
async function buildSupplementalEdgesLocal(
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
