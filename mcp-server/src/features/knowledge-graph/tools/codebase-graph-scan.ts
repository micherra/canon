/**
 * Codebase Graph — File Scanning Helpers
 *
 * Extracted from codebase-graph.ts: directory scanning, changed file detection,
 * and git helpers used during graph construction.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { scanSourceFiles } from "@graph/scanner.ts";
import { gitExecAsync } from "@platform/adapters/git-adapter-async.ts";
import { deriveSourceDirsFromLayers } from "@shared/lib/config.ts";
import { sanitizeGitRef } from "@shared/lib/git-ref.ts";
import { toPosix } from "@shared/lib/paths.ts";
import type { CodebaseGraphInput } from "./codebase-graph.ts";

/** Canon directories to scan for .md nodes (agents, flows, templates, principles, docs, domains). */
export const CANON_SCAN_DIRS = [
  "agents",
  "flows",
  "templates",
  "principles",
  "skills",
  "docs",
  "mcp-server/src/domains",
];

/** Root-level singleton .md files outside any scan directory. */
export const CANON_SCAN_FILES = ["CONTEXT.md"];

export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  const result = await gitExecAsync(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

export async function gitChangedFiles(cwd: string, base: string): Promise<string[]> {
  const result = await gitExecAsync(["diff", "--name-only", `${base}...HEAD`], cwd);
  if (!result.ok) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

export async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const result = await gitExecAsync(["rev-parse", "--verify", ref], cwd);
  return result.ok;
}

/** Scan files from configured source directories. */
export async function scanFromSourceDirs(
  sourceDirs: string[],
  projectDir: string,
  input: CodebaseGraphInput,
): Promise<string[]> {
  const dirResults = await Promise.all(
    sourceDirs.map(async (dir) => {
      const absDir = join(projectDir, dir);
      const scanned = await scanSourceFiles(absDir, {
        excludeDirs: input.exclude_dirs,
        includeExtensions: input.include_extensions,
      });
      return scanned.map((f) => toPosix(join(dir, f)));
    }),
  );
  return dirResults.flat();
}

/** Scan files from a root directory fallback. */
export async function scanFromRootDir(
  rootDir: string,
  projectDir: string,
  input: CodebaseGraphInput,
): Promise<string[]> {
  const abs = isAbsolute(rootDir);
  const resolvedDir = rootDir === "." || abs ? rootDir : join(projectDir, rootDir);
  const scanned = await scanSourceFiles(resolvedDir, {
    excludeDirs: input.exclude_dirs,
    includeExtensions: input.include_extensions,
  });
  const prefix = rootDir === "." || abs ? "" : rootDir;
  return prefix ? scanned.map((f) => toPosix(join(prefix, f))) : scanned.map(toPosix);
}

/** Scan Canon .md directories not covered by source dirs. */
export async function scanCanonDirs(
  coveredDirs: Set<string>,
  projectDir: string,
): Promise<string[]> {
  const activeDirs = CANON_SCAN_DIRS.filter((d) => !coveredDirs.has(d));
  const dirResults = await Promise.all(
    activeDirs.map(async (canonDir) => {
      try {
        const absDir = join(projectDir, canonDir);
        const scanned = await scanSourceFiles(absDir, { includeExtensions: [".md"] });
        return scanned.map((f) => toPosix(join(canonDir, f)));
      } catch {
        /* Directory may not exist */
        return [];
      }
    }),
  );
  return dirResults.flat();
}

export async function scanProjectFiles(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<string[]> {
  const explicitSourceDirs = input.source_dirs;
  const configSourceDirs = await deriveSourceDirsFromLayers(projectDir);
  const sourceDirs = explicitSourceDirs || configSourceDirs;
  let baseFiles: string[] = [];

  if (sourceDirs && sourceDirs.length > 0) {
    baseFiles = await scanFromSourceDirs(sourceDirs, projectDir, input);
  } else if (input.root_dir) {
    baseFiles = await scanFromRootDir(input.root_dir, projectDir, input);
  }

  const coveredDirs = new Set((sourceDirs || []).map(toPosix));
  const canonFiles = await scanCanonDirs(coveredDirs, projectDir);
  baseFiles.push(...canonFiles);

  // Append root-level singleton docs that exist on disk (posix-normalized; dedup handled by Set).
  for (const singletonFile of CANON_SCAN_FILES) {
    if (existsSync(join(projectDir, singletonFile))) {
      baseFiles.push(toPosix(singletonFile));
    }
  }

  return Array.from(new Set(baseFiles)).sort();
}

/** Determine the diff base ref for changed-file detection. */
export async function resolveDiffBase(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<string | null> {
  if (input.diff_base) return input.diff_base;
  if (await gitRefExists(projectDir, "origin/main")) return "origin/main";
  if (await gitRefExists(projectDir, "origin/master")) return "origin/master";
  return null;
}

export async function detectChangedFiles(
  input: CodebaseGraphInput,
  projectDir: string,
): Promise<Set<string>> {
  if (input.changed_files && input.changed_files.length > 0) {
    return new Set(input.changed_files.map(toPosix));
  }

  const branch = await gitCurrentBranch(projectDir);
  if (!branch || branch === "main" || branch === "master") {
    return new Set<string>();
  }

  const rawBase = await resolveDiffBase(input, projectDir);
  if (!rawBase) return new Set<string>();

  let base: string;
  try {
    base = sanitizeGitRef(rawBase);
  } catch {
    console.warn(
      `codebase-graph: invalid diff_base "${rawBase}" — skipping changed-file detection`,
    );
    return new Set<string>();
  }

  const changedFiles = await gitChangedFiles(projectDir, base);
  return new Set(changedFiles.map(toPosix));
}
