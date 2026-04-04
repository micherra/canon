import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";

// Simple per-event-loop-tick cache — avoids reading config.json 3x when
// loadLayerMappings, deriveSourceDirsFromLayers, and loadConfigNumber are called in sequence.
let configCache: {
  projectDir: string;
  result: Record<string, unknown> | null;
  tick: number;
} | null = null;
let currentTick = 0;
const bumpTick = () => {
  queueMicrotask(() => {
    currentTick++;
  });
};

/** Read and parse .canon/config.json, returning null if missing or unparseable. */
async function loadCanonConfig(projectDir: string): Promise<Record<string, unknown> | null> {
  if (configCache && configCache.projectDir === projectDir && configCache.tick === currentTick) {
    return configCache.result;
  }
  bumpTick();

  let raw: string;
  try {
    raw = await readFile(join(projectDir, CANON_DIR, CANON_FILES.CONFIG), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      configCache = { projectDir, result: null, tick: currentTick };
      return null;
    }
    throw err;
  }
  try {
    const result = JSON.parse(raw);
    configCache = { projectDir, result, tick: currentTick };
    return result;
  } catch {
    configCache = { projectDir, result: null, tick: currentTick };
    return null; // invalid JSON
  }
}

/** Default layer mappings — directory patterns to layer names. */
export const DEFAULT_LAYER_MAPPINGS: Record<string, string[]> = {
  api: ["api", "routes", "controllers"],
  data: ["db", "data", "repositories", "prisma"],
  domain: ["services", "domain", "models"],
  infra: ["infra", "deploy", "terraform", "docker"],
  shared: ["utils", "lib", "shared", "types"],
  ui: ["app", "components", "pages", "views"],
};

export type LayerMappings = Record<string, string[]>;

/**
 * Load layer mappings from .canon/config.json, falling back to defaults.
 * Config format: `{ "layers": { "api": ["api", "routes"], "ui": ["components"] } }`
 */
export async function loadLayerMappings(projectDir: string): Promise<LayerMappings> {
  const config = await loadCanonConfig(projectDir);
  if (config?.layers && typeof config.layers === "object" && !Array.isArray(config.layers)) {
    return config.layers as LayerMappings;
  }
  return DEFAULT_LAYER_MAPPINGS;
}

/**
 * Convert a single glob pattern to a RegExp anchored at the start of the path.
 * Supports:
 *   `**`  — any sequence of characters including path separators
 *   `*`   — any sequence of characters except path separators (/ or \)
 *   `?`   — a single character that is not a path separator
 * All other regex special characters are escaped.
 */
function globToRegex(glob: string): RegExp {
  // Escape all regex metacharacters except * and ?, which we handle ourselves.
  // We process the string character-by-character so we can handle ** before *.
  let regexStr = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** — match anything including separators
        regexStr += ".*";
        i++; // consume the second *
      } else {
        // * — match anything except separators
        regexStr += "[^\\/\\\\]*";
      }
    } else if (ch === "?") {
      regexStr += "[^\\/\\\\]";
    } else {
      // Escape regex special characters
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/** Return true if the pattern string contains glob metacharacters. */
function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** Build a layer inference function from a layer mappings object. */
export function buildLayerInferrer(mappings: LayerMappings): (filePath: string) => string {
  const compiled: Array<[RegExp, string]> = [];
  for (const [layer, patterns] of Object.entries(mappings)) {
    if (!Array.isArray(patterns) || patterns.length === 0) continue;

    // Separate glob patterns from simple directory name segments so each
    // can be compiled into the appropriate regex.
    const globs = patterns.filter(isGlobPattern);
    const simples = patterns.filter((p) => !isGlobPattern(p));

    // One regex per glob pattern (each is anchored to the path start).
    for (const glob of globs) {
      compiled.push([globToRegex(glob), layer]);
    }

    // Simple directory name segments use the original segment-matching regex,
    // which matches the name as a full path component anywhere in the path.
    // This preserves the existing behavior for configs like ["api", "routes"].
    if (simples.length > 0) {
      const escaped = simples.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      // Match both '/' and '\\' separators so it works on Windows paths too
      const pattern = new RegExp(`(^|[\\/\\\\])(${escaped.join("|")})([\\/\\\\]|$)`);
      compiled.push([pattern, layer]);
    }
  }
  return (filePath: string) => {
    for (const [pattern, layer] of compiled) {
      if (pattern.test(filePath)) return layer;
    }
    return "unknown";
  };
}

/**
 * Derive scan directories from layer glob patterns in .canon/config.json.
 * For each pattern that contains a '/' before any '*', strips from the first '*'
 * character and trims trailing '/' to yield the scan directory.
 * Plain segment patterns (no '/' before '*') are skipped.
 * Returns null if no rooted patterns are found or if no layers are configured.
 */
function extractDirFromPattern(pattern: string): string | null {
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) return null; // no wildcard — plain segment, skip
  const slashBeforeStar = pattern.lastIndexOf("/", starIdx - 1);
  if (slashBeforeStar === -1) return null; // no '/' before '*' — not a rooted path, skip
  const dir = pattern.slice(0, starIdx).replace(/\/$/, "");
  return dir || null;
}

export async function deriveSourceDirsFromLayers(projectDir: string): Promise<string[] | null> {
  const config = await loadCanonConfig(projectDir);
  if (!config?.layers || typeof config.layers !== "object" || Array.isArray(config.layers)) {
    return null;
  }
  const dirs = new Set<string>();
  for (const patterns of Object.values(config.layers as Record<string, string[]>)) {
    if (!Array.isArray(patterns)) continue;
    for (const pattern of patterns) {
      const dir = extractDirFromPattern(pattern);
      if (dir) dirs.add(dir);
    }
  }
  return dirs.size > 0 ? Array.from(dirs) : null;
}

/**
 * Load layer mappings from config, throwing if not configured.
 * Falls back to defaults via loadLayerMappings if caller catches.
 */
export async function loadLayerMappingsStrict(projectDir: string): Promise<LayerMappings> {
  const config = await loadCanonConfig(projectDir);
  if (config?.layers && typeof config.layers === "object" && !Array.isArray(config.layers)) {
    return config.layers as LayerMappings;
  }
  throw new Error("No layer mappings configured in .canon/config.json");
}

export type GraphCompositionConfig = {
  enabled: boolean;
  markers: string[];
  file_patterns: string[];
  min_confidence: number;
  max_refs_per_file: number;
};

const DEFAULT_MARKERS = ["uses", "includes", "extends", "imports", "references", "source"];

const DEFAULT_COMPOSITION_CONFIG: GraphCompositionConfig = {
  enabled: false,
  file_patterns: [],
  markers: DEFAULT_MARKERS,
  max_refs_per_file: 50,
  min_confidence: 0.5,
};

/** Load graph composition config from .canon/config.json. */
export async function loadGraphCompositionConfig(
  projectDir: string,
): Promise<GraphCompositionConfig> {
  const config = await loadCanonConfig(projectDir);
  const graph = config?.graph as Record<string, unknown> | undefined;
  if (!graph?.composition) return DEFAULT_COMPOSITION_CONFIG;
  const c = graph.composition as Record<string, unknown>;
  return {
    enabled: (c.enabled as boolean) ?? false,
    file_patterns: Array.isArray(c.file_patterns) ? c.file_patterns : [],
    markers: Array.isArray(c.markers) ? c.markers : DEFAULT_MARKERS,
    max_refs_per_file: typeof c.max_refs_per_file === "number" ? c.max_refs_per_file : 50,
    min_confidence: typeof c.min_confidence === "number" ? c.min_confidence : 0.5,
  };
}

/** Read a numeric config value at a dotted path (e.g. "review.max_principles_per_review"). */
export async function loadConfigNumber(
  projectDir: string,
  key: string,
  defaultValue: number,
): Promise<number> {
  const config = await loadCanonConfig(projectDir);
  if (!config) return defaultValue;

  const value = Number(
    key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], config),
  );

  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : defaultValue;
}
