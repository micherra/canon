import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { scanSourceFiles } from "../graph/scanner.js";
import { extractImports, resolveImport, parseTsconfigPaths, type PathAlias } from "../graph/import-parser.js";
import { loadAllPrinciples } from "../matcher.js";
import { DriftStore } from "../drift/store.js";
import { generateInsights, type CodebaseInsights } from "../graph/insights.js";
import { loadSourceDirs, loadLayerMappings, buildLayerInferrer } from "../utils/config.js";
import { isNotFound } from "../utils/errors.js";

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

/** Read path aliases from tsconfig.json if it exists */
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


/** Get the current git branch name */
function gitCurrentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout.trim() || null);
    });
  });
}

/** Get files changed between a base ref and HEAD */
function gitChangedFiles(cwd: string, base: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--name-only", `${base}...HEAD`], { cwd }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(stdout.trim().split("\n").filter(Boolean));
    });
  });
}

/** Check if a git ref exists */
function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--verify", ref], { cwd }, (err) => {
      resolve(!err);
    });
  });
}

export async function codebaseGraph(
  input: CodebaseGraphInput,
  projectDir: string,
  pluginDir: string
): Promise<CodebaseGraphOutput> {
  // Determine which directories to scan:
  // 1. Explicit source_dirs from tool input takes priority
  // 2. Then source_dirs from .canon/config.json
  // 3. root_dir is only used as a fallback when no source_dirs are configured
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await loadSourceDirs(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs;

  // Load user-configurable layer mappings
  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  let filePaths: string[];

  if (sourceDirs && sourceDirs.length > 0) {
    // Scan each source_dir and merge results with paths relative to projectDir
    const allFiles: string[] = [];
    for (const dir of sourceDirs) {
      const absDir = join(projectDir, dir);
      const files = await scanSourceFiles(absDir, {
        includeExtensions: input.include_extensions,
        excludeDirs: input.exclude_dirs,
      });
      // Prefix relative paths with the source dir
      for (const f of files) {
        allFiles.push(join(dir, f));
      }
    }
    filePaths = allFiles.sort();
  } else if (input.root_dir) {
    // No source_dirs but explicit root_dir — scan that directory
    // Normalize to project-relative paths so node IDs match file reads
    const isAbsolute = input.root_dir.startsWith("/");
    const rootDir = input.root_dir === "." || isAbsolute ? input.root_dir : join(projectDir, input.root_dir);
    const scanned = await scanSourceFiles(rootDir, {
      includeExtensions: input.include_extensions,
      excludeDirs: input.exclude_dirs,
    });
    // Prefix relative root_dir paths so they're project-relative (consistent with source_dirs behavior)
    const prefix = (input.root_dir === "." || isAbsolute) ? "" : input.root_dir;
    filePaths = prefix ? scanned.map((f) => join(prefix, f)) : scanned;
  } else {
    // No source_dirs configured and no root_dir — return empty graph
    filePaths = [];
  }

  const fileSet = new Set(filePaths);

  // Auto-detect changed files from git if not explicitly provided
  let changedFiles = input.changed_files || [];
  if (changedFiles.length === 0) {
    const branch = await gitCurrentBranch(projectDir);
    if (branch && branch !== "main" && branch !== "master") {
      // Find the base branch to diff against
      const base = input.diff_base || (await gitRefExists(projectDir, "origin/main") ? "origin/main" : (await gitRefExists(projectDir, "origin/master") ? "origin/master" : null));
      if (base) {
        changedFiles = await gitChangedFiles(projectDir, base);
      }
    }
  }
  const changedSet = new Set(changedFiles);

  // Load compliance data
  const store = new DriftStore(projectDir);
  const reviews = await store.getReviews();

  // Build per-file violation counts
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
      for (const file of review.files) {
        if (!fileViolations.has(file)) fileViolations.set(file, new Map());
        const counts = fileViolations.get(file)!;
        counts.set(v.principle_id, (counts.get(v.principle_id) || 0) + 1);
      }
    }
  }

  // Build nodes
  const nodes: GraphNode[] = [];
  const layerCounts = new Map<string, number>();

  for (const filePath of filePaths) {
    const layer = inferLayer(filePath) || "unknown";
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);

    const violations = fileViolations.get(filePath);
    const violationCount = violations
      ? Array.from(violations.values()).reduce((a, b) => a + b, 0)
      : 0;

    const topViolations = violations
      ? Array.from(violations.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => id)
      : [];

    const ext = filePath.split(".").pop() || "";

    nodes.push({
      id: filePath,
      layer,
      color: LAYER_COLORS[layer] || LAYER_COLORS.unknown,
      extension: ext,
      violation_count: violationCount,
      top_violations: topViolations,
      last_verdict: fileVerdicts.get(filePath)?.verdict || null,
      compliance_score: null,
      changed: changedSet.has(filePath),
    });
  }

  // Load path aliases from tsconfig.json for non-relative import resolution
  const aliases = await loadPathAliases(projectDir);

  // Build edges — read files relative to projectDir (not rootDir) since paths are project-relative
  const edges: GraphEdge[] = [];

  for (const filePath of filePaths) {
    try {
      const content = await readFile(join(projectDir, filePath), "utf-8");
      const imports = extractImports(content, filePath);

      for (const imp of imports) {
        const resolved = resolveImport(imp, filePath, fileSet, aliases);
        if (resolved && resolved !== filePath) {
          edges.push({
            source: filePath,
            target: resolved,
            type: "import",
          });
        }
      }
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }

  // Build layers summary
  const layers = Array.from(layerCounts.entries())
    .map(([name, file_count]) => ({
      name,
      color: LAYER_COLORS[name] || LAYER_COLORS.unknown,
      file_count,
    }))
    .sort((a, b) => b.file_count - a.file_count);

  // Generate structural insights
  const edgesForInsights = edges.map((e) => ({ source: e.source, target: e.target }));
  const nodesForInsights = nodes.map((n) => ({ id: n.id, layer: n.layer }));
  const insights = generateInsights(nodesForInsights, edgesForInsights);

  // Fold layer violations into per-node violation_count and top_violations
  const layerViolationsBySource = new Map<string, number>();
  for (const lv of insights.layer_violations) {
    layerViolationsBySource.set(lv.source, (layerViolationsBySource.get(lv.source) || 0) + 1);
  }
  for (const node of nodes) {
    const lvCount = layerViolationsBySource.get(node.id) || 0;
    if (lvCount > 0) {
      node.violation_count += lvCount;
      if (!node.top_violations.includes("imports-across-layers")) {
        node.top_violations.push("imports-across-layers");
      }
    }
  }

  // Load principles for tooltip descriptions
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const principles: Record<string, { title: string; severity: string; summary: string }> = {};
  for (const p of allPrinciples) {
    const firstParagraph = p.body.split(/\n\n/)[0]?.trim() || p.body;
    principles[p.id] = { title: p.title, severity: p.severity, summary: firstParagraph };
  }

  const fullGraph = {
    nodes,
    edges,
    layers,
    principles,
    insights,
    generated_at: new Date().toISOString(),
  };

  // Persist full graph to disk — dashboard and ask_codebase read from here
  const canonDir = join(projectDir, ".canon");
  await mkdir(canonDir, { recursive: true });
  await writeFile(join(canonDir, "graph-data.json"), JSON.stringify(fullGraph, null, 2), "utf-8");

  return fullGraph;
}
