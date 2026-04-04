import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CANON_DIR } from "./shared/constants.ts";
import { loadPrincipleFile, type Principle } from "./shared/parser.ts";
import { buildLayerInferrer, DEFAULT_LAYER_MAPPINGS } from "./utils/config.ts";

const SEVERITY_SUBDIRS = ["rules", "strong-opinions", "conventions"];

export type MatchFilters = {
  layers?: string[];
  file_path?: string;
  severity_filter?: "rule" | "strong-opinion" | "convention";
  tags?: string[];
  include_archived?: boolean;
};

const SEVERITY_RANK: Record<string, number> = {
  convention: 3,
  rule: 1,
  "strong-opinion": 2,
};

/** Default layer inferrer using built-in mappings. For config-aware inference, use buildLayerInferrer(). */
const defaultInferLayer = buildLayerInferrer(DEFAULT_LAYER_MAPPINGS);

export function inferLayer(filePath: string): string | undefined {
  const layer = defaultInferLayer(filePath);
  return layer === "unknown" ? undefined : layer;
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

function severityPassesFilter(severity: string, filter?: string): boolean {
  if (!filter) return true;
  return (SEVERITY_RANK[severity] ?? 9) <= (SEVERITY_RANK[filter] ?? 9);
}

/** Check if a principle matches the layer filter. */
function matchesLayers(p: Principle, layers: string[]): boolean {
  if (layers.length === 0 || p.scope.layers.length === 0) return true;
  return layers.some((l) => p.scope.layers.includes(l));
}

/** Check if a principle matches the file pattern filter. */
function matchesFilePattern(p: Principle, filePath: string | undefined): boolean {
  if (!filePath || p.scope.file_patterns.length === 0) return true;
  return p.scope.file_patterns.some((pattern) => globToRegex(pattern).test(filePath));
}

/** Check if a principle matches the tag filter. */
function matchesTags(p: Principle, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  return tags.some((t) => p.tags.includes(t));
}

export function matchPrinciples(principles: Principle[], filters: MatchFilters): Principle[] {
  const layers =
    filters.layers ||
    (filters.file_path ? ([inferLayer(filters.file_path)].filter(Boolean) as string[]) : []);

  return principles
    .filter((p) => {
      if (p.archived && !filters.include_archived) return false;
      if (!severityPassesFilter(p.severity, filters.severity_filter)) return false;
      if (!matchesLayers(p, layers)) return false;
      if (!matchesFilePattern(p, filters.file_path)) return false;
      if (!matchesTags(p, filters.tags)) return false;
      return true;
    })
    .sort((a, b) => {
      const sevDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return b.scope.file_patterns.length - a.scope.file_patterns.length;
    });
}

async function loadMdFilesFromDir(dir: string): Promise<Principle[]> {
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const principles = await Promise.all(mdFiles.map((f) => loadPrincipleFile(join(dir, f))));
    return principles.filter((p) => p.id !== "");
  } catch {
    return [];
  }
}

export async function loadPrinciplesFromDir(dir: string): Promise<Principle[]> {
  const results = await Promise.all(
    SEVERITY_SUBDIRS.map((sub) => loadMdFilesFromDir(join(dir, sub))),
  );
  return results.flat();
}

// --- Principle cache: avoids re-reading all principle files on every tool call ---
// Invalidated when any .md file's mtime changes (or files are added/removed).

type PrincipleCache = {
  principles: Principle[];
  mtimeKey: string; // concatenated file mtimes for invalidation
};

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
      }),
    );
    return stats;
  } catch {
    return [];
  }
}

async function computeMtimeKey(projectDir: string, pluginDir: string): Promise<string> {
  const dirs = SEVERITY_SUBDIRS.flatMap((sub) => [
    join(projectDir, CANON_DIR, "principles", sub),
    join(pluginDir, "principles", sub),
  ]);
  const allMtimes = await Promise.all(dirs.map(getFileMtimes));
  return allMtimes.flat().join(",");
}

export async function loadAllPrinciples(
  projectDir: string,
  pluginDir: string,
): Promise<Principle[]> {
  const mtimeKey = await computeMtimeKey(projectDir, pluginDir);

  if (principleCache && principleCache.mtimeKey === mtimeKey) {
    return principleCache.principles;
  }

  const projectPrinciples = await loadPrinciplesFromDir(join(projectDir, CANON_DIR, "principles"));
  const pluginPrinciples = await loadPrinciplesFromDir(join(pluginDir, "principles"));

  // Project-local takes precedence on ID conflict
  const seenIds = new Set(projectPrinciples.map((p) => p.id));
  const merged = [...projectPrinciples, ...pluginPrinciples.filter((p) => !seenIds.has(p.id))];

  // Pre-compile all glob regexes while we're loading
  for (const p of merged) {
    for (const pattern of p.scope.file_patterns) {
      globToRegex(pattern);
    }
  }

  principleCache = { mtimeKey, principles: merged };
  return merged;
}
