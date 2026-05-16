import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CANON_DIR, CANON_FILES } from "./constants.ts";
import { buildLayerInferrer, DEFAULT_LAYER_MAPPINGS } from "./lib/config.ts";
import { loadPrincipleFile, type Principle } from "./parser.ts";

const SEVERITY_SUBDIRS = ["rules", "strong-opinions", "conventions"];

export type MatchFilters = {
  layers?: string[];
  file_path?: string;
  severity_filter?: "rule" | "strong-opinion" | "convention";
  tags?: string[];
  /** Tags computed from the KG for the target file. Used for tag-based scope matching (OR vs layers). */
  computed_tags?: string[];
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

/**
 * Check if a file's computed tags intersect with a principle's scope.tags.
 *
 * Returns true when:
 * - principle has no scope.tags (backward compat — matches all files)
 * - computed_tags is empty/undefined (no KG data — skip tag filter)
 * - intersection of scope.tags and computed_tags is non-empty
 */
function matchesScopeTags(p: Principle, computedTags: string[] | undefined): boolean {
  if (!p.scope.tags || p.scope.tags.length === 0) return true;
  if (!computedTags || computedTags.length === 0) return true;
  return computedTags.some((t) => p.scope.tags!.includes(t));
}

/**
 * Check if a principle passes the layer/scope-tags gate.
 *
 * Three cases:
 * 1. scope.layers non-empty AND scope.tags non-empty (with computed_tags):
 *    OR semantics — either a layer match or a tag match is sufficient.
 * 2. scope.layers empty AND scope.tags non-empty (tag-only principle):
 *    Tag match is REQUIRED — the principle only applies to files with matching
 *    computed_tags. When no computed_tags are available (KG not indexed), the
 *    principle is skipped to avoid spurious matches.
 * 3. scope.tags empty or absent (layer-only or universal principle):
 *    Layer-only matching (empty scope.layers means universal — matches all).
 */
function passesLayerGate(
  p: Principle,
  layers: string[],
  computedTags: string[] | undefined,
): boolean {
  const hasScopeLayers = p.scope.layers.length > 0;
  const hasScopeTags = (p.scope.tags?.length ?? 0) > 0;
  const hasComputedTags = (computedTags?.length ?? 0) > 0;

  if (hasScopeTags) {
    if (hasScopeLayers) {
      // Case 1: Both layers and tags specified — OR semantics.
      // Layer match is evaluated without the "empty = universal" short-circuit
      // because we have an explicit tag constraint.
      const layersMatch = layers.some((l) => p.scope.layers.includes(l));
      return layersMatch || (hasComputedTags && matchesScopeTags(p, computedTags));
    }
    // Case 2: Tag-only principle (no layers) — tag match is controlling.
    // When KG is unavailable (no computed_tags), skip this principle.
    return hasComputedTags && matchesScopeTags(p, computedTags);
  }

  // Case 3: No scope.tags — layer-only (empty scope.layers = universal).
  return matchesLayers(p, layers);
}

/**
 * Check if a principle passes all active filters.
 * Layers OR scope.tags: principle matches if either signal matches.
 * When computed_tags are available and scope.tags is set, a tag match
 * can compensate for a layer mismatch (the whole point of this feature).
 */
function principleMatchesFilters(p: Principle, filters: MatchFilters, layers: string[]): boolean {
  if (p.archived && !filters.include_archived) return false;
  if (!severityPassesFilter(p.severity, filters.severity_filter)) return false;
  if (!passesLayerGate(p, layers, filters.computed_tags)) return false;
  if (!matchesFilePattern(p, filters.file_path)) return false;
  if (!matchesTags(p, filters.tags)) return false;
  return true;
}

export function matchPrinciples(principles: Principle[], filters: MatchFilters): Principle[] {
  const layers =
    filters.layers ||
    (filters.file_path ? ([inferLayer(filters.file_path)].filter(Boolean) as string[]) : []);

  return principles
    .filter((p) => principleMatchesFilters(p, filters, layers))
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

// --- Principle overrides: project-level disable / severity / scope overrides ---

type DisableOverride = {
  principle_id: string;
  action: "disable";
  reason: string;
};

type SeverityOverride = {
  principle_id: string;
  action: "override-severity";
  severity: "rule" | "strong-opinion" | "convention";
  reason: string;
};

type ScopeOverride = {
  principle_id: string;
  action: "narrow-scope";
  applies_to: {
    layers: string[];
    file_patterns: string[];
  };
  reason: string;
};

type PrincipleOverride = DisableOverride | SeverityOverride | ScopeOverride;

type PrincipleOverridesFile = {
  overrides: PrincipleOverride[];
};

async function loadOverrides(projectDir: string): Promise<PrincipleOverride[]> {
  const overridePath = join(projectDir, CANON_DIR, CANON_FILES.PRINCIPLE_OVERRIDES);
  try {
    const content = await readFile(overridePath, "utf-8");
    const parsed = parseYaml(content) as PrincipleOverridesFile | null;
    if (!parsed || !Array.isArray(parsed.overrides)) {
      return [];
    }
    const VALID_SEVERITIES = new Set(["rule", "strong-opinion", "convention"]);
    return parsed.overrides.filter((o) => {
      if (!o || typeof o.principle_id !== "string" || typeof o.action !== "string") return false;
      if (o.action === "override-severity") {
        return typeof o.severity === "string" && VALID_SEVERITIES.has(o.severity);
      }
      if (o.action === "narrow-scope") {
        return (
          o.applies_to != null &&
          Array.isArray(o.applies_to?.layers) &&
          (o.applies_to.layers as unknown[]).every((el: unknown) => typeof el === "string") &&
          Array.isArray(o.applies_to?.file_patterns) &&
          (o.applies_to.file_patterns as unknown[]).every((el: unknown) => typeof el === "string")
        );
      }
      // "disable" and unknown actions: no additional field requirements
      return true;
    });
  } catch {
    return []; /* file missing or unreadable — no overrides */
  }
}

function applyOverrides(principles: Principle[], overrides: PrincipleOverride[]): Principle[] {
  if (overrides.length === 0) return principles;

  const overrideMap = new Map<string, PrincipleOverride>();
  for (const o of overrides) {
    overrideMap.set(o.principle_id, o);
  }

  const result: Principle[] = [];
  for (const p of principles) {
    const override = overrideMap.get(p.id);
    if (!override) {
      result.push(p);
      continue;
    }

    switch (override.action) {
      case "disable":
        // Skip — principle removed from output entirely
        break;
      case "override-severity":
        result.push({ ...p, severity: override.severity });
        break;
      case "narrow-scope":
        result.push({
          ...p,
          scope: {
            file_patterns: override.applies_to.file_patterns,
            layers: override.applies_to.layers,
          },
        });
        break;
      default:
        // Unknown action — silently skip override, keep principle unchanged
        result.push(p);
    }
  }

  return result;
}

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
  const baseKey = allMtimes.flat().join(",");

  // Include override file mtime in cache key
  const overridePath = join(projectDir, CANON_DIR, CANON_FILES.PRINCIPLE_OVERRIDES);
  try {
    const s = await stat(overridePath);
    return `${baseKey},overrides:${s.mtimeMs}`;
  } catch {
    return baseKey; /* no override file — key unchanged */
  }
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

  // Apply project-level overrides (disable, severity change, scope narrowing)
  const overrides = await loadOverrides(projectDir);
  const effective = applyOverrides(merged, overrides);

  // Pre-compile all glob regexes while we're loading
  for (const p of effective) {
    for (const pattern of p.scope.file_patterns) {
      globToRegex(pattern);
    }
  }

  principleCache = { mtimeKey, principles: effective };
  return effective;
}
