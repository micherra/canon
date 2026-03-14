import { readdir } from "fs/promises";
import { join } from "path";
import { type Principle, loadPrincipleFile } from "./parser.js";

export interface MatchFilters {
  layers?: string[];
  file_path?: string;
  severity_filter?: "rule" | "strong-opinion" | "convention";
  tags?: string[];
}

const PATH_TO_LAYER: Array<[RegExp, string]> = [
  [/\/(api|routes|controllers)\//, "api"],
  [/\/(components|pages|views)\//, "ui"],
  [/\/(services|domain|models)\//, "domain"],
  [/\/(db|data|repositories|prisma)\//, "data"],
  [/\/(infra|deploy|terraform|docker)\//, "infra"],
  [/\/(utils|lib|shared|types)\//, "shared"],
];

const SEVERITY_RANK: Record<string, number> = {
  rule: 1,
  "strong-opinion": 2,
  convention: 3,
};

export function inferLayer(filePath: string): string | undefined {
  for (const [pattern, layer] of PATH_TO_LAYER) {
    if (pattern.test(filePath)) return layer;
  }
  return undefined;
}

function globToRegex(pattern: string): RegExp {
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
  return new RegExp(`(^|/)${regex}$`);
}

function severityPassesFilter(
  severity: string,
  filter?: string
): boolean {
  if (!filter) return true;
  return (SEVERITY_RANK[severity] ?? 9) <= (SEVERITY_RANK[filter] ?? 9);
}

export function matchPrinciples(
  principles: Principle[],
  filters: MatchFilters
): Principle[] {
  const layers = filters.layers || (filters.file_path ? [inferLayer(filters.file_path)].filter(Boolean) as string[] : []);

  return principles
    .filter((p) => {
      // Severity filter
      if (!severityPassesFilter(p.severity, filters.severity_filter)) return false;

      // Layer filter
      if (layers.length > 0 && p.scope.layers.length > 0) {
        if (!layers.some((l) => p.scope.layers.includes(l))) return false;
      }

      // File pattern filter
      if (filters.file_path && p.scope.file_patterns.length > 0) {
        const matched = p.scope.file_patterns.some((pattern) => {
          const regex = globToRegex(pattern);
          return regex.test(filters.file_path!);
        });
        if (!matched) return false;
      }

      // Tag filter
      if (filters.tags && filters.tags.length > 0) {
        if (!filters.tags.some((t) => p.tags.includes(t))) return false;
      }

      return true;
    })
    .sort((a, b) => {
      // Primary: severity (rule > strong-opinion > convention)
      const sevDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (sevDiff !== 0) return sevDiff;

      // Tie-breaker: specificity — principles with constraints rank higher
      const specificity = (p: Principle): number =>
        (p.scope.layers.length > 0 ? 1 : 0) + (p.scope.file_patterns.length > 0 ? 1 : 0);
      return specificity(b) - specificity(a);
    });
}

export async function loadPrinciplesFromDir(dir: string): Promise<Principle[]> {
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const principles = await Promise.all(
      mdFiles.map((f) => loadPrincipleFile(join(dir, f)))
    );
    return principles.filter((p) => p.id !== "");
  } catch {
    return [];
  }
}

export async function loadAllPrinciples(
  projectDir: string,
  pluginDir: string
): Promise<Principle[]> {
  const projectPrinciples = await loadPrinciplesFromDir(
    join(projectDir, ".canon", "principles")
  );
  const pluginPrinciples = await loadPrinciplesFromDir(
    join(pluginDir, "principles")
  );

  // Project-local takes precedence on ID conflict
  const seenIds = new Set(projectPrinciples.map((p) => p.id));
  const merged = [
    ...projectPrinciples,
    ...pluginPrinciples.filter((p) => !seenIds.has(p.id)),
  ];

  return merged;
}
