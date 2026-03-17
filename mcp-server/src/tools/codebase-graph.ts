import { readFile } from "fs/promises";
import { join } from "path";
import { scanSourceFiles } from "../graph/scanner.js";
import { extractImports, resolveImport } from "../graph/import-parser.js";
import { inferLayer } from "../matcher.js";
import { DriftStore } from "../drift/store.js";
import { generateInsights, type CodebaseInsights } from "../graph/insights.js";

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
  hotspots: Array<{ path: string; violation_count: number; top_violations: string[] }>;
  insights: CodebaseInsights;
  generated_at: string;
}

/** Read source_dirs from .canon/config.json if it exists */
async function loadSourceDirs(projectDir: string): Promise<string[] | null> {
  try {
    const raw = await readFile(join(projectDir, ".canon", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    if (Array.isArray(config.source_dirs) && config.source_dirs.length > 0) {
      return config.source_dirs;
    }
  } catch {
    // no config or invalid
  }
  return null;
}

export async function codebaseGraph(
  input: CodebaseGraphInput,
  projectDir: string,
  _pluginDir: string
): Promise<CodebaseGraphOutput> {
  const rootDir = input.root_dir || projectDir;

  // Determine which directories to scan:
  // 1. Explicit source_dirs from tool input takes priority
  // 2. Then source_dirs from .canon/config.json
  // 3. If neither exists, scan nothing (return empty) — user must configure source_dirs
  // Exception: if root_dir is explicitly passed, scan that dir directly
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await loadSourceDirs(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs;

  let filePaths: string[];

  if (input.root_dir) {
    // Explicit root_dir passed — scan it directly (e.g. user passed ".")
    filePaths = await scanSourceFiles(rootDir, {
      includeExtensions: input.include_extensions,
      excludeDirs: input.exclude_dirs,
    });
  } else if (sourceDirs && sourceDirs.length > 0) {
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
  } else {
    // No source_dirs configured — fall back to scanning the project root
    filePaths = await scanSourceFiles(projectDir, {
      includeExtensions: input.include_extensions,
      excludeDirs: input.exclude_dirs,
    });
  }

  const fileSet = new Set(filePaths);
  const changedSet = new Set(input.changed_files || []);

  // Load compliance data
  const store = new DriftStore(projectDir);
  const reviews = await store.getReviews();

  // Build per-file violation counts
  const fileViolations = new Map<string, Map<string, number>>();
  const fileVerdicts = new Map<string, string>();
  for (const review of reviews) {
    for (const file of review.files) {
      if (!fileVerdicts.has(file) || review.timestamp > (fileVerdicts.get(file) || "")) {
        fileVerdicts.set(file, review.verdict);
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

    const ext = filePath.split(".").pop() || "";

    nodes.push({
      id: filePath,
      layer,
      color: LAYER_COLORS[layer] || LAYER_COLORS.unknown,
      extension: ext,
      violation_count: violationCount,
      last_verdict: fileVerdicts.get(filePath) || null,
      compliance_score: null,
      changed: changedSet.has(filePath),
    });
  }

  // Build edges — read files relative to projectDir (not rootDir) since paths are project-relative
  const edges: GraphEdge[] = [];

  for (const filePath of filePaths) {
    try {
      const content = await readFile(join(projectDir, filePath), "utf-8");
      const imports = extractImports(content, filePath);

      for (const imp of imports) {
        const resolved = resolveImport(imp, filePath, fileSet);
        if (resolved && resolved !== filePath) {
          edges.push({
            source: filePath,
            target: resolved,
            type: "import",
          });
        }
      }
    } catch {
      // skip unreadable files
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

  // Build hotspots (top 10 files by violation count)
  const hotspots = nodes
    .filter((n) => n.violation_count > 0)
    .sort((a, b) => b.violation_count - a.violation_count)
    .slice(0, 10)
    .map((n) => {
      const violations = fileViolations.get(n.id)!;
      const topViolations = Array.from(violations.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);
      return {
        path: n.id,
        violation_count: n.violation_count,
        top_violations: topViolations,
      };
    });

  // Generate structural insights
  const edgesForInsights = edges.map((e) => ({ source: e.source, target: e.target }));
  const nodesForInsights = nodes.map((n) => ({ id: n.id, layer: n.layer }));
  const insights = generateInsights(nodesForInsights, edgesForInsights);

  return {
    nodes,
    edges,
    layers,
    hotspots,
    insights,
    generated_at: new Date().toISOString(),
  };
}
