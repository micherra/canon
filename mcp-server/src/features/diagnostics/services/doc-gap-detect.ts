/**
 * Doc-Gap Detection Service — Find directories lacking CLAUDE.md documentation.
 *
 * Two exports:
 * 1. `detectDocGaps` — pure function, receives pre-scanned directory entries,
 *    returns structured findings.
 * 2. `scanDirectories` — I/O helper, walks the filesystem and produces the
 *    entry array for `detectDocGaps` to consume.
 *
 * Canon principles:
 * - pure-io-service-split: detectDocGaps is pure; scanDirectories is the I/O boundary
 * - simplicity-first: plain functions, no class wrappers
 * - functions-do-one-thing: detection logic separated from filesystem walking
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// ---- Types ----

export type DocGapFinding = {
  directory: string;
  source_file_count: number;
  source_extensions: string[];
};

export type DocGapOutput = {
  gaps: DocGapFinding[];
  directories_scanned: number;
  directories_with_docs: number;
};

type ScanEntry = {
  dir: string;
  files: string[];
  hasClaudeMd: boolean;
};

// ---- Constants ----

/**
 * File extensions that count as "source files" for gap detection.
 * A directory with 2+ of these (and no CLAUDE.md) is flagged.
 */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".sh", ".py", ".go", ".rs"]);

/**
 * Default directories to exclude when scanning.
 */
const DEFAULT_EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  ".canon/workspaces",
  ".canon/worktrees",
  "coverage",
];

// ---- Pure detection function ----

/** Count source files in a file list, grouped by extension. Returns null if < 2 source files. */
function countSourceExtensions(files: string[]): Map<string, number> | null {
  const extCounts = new Map<string, number>();
  for (const file of files) {
    const dot = file.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = file.slice(dot);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const total = [...extCounts.values()].reduce((a, b) => a + b, 0);
  return total >= 2 ? extCounts : null;
}

/**
 * Detect documentation gaps in pre-scanned directory entries.
 *
 * A directory is a gap when:
 * - hasClaudeMd is false, AND
 * - it has 2 or more source files (extensions: .ts, .tsx, .js, .jsx, .sh, .py, .go, .rs)
 */
export function detectDocGaps(entries: ScanEntry[]): DocGapOutput {
  const gaps: DocGapFinding[] = [];
  let directoriesWithDocs = 0;

  for (const entry of entries) {
    if (entry.hasClaudeMd) {
      directoriesWithDocs++;
      continue;
    }
    const extCounts = countSourceExtensions(entry.files);
    if (extCounts === null) continue;

    const totalSourceFiles = [...extCounts.values()].reduce((a, b) => a + b, 0);
    gaps.push({
      directory: entry.dir,
      source_extensions: [...extCounts.keys()].sort(),
      source_file_count: totalSourceFiles,
    });
  }

  return {
    directories_scanned: entries.length,
    directories_with_docs: directoriesWithDocs,
    gaps,
  };
}

// ---- I/O helper ----

/**
 * Check if .claude/CLAUDE.md exists inside a directory.
 */
async function checkDotClaudeMd(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, ".claude", "CLAUDE.md"));
    return s.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        "[canon] doc-gap-detect: stat(.claude/CLAUDE.md) failed for",
        dir,
        ":",
        err instanceof Error ? err.message : err,
      );
    }
    return false;
  }
}

/**
 * Determine whether a directory name should be excluded from scanning.
 */
function isExcluded(
  name: string,
  currentDir: string,
  rootDir: string,
  excludeDirs: string[],
): boolean {
  const relativeDir = currentDir.slice(rootDir.length).replace(/^[/\\]/, "");

  for (const excluded of excludeDirs) {
    if (name === excluded) return true;
    if (excluded.includes("/")) {
      const candidate = relativeDir ? `${relativeDir}/${name}` : name;
      if (candidate.startsWith(excluded)) return true;
    }
  }
  return false;
}

/**
 * Read a single directory: partition entries into files and subdirectory paths.
 * Returns null if the directory is unreadable.
 */
async function readDirEntries(
  currentDir: string,
  rootDir: string,
  excludeDirs: string[],
): Promise<{ files: string[]; subdirs: string[] } | null> {
  let names: string[];
  try {
    names = await readdir(currentDir);
  } catch (err) {
    console.error(
      "[canon] doc-gap-detect: readdir failed for",
      currentDir,
      ":",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const files: string[] = [];
  const subdirs: string[] = [];

  await Promise.all(
    names.map(async (name) => {
      if (isExcluded(name, currentDir, rootDir, excludeDirs)) return;
      const fullPath = join(currentDir, name);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          subdirs.push(fullPath);
        } else {
          files.push(name);
        }
      } catch (err) {
        console.error(
          "[canon] doc-gap-detect: stat failed for",
          fullPath,
          ":",
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  return { files, subdirs };
}

/**
 * Build a single ScanEntry for one directory, recursing into subdirectories in parallel.
 */
async function scanOne(
  currentDir: string,
  rootDir: string,
  excludeDirs: string[],
): Promise<ScanEntry[]> {
  const entries = await readDirEntries(currentDir, rootDir, excludeDirs);
  if (entries === null) return [];

  const { files, subdirs } = entries;
  const [hasClaudeMd, ...childResults] = await Promise.all([
    Promise.resolve(files.includes("CLAUDE.md")).then((direct) =>
      direct ? true : checkDotClaudeMd(currentDir),
    ),
    ...subdirs.map((subdir) => scanOne(subdir, rootDir, excludeDirs)),
  ]);

  return [{ dir: currentDir, files, hasClaudeMd }, ...childResults.flat()];
}

/**
 * Walk `rootDir` recursively and produce directory scan entries for `detectDocGaps`.
 *
 * For each directory encountered:
 * - Lists files (non-recursive, filenames only)
 * - Checks for the presence of CLAUDE.md (or .claude/CLAUDE.md)
 * - Skips directories whose name matches any entry in `excludeDirs`
 *
 * @param rootDir   Absolute path to start scanning from.
 * @param excludeDirs  Directory names/partial paths to skip (default: node_modules, .git, dist, etc.)
 */
export async function scanDirectories(
  rootDir: string,
  excludeDirs: string[] = DEFAULT_EXCLUDE_DIRS,
): Promise<ScanEntry[]> {
  return scanOne(rootDir, rootDir, excludeDirs);
}
