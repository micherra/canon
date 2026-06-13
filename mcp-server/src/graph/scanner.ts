import { readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { SCANNABLE_EXTENSIONS } from "@shared/constants.ts";

// Guard 4 (symlinked node_modules): directories named "node_modules" are excluded
// regardless of whether the entry is a real directory or a symlink-to-dir.
// A symlink-to-dir dirent reports isDirectory() === false (Dirent reflects the
// link, not the target), so processEntry's `entry.isDirectory()` gate naturally
// skips symlinks before the excludeDirs check even fires. The name exclusion here
// is defense-in-depth: if the implementation ever calls realpath before checking
// type (Guard 4 design invariant: never follow symlinks during the primary scan),
// the name exclusion still prevents traversal.
const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules", // name-excluded (see Guard 4 comment above); also skipped by isDirectory() gate for symlinks
  ".git",
  ".canon",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".tox",
  "vendor",
  ".venv",
  "venv",
  "target",
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
  },
): Promise<string[]> {
  const includeExts = options?.includeExtensions
    ? new Set(options.includeExtensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
    : SCANNABLE_EXTENSIONS;

  const excludeDirs = options?.excludeDirs ? new Set(options.excludeDirs) : DEFAULT_EXCLUDE_DIRS;

  const files: string[] = [];
  const visitedDirs = new Set<string>();

  async function tryReadDir(dir: string): Promise<import("node:fs").Dirent[] | null> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      // best-effort: directory may be inaccessible (permissions, deleted); skip it
      return null;
    }
  }

  async function resolveDir(dir: string): Promise<string | null> {
    try {
      return await realpath(dir);
    } catch {
      // best-effort: symlink target may not exist; skip this directory entry
      return null;
    }
  }

  function collectFile(entry: import("node:fs").Dirent, dir: string): void {
    const dotIdx = entry.name.lastIndexOf(".");
    if (dotIdx === -1) return;
    const ext = entry.name.slice(dotIdx);
    if (includeExts.has(ext)) {
      files.push(relative(rootDir, join(dir, entry.name)));
    }
  }

  async function processEntry(
    entry: import("node:fs").Dirent,
    dir: string,
    depth: number,
  ): Promise<void> {
    if (entry.isDirectory() && !excludeDirs.has(entry.name)) {
      await walk(join(dir, entry.name), depth + 1);
    } else if (entry.isFile()) {
      collectFile(entry, dir);
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;

    const realDir = await resolveDir(dir);
    if (!realDir || visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    const entries = await tryReadDir(dir);
    if (!entries) return;

    for (const entry of entries) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential walk required — processEntry mutates shared visitedDirs/files state
      await processEntry(entry, dir, depth);
    }
  }

  await walk(rootDir, 0);
  return files.sort();
}
