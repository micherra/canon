/**
 * Context Manifest — content-hash manifest of Canon's context artifact corpus.
 *
 * The manifest tracks sha256 hashes of every markdown file in the 6 canonical
 * context directories so that staleness drift (between an installed plugin and
 * its committed reference) can be detected deterministically.
 *
 * Design: pure functions + one light I/O seam each.
 * - `buildContextManifest(rootDir)` — scans the 6 corpus dirs, hashes each .md
 *   file, and reads the plugin version. Written once per release to
 *   `context-manifest.json` at repo root.
 * - `checkContextStaleness(installedDir, manifest)` — recomputes installed
 *   hashes and compares against the committed manifest.
 *
 * Reuses `hashContent` from `@domains/workspaces/context-provenance.ts` —
 * no-dead-abstractions: we do NOT re-implement sha256.
 *
 * Note: To regenerate `context-manifest.json` after updating corpus files, run
 * `cd mcp-server && npm run regen:context-manifest` from the repo root.
 *
 * Canon principles:
 * - errors-are-values: all error conditions surface as result union; no throws
 * - deep-modules: two pure functions + thin I/O; callers see a simple contract
 * - no-dead-abstractions: reuse hashContent from context-provenance.ts
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { hashContent } from "@domains/workspaces/context-provenance.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContextManifest = {
  /** Plugin version string from .claude-plugin/plugin.json, or "unknown" on read failure. */
  version: string;
  /** POSIX-relative path → sha256 hex. Keys sorted lexicographically. */
  artifacts: Record<string, string>;
};

export type StalenessReport = {
  /** Paths present in both manifest and installed tree but with different hashes. */
  drifted: string[];
  /** Paths in manifest but absent or unreadable in installed tree. */
  missing: string[];
  /** Paths in installed tree but absent from manifest. */
  extra: string[];
  /** true iff drifted, missing, and extra are all empty. */
  clean: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The 6 corpus directories scanned by buildContextManifest.
 * These are the directories that contain the agent-facing context artifacts.
 */
const CORPUS_DIRS = [
  "principles",
  "rules",
  "references",
  "primers",
  "agents",
  "templates",
] as const;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

type DirEntry = { entry: string; fullPath: string; isDir: boolean; isMd: boolean };

/**
 * List the stat-enriched entries of a directory. Returns [] on ENOENT/ENOTDIR.
 * Entries with unreadable stat are silently excluded.
 */
async function listEntries(dir: string): Promise<DirEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  const results = await Promise.all(
    names.map(async (entry): Promise<DirEntry | null> => {
      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        return { entry, fullPath, isDir: s.isDirectory(), isMd: entry.endsWith(".md") };
      } catch {
        return null; // broken symlinks etc.
      }
    }),
  );
  return results.filter((r): r is DirEntry => r !== null);
}

/**
 * Recursively collect all .md files under `dir`, returning POSIX-relative paths
 * from `rootDir`. Uses Promise.all at each level — no await in loops.
 * ENOENT/ENOTDIR returns [] (corpus dirs may be absent in some installs).
 */
async function collectMarkdownFiles(dir: string, rootDir: string): Promise<string[]> {
  const entries = await listEntries(dir);
  const sorted = entries.slice().sort((a, b) => a.entry.localeCompare(b.entry));

  const subdirResults = await Promise.all(
    sorted.filter((e) => e.isDir).map((e) => collectMarkdownFiles(e.fullPath, rootDir)),
  );

  const mdFiles = sorted
    .filter((e) => e.isMd)
    .map((e) => relative(rootDir, e.fullPath).split("\\").join(posix.sep));

  return [...mdFiles, ...subdirResults.flat()];
}

/**
 * Read plugin version from .claude-plugin/plugin.json.
 * Returns "unknown" on any read or parse failure — errors-are-values.
 */
async function readPluginVersion(rootDir: string): Promise<string> {
  try {
    const content = await readFile(join(rootDir, ".claude-plugin", "plugin.json"), "utf-8");
    const parsed = JSON.parse(content) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Hash a single file. Returns null when the file is unreadable (treat as missing).
 * Never returns "" so an unreadable file cannot be confused with "drifted".
 */
async function hashFile(fullPath: string): Promise<string | null> {
  try {
    const content = await readFile(fullPath, "utf-8");
    return hashContent(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Build a ContextManifest by scanning the 6 corpus directories under `rootDir`.
 *
 * - Reads each .md file and hashes its content with sha256 (via `hashContent`).
 * - Keys are POSIX-relative paths, sorted lexicographically for determinism.
 * - `version` is read from `.claude-plugin/plugin.json`; falls back to "unknown".
 *
 * @param rootDir — absolute path to the repo root (or any dir that contains
 *   the 6 corpus directories + .claude-plugin/plugin.json).
 */
export async function buildContextManifest(rootDir: string): Promise<ContextManifest> {
  const version = await readPluginVersion(rootDir);

  const allPathArrays = await Promise.all(
    CORPUS_DIRS.map((dir) => collectMarkdownFiles(join(rootDir, dir), rootDir)),
  );
  const allPaths = allPathArrays.flat().sort();

  const artifactEntries = await Promise.all(
    allPaths.map(async (relPath) => {
      const content = await readFile(join(rootDir, relPath), "utf-8");
      return [relPath, hashContent(content)] as const;
    }),
  );

  return { artifacts: Object.fromEntries(artifactEntries), version };
}

/**
 * Compare an installed directory against a committed manifest to detect drift.
 *
 * - `drifted`: paths present in both manifest and installed tree with different hashes.
 * - `missing`: paths in manifest but absent or unreadable on disk.
 *   An unreadable file is treated as missing — never hashed as `""` (which
 *   would silently produce a "drifted" finding instead of the correct "missing").
 * - `extra`: markdown paths in the corpus dirs that are not in the manifest.
 * - `clean`: true iff all three lists are empty.
 *
 * @param installedDir — path to scan (typically the plugin install directory).
 * @param manifest — the committed reference manifest.
 */
export async function checkContextStaleness(
  installedDir: string,
  manifest: ContextManifest,
): Promise<StalenessReport> {
  const manifestPaths = new Set(Object.keys(manifest.artifacts));

  // Hash every manifest path in parallel; null = unreadable → missing
  const hashResults = await Promise.all(
    Object.entries(manifest.artifacts).map(async ([relPath, manifestHash]) => {
      const installed = await hashFile(join(installedDir, relPath));
      return { installedHash: installed, manifestHash, relPath };
    }),
  );

  // Collect installed corpus paths in parallel to detect extras
  const installedPathArrays = await Promise.all(
    CORPUS_DIRS.map((dir) => collectMarkdownFiles(join(installedDir, dir), installedDir)),
  );
  const installedPaths = installedPathArrays.flat();

  return classifyStaleness(hashResults, installedPaths, manifestPaths);
}

// ---------------------------------------------------------------------------
// Pure classifier (extracted for complexity split)
// ---------------------------------------------------------------------------

type HashResult = { relPath: string; installedHash: string | null; manifestHash: string };

function classifyStaleness(
  hashResults: HashResult[],
  installedPaths: string[],
  manifestPaths: Set<string>,
): StalenessReport {
  const drifted: string[] = [];
  const missing: string[] = [];

  for (const { relPath, installedHash, manifestHash } of hashResults) {
    if (installedHash === null) {
      missing.push(relPath);
    } else if (installedHash !== manifestHash) {
      drifted.push(relPath);
    }
  }

  const extra = installedPaths.filter((p) => !manifestPaths.has(p));

  drifted.sort();
  missing.sort();
  extra.sort();

  return {
    clean: drifted.length === 0 && missing.length === 0 && extra.length === 0,
    drifted,
    extra,
    missing,
  };
}
