import { readFile } from "fs/promises";
import { join } from "path";
import { CANON_DIR, CANON_FILES } from "../constants.js";

// Simple per-event-loop-tick cache — avoids reading config.json 3x when
// loadLayerMappings, loadSourceDirs, and loadConfigNumber are called in sequence.
let configCache: { projectDir: string; result: Record<string, any> | null; tick: number } | null = null;
let currentTick = 0;
const bumpTick = () => { queueMicrotask(() => { currentTick++; }); };

/** Read and parse .canon/config.json, returning null if missing or unparseable. */
async function loadCanonConfig(projectDir: string): Promise<Record<string, any> | null> {
  if (configCache && configCache.projectDir === projectDir && configCache.tick === currentTick) {
    return configCache.result;
  }
  bumpTick();

  let raw: string;
  try {
    raw = await readFile(join(projectDir, CANON_DIR, CANON_FILES.CONFIG), "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
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
  ui: ["app", "components", "pages", "views"],
  domain: ["services", "domain", "models"],
  data: ["db", "data", "repositories", "prisma"],
  infra: ["infra", "deploy", "terraform", "docker"],
  shared: ["utils", "lib", "shared", "types"],
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

/** Build a layer inference function from a layer mappings object. */
export function buildLayerInferrer(mappings: LayerMappings): (filePath: string) => string {
  const compiled: Array<[RegExp, string]> = [];
  for (const [layer, dirs] of Object.entries(mappings)) {
    if (!Array.isArray(dirs) || dirs.length === 0) continue;
    const escaped = dirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Match both '/' and '\\' separators so it works on Windows paths too
    const pattern = new RegExp(`(^|[\\/\\\\])(${escaped.join("|")})([\\/\\\\]|$)`);
    compiled.push([pattern, layer]);
  }
  return (filePath: string) => {
    for (const [pattern, layer] of compiled) {
      if (pattern.test(filePath)) return layer;
    }
    return "unknown";
  };
}

/** Read source_dirs from .canon/config.json if it exists. */
export async function loadSourceDirs(projectDir: string): Promise<string[] | null> {
  const config = await loadCanonConfig(projectDir);
  if (config && Array.isArray(config.source_dirs) && config.source_dirs.length > 0) {
    return config.source_dirs;
  }
  return null;
}

/** Read a numeric config value at a dotted path (e.g. "review.max_principles_per_review"). */
export async function loadConfigNumber(
  projectDir: string,
  key: string,
  defaultValue: number,
): Promise<number> {
  const config = await loadCanonConfig(projectDir);
  if (!config) return defaultValue;
  const parts = key.split(".");
  let current: any = config;
  for (const part of parts) {
    current = current?.[part];
  }
  const value = Number(current);
  if (!Number.isFinite(value) || value < 1) return defaultValue;
  return Math.floor(value);
}
