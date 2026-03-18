import { readFile } from "fs/promises";
import { join } from "path";

/** Read and parse .canon/config.json, returning null if missing or invalid. */
async function loadCanonConfig(projectDir: string): Promise<Record<string, any> | null> {
  try {
    const raw = await readFile(join(projectDir, ".canon", "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
