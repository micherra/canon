import { readFile } from "fs/promises";
import { join } from "path";
import { scanSourceFiles } from "../graph/scanner.js";
import { extractImports, resolveImport } from "../graph/import-parser.js";
import { inferLayer } from "../matcher.js";
import { DriftStore } from "../drift/store.js";

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
  generated_at: string;
}

export async function codebaseGraph(
  input: CodebaseGraphInput,
  projectDir: string,
  _pluginDir: string
): Promise<CodebaseGraphOutput> {
  const rootDir = input.root_dir || projectDir;

  // Scan files
  const filePaths = await scanSourceFiles(rootDir, {
    includeExtensions: input.include_extensions,
    excludeDirs: input.exclude_dirs,
  });

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
    const layer = inferLayer(filePath);
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
      compliance_score: null, // computed per-principle, not per-file
      changed: changedSet.has(filePath),
    });
  }

  // Build edges
  const edges: GraphEdge[] = [];

  for (const filePath of filePaths) {
    try {
      const content = await readFile(join(rootDir, filePath), "utf-8");
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

  return {
    nodes,
    edges,
    layers,
    hotspots,
    generated_at: new Date().toISOString(),
  };
}
