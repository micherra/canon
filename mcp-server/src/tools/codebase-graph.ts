import { readFile, mkdir } from "fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { join } from "path";
import { execFile } from "child_process";
import { scanSourceFiles } from "../graph/scanner.js";
import { extractImports, resolveImport, parseTsconfigPaths, type PathAlias } from "../graph/import-parser.js";
import { loadAllPrinciples } from "../matcher.js";
import { DriftStore } from "../drift/store.js";
import { generateInsights, type CodebaseInsights } from "../graph/insights.js";
import { loadSourceDirs, loadLayerMappings, buildLayerInferrer } from "../utils/config.js";
import { isNotFound } from "../utils/errors.js";
import { extractSummary } from "../constants.js";

export const LAYER_COLORS: Record<string, string> = {
  api: "#4A90D9",
  ui: "#50C878",
  domain: "#9B59B6",
  data: "#E67E22",
  infra: "#7F8C8D",
  shared: "#1ABC9C",
  unknown: "#BDC3C7",
};

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
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "import" | "re-export";
}

export interface CodebaseGraphInput {
  root_dir?: string;
  source_dirs?: string[];
  include_extensions?: string[];
  exclude_dirs?: string[];
  diff_base?: string;
  changed_files?: string[];
}

export interface CodebaseGraphOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: Array<{ name: string; color: string; file_count: number }>;
  principles: Record<string, { title: string; severity: string; summary: string }>;
  insights: CodebaseInsights;
  generated_at: string;
}

// ── Git helpers ──

function gitCurrentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout.trim() || null);
    });
  });
}

function gitChangedFiles(cwd: string, base: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--name-only", `${base}...HEAD`], { cwd }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(stdout.trim().split("\n").filter(Boolean));
    });
  });
}

function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--verify", ref], { cwd }, (err) => {
      resolve(!err);
    });
  });
}

async function loadPathAliases(projectDir: string): Promise<PathAlias[]> {
  try {
    const raw = await readFile(join(projectDir, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(raw);
    const paths = tsconfig?.compilerOptions?.paths;
    if (paths && typeof paths === "object") {
      return parseTsconfigPaths(paths, tsconfig.compilerOptions.baseUrl);
    }
  } catch {
    // no tsconfig or invalid
  }
  return [];
}

// ── Graph building steps ──

/** Scan project directories and return sorted file paths. */
async function scanProjectFiles(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<string[]> {
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await loadSourceDirs(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs;

  if (sourceDirs && sourceDirs.length > 0) {
    const allFiles: string[] = [];
    for (const dir of sourceDirs) {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {
        includeExtensions: input.include_extensions,
        excludeDirs: input.exclude_dirs,
      });
      for (const f of files) allFiles.push(join(dir, f));
    }
    return allFiles.sort();
  }

  if (input.root_dir) {
    const isAbsolute = input.root_dir.startsWith("/");
    const rootDir = input.root_dir === "." || isAbsolute ? input.root_dir : join(projectDir, input.root_dir);
    const scanned = await scanSourceFiles(rootDir, {
      includeExtensions: input.include_extensions,
      excludeDirs: input.exclude_dirs,
    });
    const prefix = (input.root_dir === "." || isAbsolute) ? "" : input.root_dir;
    return prefix ? scanned.map((f) => join(prefix, f)) : scanned;
  }

  return [];
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
      const base = input.diff_base
        || (await gitRefExists(projectDir, "origin/main") ? "origin/main"
        : (await gitRefExists(projectDir, "origin/master") ? "origin/master" : null));
      if (base) {
        changedFiles = await gitChangedFiles(projectDir, base);
      }
    }
  }
  return new Set(changedFiles);
}

/** Build graph nodes from file paths, enriched with compliance data. */
async function buildNodes(
  filePaths: string[],
  inferLayer: (filePath: string) => string,
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

    nodes.push({
      id: filePath,
      layer,
      color: LAYER_COLORS[layer] || LAYER_COLORS.unknown,
      extension: filePath.split(".").pop() || "",
      violation_count: violationCount,
      top_violations: topViolations,
      last_verdict: fileVerdicts.get(filePath)?.verdict || null,
      compliance_score: null,
      changed: changedSet.has(filePath),
    });
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

/** Fold structural violations (layer crossings, cycles) into node violation counts. */
function enrichNodesWithInsights(nodes: GraphNode[], insights: CodebaseInsights): void {
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
      if (!node.top_violations.includes("bounded-context-boundaries")) {
        node.top_violations.push("bounded-context-boundaries");
      }
    }
    if (cycleMembers.has(node.id)) {
      if (!node.top_violations.includes("architectural-fitness-functions")) {
        node.top_violations.push("architectural-fitness-functions");
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
  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  // Step 1: Scan files
  const filePaths = await scanProjectFiles(input, projectDir);
  const fileSet = new Set(filePaths);

  // Step 2: Detect changed files
  const changedSet = await detectChangedFiles(input, projectDir);

  // Step 3: Build nodes with compliance data
  const { nodes, layerCounts } = await buildNodes(filePaths, inferLayer, changedSet, projectDir);

  // Step 4: Build edges
  const aliases = await loadPathAliases(projectDir);
  const edges = await buildEdges(filePaths, fileSet, aliases, projectDir);

  // Step 5: Generate insights and enrich nodes
  const insights = generateInsights(
    nodes.map((n) => ({ id: n.id, layer: n.layer })),
    edges.map((e) => ({ source: e.source, target: e.target })),
  );
  enrichNodesWithInsights(nodes, insights);

  // Step 6: Build metadata
  const layers = Array.from(layerCounts.entries())
    .map(([name, file_count]) => ({ name, color: LAYER_COLORS[name] || LAYER_COLORS.unknown, file_count }))
    .sort((a, b) => b.file_count - a.file_count);

  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const principles: Record<string, { title: string; severity: string; summary: string }> = {};
  for (const p of allPrinciples) {
    principles[p.id] = { title: p.title, severity: p.severity, summary: extractSummary(p.body) };
  }

  const fullGraph: CodebaseGraphOutput = {
    nodes, edges, layers, principles, insights,
    generated_at: new Date().toISOString(),
  };

  // Step 7: Persist graph + reverse index
  const reverseIndex: Record<string, string[]> = {};
  for (const edge of edges) {
    if (!reverseIndex[edge.target]) reverseIndex[edge.target] = [];
    reverseIndex[edge.target].push(edge.source);
  }

  const canonDir = join(projectDir, ".canon");
  await mkdir(canonDir, { recursive: true });
  await Promise.all([
    atomicWriteFile(join(canonDir, "graph-data.json"), JSON.stringify(fullGraph, null, 2)),
    atomicWriteFile(join(canonDir, "reverse-deps.json"), JSON.stringify(reverseIndex)),
  ]);

  return fullGraph;
}
