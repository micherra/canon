import { readdir, stat } from "fs/promises";
import { join } from "path";
import { type Principle, loadPrincipleFile } from "./parser.js";

const SEVERITY_SUBDIRS = ["rules", "strong-opinions", "conventions"];

export interface MatchFilters {
  layers?: string[];
  file_path?: string;
  severity_filter?: "rule" | "strong-opinion" | "convention";
  tags?: string[];
  include_archived?: boolean;
}

const PATH_TO_LAYER: Array<[RegExp, string]> = [
  [/(^|\/)(api|routes|controllers)(\/|$)/, "api"],
  [/(^|\/)(components|pages|views)(\/|$)/, "ui"],
  [/(^|\/)(services|domain|models)(\/|$)/, "domain"],
  [/(^|\/)(db|data|repositories|prisma)(\/|$)/, "data"],
  [/(^|\/)(infra|deploy|terraform|docker)(\/|$)/, "infra"],
  [/(^|\/)(utils|lib|shared|types)(\/|$)/, "shared"],
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

// Cache compiled glob regexes to avoid recompilation on every match
const globRegexCache = new Map<string, RegExp>();

function globToRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) return cached;

  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
  const compiled = new RegExp(`(^|/)${regex}$`);
  globRegexCache.set(pattern, compiled);
  return compiled;
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
      // Skip archived principles unless explicitly included
      if (p.archived && !filters.include_archived) return false;

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
      const sevDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      // Tie-breaker: more specific scope (more file patterns) ranks first
      return b.scope.file_patterns.length - a.scope.file_patterns.length;
    });
}

async function loadMdFilesFromDir(dir: string): Promise<Principle[]> {
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

export async function loadPrinciplesFromDir(dir: string): Promise<Principle[]> {
  const results = await Promise.all(
    SEVERITY_SUBDIRS.map((sub) => loadMdFilesFromDir(join(dir, sub)))
  );
  return results.flat();
}

// --- Principle cache: avoids re-reading all principle files on every tool call ---
// Invalidated when any .md file's mtime changes (or files are added/removed).

interface PrincipleCache {
  principles: Principle[];
  mtimeKey: string; // concatenated file mtimes for invalidation
}

let principleCache: PrincipleCache | null = null;

async function getFileMtimes(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    const stats = await Promise.all(
      mdFiles.map(async (f) => {
        try {
          const s = await stat(join(dir, f));
          return `${f}:${s.mtimeMs}`;
        } catch {
          return `${f}:0`;
        }
      })
    );
    return stats;
  } catch {
    return [];
  }
}

async function computeMtimeKey(projectDir: string, pluginDir: string): Promise<string> {
  const dirs = SEVERITY_SUBDIRS.flatMap((sub) => [
    join(projectDir, ".canon", "principles", sub),
    join(pluginDir, "principles", sub),
  ]);
  const allMtimes = await Promise.all(dirs.map(getFileMtimes));
  return allMtimes.flat().join(",");
}

export async function loadAllPrinciples(
  projectDir: string,
  pluginDir: string
): Promise<Principle[]> {
  const mtimeKey = await computeMtimeKey(projectDir, pluginDir);

  if (principleCache && principleCache.mtimeKey === mtimeKey) {
    return principleCache.principles;
  }

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

  // Pre-compile all glob regexes while we're loading
  for (const p of merged) {
    for (const pattern of p.scope.file_patterns) {
      globToRegex(pattern);
    }
  }

  principleCache = { principles: merged, mtimeKey };
  return merged;
}
