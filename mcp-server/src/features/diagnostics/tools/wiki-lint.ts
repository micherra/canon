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

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { VALID_COMPUTED_TAGS } from "@graph/kg-tags.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { loadLayerMappings } from "@shared/lib/config.ts";
import { loadAllPrinciples } from "@shared/matcher.ts";
import type { Principle } from "@shared/parser.ts";
import {
  checkFrontmatterSchema,
  classifyFmClass,
  type FrontmatterSchemaFinding,
  type FrontmatterSchemaInput,
} from "../services/frontmatter-schema.ts";
import { checkIndexDrift } from "../services/index-inventory.ts";
import {
  buildLinkGraph,
  type KnownTargets,
  type LinkGraphInput,
  type LinkGraphResult,
} from "../services/link-graph.ts";
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
import { checkGlossaryConsistency } from "../services/wiki-lint-glossary.ts";
import {
  checkDuplicateTitles,
  checkMisroutedPrinciples,
} from "../services/wiki-lint-principle-tier.ts";

// ---- Types ----

type CheckName =
  | "cited_paths"
  | "contradictions"
  | "duplicate_titles"
  | "frontmatter_schema"
  | "glossary_consistency"
  | "link_integrity"
  | "missing_examples"
  | "misrouted_principles"
  | "orphan_principles"
  | "scope_layers"
  | "scope_tags"
  | "index_drift"
  | "stale_refs";

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

/**
 * Orphan check. A principle is an orphan iff it has zero DriftStore violations AND
 * zero inbound `[[ ]]` links in the corpus link graph.
 *
 * `referencedIds` comes from the link graph (ADR-0019) — the structurally-correct
 * inbound-link set that REPLACES the old `allText.includes(p.id)` substring scan
 * (over-broad: any incidental prose substring suppressed a real orphan).
 */
async function runOrphanCheck(
  projectDir: string,
  principles: Principle[],
  referencedIds: Set<string>,
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

/** Read CONTEXT.md and run the glossary consistency check; returns [] when file is absent. */
function runGlossaryCheck(projectDir: string): ReturnType<typeof checkGlossaryConsistency> {
  const contextMdPath = join(projectDir, "CONTEXT.md");
  const content = readFileSafe(contextMdPath);
  if (content === null) return [];
  return checkGlossaryConsistency({ content, path: contextMdPath });
}

/** Matches a leading frontmatter fence and captures the inner YAML block. */
const FRONTMATTER_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Strip a known leading root from an absolute path → repo-relative form. */
function relativeTo(absPath: string, root: string): string | null {
  const prefix = `${root}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : null;
}

/**
 * Load one corpus file into a schema-check input, or null when it should be
 * skipped (unclassified path or unreadable file).
 */
function toFrontmatterSchemaInput(
  absPath: string,
  projectDir: string,
  pluginDir: string,
): FrontmatterSchemaInput | null {
  // Repo-relative path drives class resolution (mirrors the corpus layout).
  const repoRel = relativeTo(absPath, projectDir) ?? relativeTo(absPath, pluginDir) ?? absPath;
  const fmClass = classifyFmClass(repoRel);
  if (!fmClass) return null;

  const content = readFileSafe(absPath);
  if (content === null) return null;

  const match = FRONTMATTER_FENCE_RE.exec(content);
  return { fm_class: fmClass, path: repoRel, rawFrontmatter: match ? match[1] : "" };
}

/**
 * Enumerate the schema-bearing corpus (principles, .canon/principles, agents,
 * templates, docs/adr), slice each file's raw frontmatter block, classify it, and
 * run the pure per-class schema check (R1, ADR-0018).
 *
 * Files that don't classify (index docs, loops/routines — own validation) are
 * skipped. I/O lives here; computation in services/frontmatter-schema.ts.
 */
function runFrontmatterSchemaCheck(
  projectDir: string,
  pluginDir: string,
): FrontmatterSchemaFinding[] {
  // Class roots: principles ship from pluginDir; .canon/principles is project-local.
  const roots = [
    join(pluginDir, "principles"),
    join(projectDir, ".canon", "principles"),
    join(pluginDir, "agents"),
    join(pluginDir, "templates"),
    join(projectDir, "docs", "adr"),
  ];

  const inputs: FrontmatterSchemaInput[] = [];
  for (const root of roots) {
    for (const absPath of findFiles(root, (_fp, name) => name.endsWith(".md"))) {
      const input = toFrontmatterSchemaInput(absPath, projectDir, pluginDir);
      if (input) inputs.push(input);
    }
  }

  return checkFrontmatterSchema(inputs);
}

// ---- Link integrity (R2, ADR-0019) ----

/** Strip the leading `projectDir/` from an absolute path → repo-relative form. */
function toRepoRel(absPath: string, projectDir: string): string {
  const prefix = `${projectDir}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

/** File stem without the `.md` extension (e.g. `prd` for `…/templates/prd.md`). */
function fileStem(absPath: string): string {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1);
  return base.replace(/\.md$/, "");
}

/** ADR number (`0017`) when the filename matches `NNNN-*.md`, else null. */
function adrNumberOf(absPath: string): string | null {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1);
  const m = /^(\d{4})-.+\.md$/.exec(base);
  return m ? m[1] : null;
}

/**
 * Build the corpus link graph once: scan all project `.md` files (standard
 * exclusions) PLUS the plugin corpus when `pluginDir` differs from `projectDir`
 * (the normal user-project case). Construct `KnownTargets` (principle ids + file
 * stems + ADR numbers + file paths), and run the pure graph builder with an
 * injected `existsOnDisk`.
 *
 * When `projectDir` and `pluginDir` resolve to the same real directory (e.g. when
 * developing Canon itself), the plugin corpus is not scanned a second time —
 * de-duplication is handled by normalised-path comparison so each file is a link
 * source and resolution target at most once.
 *
 * The single result is shared by both `link_integrity` (broken-link findings) and
 * `orphan_principles` (inbound-link orphan source-of-truth, ADR-0019) so the corpus
 * is parsed only once.
 *
 * Exported for unit testing (I/O boundary — kept in the tool layer, not the service).
 */
// canon:allow-unwired: exported for unit testing; called from runEnabledChecks in this module
export function buildCorpusLinkGraph(
  projectDir: string,
  pluginDir: string,
  principles: Principle[],
): LinkGraphResult {
  /** Normalise a directory for same-root comparison: resolve symlinks + trailing slashes.
   * Fail-open: falls back to raw string on ENOENT or other fs errors. */
  function normDir(d: string): string {
    try {
      return realpathSync(d).replace(/\/+$/, "");
    } catch {
      return d.replace(/\/+$/, "");
    }
  }

  const projectDirNorm = normDir(projectDir);
  const pluginDirNorm = normDir(pluginDir);
  const sameRoot = projectDirNorm === pluginDirNorm;

  const stems = new Set<string>();
  const adrNumbers = new Set<string>();
  const filePaths = new Set<string>();
  const docs: LinkGraphInput[] = [];

  /** Ingest one .md file from a root dir: populate resolution targets + doc list. */
  function ingestFile(absPath: string, root: string): void {
    const repoRel = toRepoRel(absPath, root);
    // Resolution targets (stems / adr numbers / file paths) include EVERY corpus file
    // so a link into docs/explore/ still resolves — but docs/explore/ files are NOT
    // scanned as link SOURCES below (frozen, stale-by-design records; mirrors the
    // docs/explore/ exclusion already applied by stale_refs / cited_paths).
    filePaths.add(repoRel);
    stems.add(fileStem(absPath));
    const adr = adrNumberOf(absPath);
    if (adr) adrNumbers.add(adr);

    if (repoRel.startsWith("docs/explore/")) return;
    const content = readFileSafe(absPath);
    if (content !== null) docs.push({ content, path: repoRel });
  }

  // 1. Project corpus.
  for (const absPath of findFiles(projectDir, (_fp, name) => name.endsWith(".md"))) {
    ingestFile(absPath, projectDir);
  }

  // 2. Plugin corpus — only when not the same root (avoids double-counting the
  //    already-scanned project files when developing Canon itself).
  if (!sameRoot) {
    for (const absPath of findFiles(pluginDir, (_fp, name) => name.endsWith(".md"))) {
      ingestFile(absPath, pluginDir);
    }
  }

  const known: KnownTargets = {
    adrNumbers,
    filePaths,
    principleIds: new Set(principles.map((p) => p.id)),
    stems,
  };

  // Check both roots: a relative md link inside a plugin-shipped file resolves against
  // pluginDir, not projectDir. When sameRoot, both checks hit the same directory.
  const existsOnDisk = (refPath: string): boolean =>
    existsSync(join(projectDir, refPath)) || existsSync(join(pluginDir, refPath));
  return buildLinkGraph(docs, known, existsOnDisk);
}

// ---- Main tool function ----

type CheckContext = {
  agentFiles: FileRecord[];
  claudeMdFiles: FileRecord[];
  dddDocFiles: FileRecord[];
  enabled: Set<CheckName>;
  pluginDir: string;
  principles: Principle[];
  projectDir: string;
};

/** Run all enabled checks and return the assembled input for assembleWikiLintOutput. */
async function runEnabledChecks(
  ctx: CheckContext,
): Promise<Parameters<typeof assembleWikiLintOutput>[0]> {
  const { agentFiles, claudeMdFiles, dddDocFiles, enabled, pluginDir, principles, projectDir } =
    ctx;

  // `gate` runs `fn` only when its check is enabled, else yields []. Collapsing each
  // per-check `enabled.has(...) ? fn() : []` into one call keeps this assembler below
  // the cognitive-complexity ceiling as checks are added.
  const gate = <T>(name: CheckName, fn: () => T): T | [] => (enabled.has(name) ? fn() : []);
  const gateAsync = async <T>(name: CheckName, fn: () => Promise<T>): Promise<T | []> =>
    enabled.has(name) ? fn() : [];

  // The corpus link graph (R2, ADR-0019) backs BOTH link_integrity and
  // orphan_principles. Built once; both roots scanned so plugin principles are
  // not falsely orphaned when projectDir != pluginDir (the normal user-project case).
  const linkGraph =
    enabled.has("link_integrity") || enabled.has("orphan_principles")
      ? buildCorpusLinkGraph(projectDir, pluginDir, principles)
      : null;
  const linkIntegrity = enabled.has("link_integrity") && linkGraph ? linkGraph.findings : [];

  const contradictions = gate("contradictions", () => checkContradictions(claudeMdFiles));
  const orphans = await gateAsync("orphan_principles", () =>
    runOrphanCheck(projectDir, principles, linkGraph?.referencedPrincipleIds ?? new Set<string>()),
  );
  const staleRefs = gate("stale_refs", () =>
    runStaleRefCheck(projectDir, claudeMdFiles, dddDocFiles),
  );
  const missingExamples = gate("missing_examples", () => checkMissingExamples(principles));
  const citedPaths = gate("cited_paths", () => runCitedPathCheck(projectDir, dddDocFiles));
  const validLayers = enabled.has("scope_layers")
    ? Object.keys(await loadLayerMappings(projectDir))
    : [];
  const scopeLayers = gate("scope_layers", () => checkScopeLayers(principles, validLayers));
  const scopeTags = gate("scope_tags", () => checkScopeTags(principles, VALID_COMPUTED_TAGS));
  const indexDrift = await gateAsync("index_drift", () => checkIndexDrift(projectDir));
  const glossaryConsistency = gate("glossary_consistency", () => runGlossaryCheck(projectDir));
  const misroutedPrinciples = gate("misrouted_principles", () =>
    checkMisroutedPrinciples(principles),
  );
  const duplicateTitles = gate("duplicate_titles", () => checkDuplicateTitles(principles));
  const frontmatterSchema = gate("frontmatter_schema", () =>
    runFrontmatterSchemaCheck(projectDir, pluginDir),
  );

  return {
    citedPaths,
    contradictions,
    duplicateTitles,
    filesScanned: claudeMdFiles.length + agentFiles.length + dddDocFiles.length,
    frontmatterSchema,
    glossaryConsistency,
    indexDrift,
    linkIntegrity,
    misroutedPrinciples,
    missingExamples,
    orphans,
    principlesChecked: principles.length,
    scopeLayers,
    scopeTags,
    staleRefs,
  };
}

/**
 * Run wiki lint checks against Canon's own meta-layer artifacts.
 *
 * @param input - Which checks to run (default: all 12 checks except index_drift; pass checks:["index_drift"] to run it)
 * @param projectDir - Project root (for CLAUDE.md scanning, stale ref resolution, drift store)
 * @param pluginDir - Plugin directory (for principles loading, agent definitions)
 */
export async function wikiLint(
  input: WikiLintInput,
  projectDir: string,
  pluginDir: string,
): Promise<WikiLintOutput> {
  // DEFAULT_CHECKS excludes index_drift: that check emits MISSING_MARKERS for any project
  // that lacks the five Canon-managed sentinel-delimited indexes (rules/, principles/, agents/,
  // templates/, references/). Including it by default makes the lint noisy for valid non-Canon /
  // minimal projects. Callers that want it must request it explicitly via checks: ["index_drift"].
  const DEFAULT_CHECKS: CheckName[] = [
    "cited_paths",
    "contradictions",
    "duplicate_titles",
    "frontmatter_schema",
    "glossary_consistency",
    "link_integrity",
    "missing_examples",
    "misrouted_principles",
    "orphan_principles",
    "scope_layers",
    "scope_tags",
    "stale_refs",
  ];
  const enabled = new Set<CheckName>(input.checks ?? DEFAULT_CHECKS);

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

  const assembleInput = await runEnabledChecks({
    agentFiles,
    claudeMdFiles,
    dddDocFiles,
    enabled,
    pluginDir,
    principles,
    projectDir,
  });
  return assembleWikiLintOutput(assembleInput);
}
