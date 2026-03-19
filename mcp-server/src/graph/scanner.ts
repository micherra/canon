import { readdir, realpath } from "fs/promises";
import { join, relative } from "path";
import { SCANNABLE_EXTENSIONS } from "../constants.js";

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".canon", "dist", "build",
  ".next", ".nuxt", "coverage", "__pycache__", ".tox",
  "vendor", ".venv", "venv", "target",
]);

const MAX_DEPTH = 50;

/**
 * Recursively scan for source files.
 * Tracks visited directories by realpath to prevent symlink loops.
 */
export async function scanSourceFiles(
  rootDir: string,
  options?: {
    includeExtensions?: string[];
    excludeDirs?: string[];
  }
): Promise<string[]> {
  const includeExts = options?.includeExtensions
    ? new Set(options.includeExtensions.map((e) => (e.startsWith(".") ? e : "." + e)))
    : SCANNABLE_EXTENSIONS;

  const excludeDirs = options?.excludeDirs
    ? new Set(options.excludeDirs)
    : DEFAULT_EXCLUDE_DIRS;

  const files: string[] = [];
  const visitedDirs = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;

    // Resolve symlinks to detect cycles
    let realDir: string;
    try {
      realDir = await realpath(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          await walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const dotIdx = entry.name.lastIndexOf(".");
        if (dotIdx !== -1) {
          const ext = entry.name.slice(dotIdx);
          if (includeExts.has(ext)) {
            files.push(relative(rootDir, fullPath));
          }
        }
      }
    }
  }

  await walk(rootDir, 0);
  return files.sort();
}
