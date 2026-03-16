import { readdir, stat } from "fs/promises";
import { join, relative } from "path";

const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs",
]);

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".canon", "dist", "build",
  ".next", ".nuxt", "coverage", "__pycache__", ".tox",
  "vendor", ".venv", "venv", "target",
]);

/**
 * Recursively scan for source files.
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
    : DEFAULT_INCLUDE_EXTENSIONS;

  const excludeDirs = options?.excludeDirs
    ? new Set(options.excludeDirs)
    : DEFAULT_EXCLUDE_DIRS;

  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
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
          await walk(fullPath);
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

  await walk(rootDir);
  return files.sort();
}
