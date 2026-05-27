/**
 * Wiki-Lint MCP Tool Handler
 *
 * I/O layer: loads principles, reviews, scans filesystem, then delegates to
 * pure service functions in `services/wiki-lint.ts`.
 *
 * Canon principles:
 * - simplicity-first: one function, no middleware
 * - errors-are-values: infrastructure failures produce graceful degradation
 * - pure-io-service-split: all I/O here; computation in service layer
 * - validate-at-trust-boundaries: Zod validates input at registration
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { loadAllPrinciples } from "@shared/matcher.ts";
import type { Principle } from "@shared/parser.ts";
import {
  assembleWikiLintOutput,
  checkContradictions,
  checkMissingExamples,
  checkOrphanPrinciples,
  checkStaleRefs,
  type WikiLintOutput,
} from "../services/wiki-lint.ts";

// ---- Types ----

type CheckName = "contradictions" | "orphan_principles" | "stale_refs" | "missing_examples";

export type WikiLintInput = {
  checks?: CheckName[];
};

type FileRecord = { path: string; content: string };

// ---- Filesystem helpers ----

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);
const EXCLUDED_DIR_PREFIXES = [".canon/workspaces", ".canon/worktrees"];

/** Return true if the directory at `fullPath` with basename `name` should be skipped. */
function isExcludedDir(fullPath: string, name: string, rootDir: string): boolean {
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  const relPath = fullPath.slice(rootDir.length + 1);
  return EXCLUDED_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** Stat a single path; return { isDir, isFile } or null on error. */
function statEntry(fullPath: string): { isDir: boolean; isFile: boolean } | null {
  try {
    const s = statSync(fullPath);
    return { isDir: s.isDirectory(), isFile: s.isFile() };
  } catch {
    return null;
  }
}

/**
 * Recursively find all files matching the predicate under rootDir,
 * skipping excluded directory names.
 */
function findFiles(
  rootDir: string,
  predicate: (filePath: string, fileName: string) => boolean,
  results: string[] = [],
): string[] {
  let names: string[];
  try {
    names = readdirSync(rootDir, { encoding: "utf8" });
  } catch {
    return results;
  }
  for (const name of names) {
    const fullPath = join(rootDir, name);
    const info = statEntry(fullPath);
    if (!info) continue;
    if (info.isDir) {
      if (isExcludedDir(fullPath, name, rootDir)) continue;
      findFiles(fullPath, predicate, results);
    } else if (info.isFile && predicate(fullPath, name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Read a file safely, returning null on any error. */
function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Load a list of paths into FileRecord[], skipping unreadable files. */
function loadFileRecords(paths: string[]): FileRecord[] {
  return paths
    .map((p) => {
      const content = readFileSafe(p);
      return content !== null ? { content, path: p } : null;
    })
    .filter((f): f is FileRecord => f !== null);
}

// ---- Check helpers ----

async function runOrphanCheck(
  projectDir: string,
  principles: Principle[],
  claudeMdFiles: FileRecord[],
  agentFiles: FileRecord[],
): Promise<ReturnType<typeof checkOrphanPrinciples>> {
  let violatedIds = new Set<string>();
  try {
    const store = new DriftStore(projectDir);
    const reviews = await store.getReviews();
    for (const review of reviews) {
      for (const v of review.violations) {
        violatedIds.add(v.principle_id);
      }
    }
  } catch {
    violatedIds = new Set<string>();
  }

  const allText = [...claudeMdFiles, ...agentFiles].map((f) => f.content).join("\n");
  const referencedIds = new Set<string>();
  for (const p of principles) {
    if (allText.includes(p.id)) referencedIds.add(p.id);
  }

  return checkOrphanPrinciples(principles, violatedIds, referencedIds);
}

function runStaleRefCheck(
  projectDir: string,
  claudeMdFiles: FileRecord[],
): ReturnType<typeof checkStaleRefs> {
  const workspacesDir = join(projectDir, ".canon", "workspaces");
  const planPaths = findFiles(
    workspacesDir,
    (_fp, name) => name.endsWith("-PLAN.md") || name === "DESIGN.md",
  );
  const planFiles = loadFileRecords(planPaths);
  const allFiles = [...claudeMdFiles, ...planFiles];
  const existsOnDisk = (refPath: string): boolean => existsSync(join(projectDir, refPath));
  return checkStaleRefs(allFiles, existsOnDisk);
}

// ---- Main tool function ----

/**
 * Run wiki lint checks against Canon's own meta-layer artifacts.
 *
 * @param input - Which checks to run (default: all 4)
 * @param projectDir - Project root (for CLAUDE.md scanning, stale ref resolution, drift store)
 * @param pluginDir - Plugin directory (for principles loading, agent definitions)
 */
export async function wikiLint(
  input: WikiLintInput,
  projectDir: string,
  pluginDir: string,
): Promise<WikiLintOutput> {
  const ALL_CHECKS: CheckName[] = [
    "contradictions",
    "orphan_principles",
    "stale_refs",
    "missing_examples",
  ];
  const enabled = new Set<CheckName>(input.checks ?? ALL_CHECKS);

  const principles = await loadAllPrinciples(projectDir, pluginDir);
  const claudeMdPaths = findFiles(projectDir, (_fp, name) => name === "CLAUDE.md");
  const claudeMdFiles = loadFileRecords(claudeMdPaths);

  const agentsDir = join(pluginDir, "agents");
  const agentFiles = loadFileRecords(findFiles(agentsDir, (_fp, name) => name.endsWith(".md")));

  const contradictions = enabled.has("contradictions") ? checkContradictions(claudeMdFiles) : [];
  const orphans = enabled.has("orphan_principles")
    ? await runOrphanCheck(projectDir, principles, claudeMdFiles, agentFiles)
    : [];
  const staleRefs = enabled.has("stale_refs") ? runStaleRefCheck(projectDir, claudeMdFiles) : [];
  const missingExamples = enabled.has("missing_examples") ? checkMissingExamples(principles) : [];

  return assembleWikiLintOutput({
    contradictions,
    filesScanned: claudeMdFiles.length + agentFiles.length,
    missingExamples,
    orphans,
    principlesChecked: principles.length,
    staleRefs,
  });
}
