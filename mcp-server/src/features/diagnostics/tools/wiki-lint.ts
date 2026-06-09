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
import { VALID_COMPUTED_TAGS } from "@graph/kg-tags.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { loadLayerMappings } from "@shared/lib/config.ts";
import { loadAllPrinciples } from "@shared/matcher.ts";
import type { Principle } from "@shared/parser.ts";
import { checkIndexDrift } from "../services/index-inventory.ts";
import {
  assembleWikiLintOutput,
  checkCitedPaths,
  checkContradictions,
  checkMissingExamples,
  checkOrphanPrinciples,
  checkScopeLayers,
  checkScopeTags,
  checkStaleRefs,
  type WikiLintOutput,
} from "../services/wiki-lint.ts";

// ---- Types ----

type CheckName =
  | "contradictions"
  | "orphan_principles"
  | "stale_refs"
  | "missing_examples"
  | "cited_paths"
  | "scope_layers"
  | "scope_tags"
  | "index_drift";

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
  } catch (err) {
    console.warn(
      "[canon] wiki-lint: stat failed for",
      fullPath,
      ":",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

type FindFilesCtx = {
  predicate: (filePath: string, fileName: string) => boolean;
  results: string[];
  originalRoot: string;
};

/** Process one directory entry during recursive scan. */
function processEntry(fullPath: string, name: string, ctx: FindFilesCtx): void {
  const info = statEntry(fullPath);
  if (!info) return;
  if (info.isDir) {
    if (!isExcludedDir(fullPath, name, ctx.originalRoot)) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      scanDir(fullPath, ctx);
    }
  } else if (info.isFile && ctx.predicate(fullPath, name)) {
    ctx.results.push(fullPath);
  }
}

/** Inner scan loop — reads a directory and recurses. */
function scanDir(currentDir: string, ctx: FindFilesCtx): void {
  let names: string[];
  try {
    names = readdirSync(currentDir, { encoding: "utf8" });
  } catch (err) {
    console.warn(
      "[canon] wiki-lint: readdir failed for",
      currentDir,
      ":",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  for (const name of names) {
    processEntry(join(currentDir, name), name, ctx);
  }
}

/**
 * Recursively find all files matching the predicate under rootDir,
 * skipping excluded directory names.
 *
 * `originalRoot` is threaded through all recursive calls so that
 * `isExcludedDir` always computes relative paths from the scan root,
 * not from the current recursion depth.
 */
function findFiles(
  rootDir: string,
  predicate: (filePath: string, fileName: string) => boolean,
  results: string[] = [],
): string[] {
  scanDir(rootDir, { originalRoot: rootDir, predicate, results });
  return results;
}

/** Read a file safely, returning null on any error. */
function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(
      "[canon] wiki-lint: readFile failed for",
      filePath,
      ":",
      err instanceof Error ? err.message : err,
    );
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

// ---- DDD doc set collector ----

/**
 * Collect the DDD doc set for citation linting:
 *   docs/ (excluding docs/explore/), domains/<name>/README.md, root CONTEXT.md.
 *
 * docs/explore/ holds frozen point-in-time records (proposals, judge sheets) that are
 * stale-by-design — linting them yields guaranteed false findings (decision ddd-doc-freshness-02).
 * Live filesystem scan (not KG) so the check never silently degrades on a cold/stale graph
 * store (observable-best-effort — this file has prior violations of that principle).
 */
function collectDddDocPaths(projectDir: string): string[] {
  const paths: string[] = [];

  // docs/**/*.md, excluding docs/explore/**
  const docsDir = join(projectDir, "docs");
  const docsMdPaths = findFiles(docsDir, (_fp, name) => name.endsWith(".md"));
  for (const absPath of docsMdPaths) {
    // Compute repo-relative path using same idiom as isExcludedDir
    const relPath = absPath.slice(projectDir.length + 1);
    if (!relPath.startsWith("docs/explore/")) {
      paths.push(absPath);
    }
  }

  // mcp-server/src/domains/*/README.md
  const domainsDir = join(projectDir, "mcp-server", "src", "domains");
  const domainReadmePaths = findFiles(domainsDir, (_fp, name) => name === "README.md");
  paths.push(...domainReadmePaths);

  // root CONTEXT.md (if present)
  const contextMdPath = join(projectDir, "CONTEXT.md");
  if (existsSync(contextMdPath)) {
    paths.push(contextMdPath);
  }

  return paths;
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
  } catch (err) {
    console.warn(
      "[canon] wiki-lint: DriftStore.getReviews() failed — orphan check will treat all principles as unviolated:",
      err instanceof Error ? err.message : err,
    );
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
  dddDocFiles: FileRecord[],
): ReturnType<typeof checkStaleRefs> {
  const workspacesDir = join(projectDir, ".canon", "workspaces");
  const planPaths = findFiles(
    workspacesDir,
    (_fp, name) => name.endsWith("-PLAN.md") || name === "DESIGN.md",
  );
  const planFiles = loadFileRecords(planPaths);
  const allFiles = [...claudeMdFiles, ...planFiles, ...dddDocFiles];
  const existsOnDisk = (refPath: string): boolean => existsSync(join(projectDir, refPath));
  return checkStaleRefs(allFiles, existsOnDisk);
}

function runCitedPathCheck(
  projectDir: string,
  dddDocFiles: FileRecord[],
): ReturnType<typeof checkCitedPaths> {
  const referencesDir = join(projectDir, "references");
  const refPaths = findFiles(referencesDir, (_fp, name) => name.endsWith(".md"));
  const refFiles = loadFileRecords(refPaths);
  const existsOnDisk = (refPath: string): boolean => existsSync(join(projectDir, refPath));
  return checkCitedPaths([...refFiles, ...dddDocFiles], existsOnDisk);
}

// ---- Main tool function ----

/**
 * Run wiki lint checks against Canon's own meta-layer artifacts.
 *
 * @param input - Which checks to run (default: all 7)
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
    "cited_paths",
    "scope_layers",
    "scope_tags",
    "index_drift",
  ];
  const enabled = new Set<CheckName>(input.checks ?? ALL_CHECKS);

  const principles = await loadAllPrinciples(projectDir, pluginDir);
  const claudeMdPaths = findFiles(projectDir, (_fp, name) => name === "CLAUDE.md");
  const claudeMdFiles = loadFileRecords(claudeMdPaths);

  const agentsDir = join(pluginDir, "agents");
  const agentFiles = loadFileRecords(findFiles(agentsDir, (_fp, name) => name.endsWith(".md")));

  // DDD doc set: docs/**/*.md (excl. docs/explore/), domains/*/README.md, CONTEXT.md.
  // Collected once and threaded into both stale_refs and cited_paths runners.
  const dddDocFiles =
    enabled.has("stale_refs") || enabled.has("cited_paths")
      ? loadFileRecords(collectDddDocPaths(projectDir))
      : [];

  const contradictions = enabled.has("contradictions") ? checkContradictions(claudeMdFiles) : [];
  const orphans = enabled.has("orphan_principles")
    ? await runOrphanCheck(projectDir, principles, claudeMdFiles, agentFiles)
    : [];
  const staleRefs = enabled.has("stale_refs")
    ? runStaleRefCheck(projectDir, claudeMdFiles, dddDocFiles)
    : [];
  const missingExamples = enabled.has("missing_examples") ? checkMissingExamples(principles) : [];
  const citedPaths = enabled.has("cited_paths") ? runCitedPathCheck(projectDir, dddDocFiles) : [];
  const validLayers = enabled.has("scope_layers")
    ? Object.keys(await loadLayerMappings(projectDir))
    : [];
  const scopeLayers = enabled.has("scope_layers") ? checkScopeLayers(principles, validLayers) : [];
  const scopeTags = enabled.has("scope_tags")
    ? checkScopeTags(principles, VALID_COMPUTED_TAGS)
    : [];
  const indexDrift = enabled.has("index_drift") ? await checkIndexDrift(projectDir) : [];

  return assembleWikiLintOutput({
    citedPaths,
    contradictions,
    filesScanned: claudeMdFiles.length + agentFiles.length + dddDocFiles.length,
    indexDrift,
    missingExamples,
    orphans,
    principlesChecked: principles.length,
    scopeLayers,
    scopeTags,
    staleRefs,
  });
}
