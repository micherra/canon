import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gitExecAsync } from "../adapters/git-adapter-async.ts";
import { runShell } from "../adapters/process-adapter.ts";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import { computeUnifiedBlastRadius } from "../graph/kg-blast-radius.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { computeFilePriorities, type FilePriorityScore } from "../graph/priority.ts";
import type { ReviewEntry } from "../schema.ts";
import { buildLayerInferrer, loadLayerMappings } from "../utils/config.ts";
import { sanitizeGitRef } from "../utils/git-ref.ts";

export interface PrReviewDataInput {
  pr_number?: number;
  branch?: string;
  diff_base?: string;
  incremental?: boolean;
}

export interface PrViolation {
  principle_id: string;
  severity: "rule" | "strong-opinion" | "convention";
  message?: string;
}

export interface PrFileInfo {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
  priority_score?: number;
  priority_factors?: FilePriorityScore["factors"];
  bucket: "needs-attention" | "worth-a-look" | "low-risk";
  reason: string;
  violations?: PrViolation[];
}

export interface BlastRadiusEntry {
  file: string;
  affected: Array<{ path: string; depth: number }>;
}

/** Lightweight file entry for clustering — path, status, layer only. */
export interface PrFileSummary {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface PrReviewDataOutput {
  /** Lightweight file list for clustering (path, status, layer only). */
  files: PrFileSummary[];
  /** Files that need full detail — violations, high priority, or needs-attention bucket. */
  impact_files: PrFileInfo[];
  layers: Array<{ name: string; file_count: number }>;
  total_files: number;
  total_violations: number;
  net_new_files: number;
  incremental: boolean;
  last_reviewed_sha?: string;
  diff_command: string;
  graph_data_age_ms?: number;
  error?: string;
  narrative: string;
  blast_radius: BlastRadiusEntry[];
}

// ── Pure classification and narrative functions ──

/**
 * Classify a single file into an attention bucket with a human-readable reason.
 * Pure function — no side effects.
 *
 * Thresholds:
 *   needs-attention: violation_count > 0, OR (in_degree >= 5 AND is_changed)
 *   worth-a-look:    priority_score >= 5 (but not needs-attention)
 *   low-risk:        everything else
 */
export function classifyFile(file: Omit<PrFileInfo, "bucket" | "reason">): {
  bucket: PrFileInfo["bucket"];
  reason: string;
} {
  const factors = file.priority_factors;

  // needs-attention: violations
  if (factors && factors.violation_count > 0) {
    const count = factors.violation_count;
    const word = count === 1 ? "violation" : "violations";
    return {
      bucket: "needs-attention",
      reason: `Has ${count} ${word} that need fixing`,
    };
  }

  // needs-attention: high impact + changed
  if (factors && factors.in_degree >= 5 && factors.is_changed) {
    return {
      bucket: "needs-attention",
      reason: `High impact — ${factors.in_degree} files depend on this and it changed`,
    };
  }

  // worth-a-look: medium priority score
  const score = file.priority_score ?? 0;
  if (score >= 5) {
    const layer = factors?.layer ?? file.layer ?? "this";
    return {
      bucket: "worth-a-look",
      reason: `Medium impact — central to the ${layer} layer`,
    };
  }

  // low-risk: everything else
  return {
    bucket: "low-risk",
    reason: "Low risk — minimal dependencies",
  };
}

/**
 * Generate a 3-4 sentence plain-English narrative summary for the PR.
 * Pure function — no side effects.
 */
export function generateNarrative(
  files: Array<Omit<PrFileInfo, "bucket" | "reason">>,
  layers: Array<{ name: string; file_count: number }>,
): string {
  if (files.length === 0) {
    return "This PR has no changed files.";
  }

  // Determine top layer (most files)
  const topLayer = layers.length > 0 ? layers.reduce((a, b) => (b.file_count > a.file_count ? b : a)).name : "unknown";

  // Sentence 1: top layer + description
  const topLayerCount = layers.find((l) => l.name === topLayer)?.file_count ?? 0;
  const layerDesc = topLayerCount === 1 ? `with ${topLayerCount} file changed` : `with ${topLayerCount} files changed`;
  const sentence1 = `This PR primarily touches the ${topLayer} layer — ${layerDesc}.`;

  // Sentence 2: totals
  const totalFiles = files.length;
  const layerCount = layers.length;
  const layerWord = layerCount === 1 ? "layer" : "layers";
  const sentence2 = `${totalFiles} ${totalFiles === 1 ? "file" : "files"} across ${layerCount} ${layerWord}.`;

  // Find most consequential changed file (highest in_degree)
  let sentence3 = "";
  let maxInDegree = -1;
  let consequentialFile: string | undefined;
  for (const f of files) {
    const deg = f.priority_factors?.in_degree;
    if (deg !== undefined && deg > maxInDegree) {
      maxInDegree = deg;
      consequentialFile = f.path;
    }
  }
  if (consequentialFile !== undefined && maxInDegree > 0) {
    // Use the basename for readability in narrative
    const basename = consequentialFile.split("/").pop() ?? consequentialFile;
    const depWord = maxInDegree === 1 ? "file depends" : "files depend";
    sentence3 = `The most consequential change is ${basename} (${maxInDegree} ${depWord} on it).`;
  }

  // Violation sentence
  let sentence4 = "";
  let totalViolations = 0;
  for (const f of files) {
    totalViolations += f.priority_factors?.violation_count ?? 0;
  }
  if (totalViolations > 0) {
    const vWord = totalViolations === 1 ? "violation" : "violations";
    sentence4 = `There ${totalViolations === 1 ? "is" : "are"} ${totalViolations} principle ${vWord} to address.`;
  }

  return [sentence1, sentence2, sentence3, sentence4].filter(Boolean).join(" ");
}

/**
 * Build a per-file violation map from DriftStore review entries.
 * Pure function — takes reviews, returns a Map. No I/O.
 *
 * Each violation is placed under:
 *   - `violation.file_path` when present
 *   - `review.files[0]` as fallback when `file_path` is absent
 *
 * Violations accumulate across reviews — later reviews do not overwrite earlier ones.
 */
export function buildFileViolationMap(reviews: ReviewEntry[]): Map<string, PrViolation[]> {
  const map = new Map<string, PrViolation[]>();

  for (const review of reviews) {
    for (const v of review.violations) {
      const targetFile = v.file_path ?? review.files[0];
      if (!targetFile) continue;

      const entry = map.get(targetFile);
      const violation: PrViolation = {
        principle_id: v.principle_id,
        severity: v.severity as PrViolation["severity"],
        ...(v.message !== undefined ? { message: v.message } : {}),
      };

      if (entry) {
        entry.push(violation);
      } else {
        map.set(targetFile, [violation]);
      }
    }
  }

  return map;
}

/**
 * Get PR review data — file list grouped by layer with diff command.
 *
 * Runs the git diff command server-side, parses the output, infers layers,
 * and merges priority scores from graph data. The caller (UI) gets everything
 * in one call.
 */
/** Build the diff command based on input mode (PR number, branch, or HEAD). */
function buildDiffCommand(input: PrReviewDataInput): DiffCommand {
  if (input.pr_number !== undefined) {
    if (!Number.isInteger(input.pr_number) || input.pr_number <= 0) {
      throw new Error("pr_number must be a positive integer");
    }
    return { cmd: "gh", args: ["pr", "diff", String(input.pr_number), "--name-only"] };
  }
  if (input.branch) {
    const base = sanitizeGitRef(input.diff_base || "main");
    const branch = sanitizeGitRef(input.branch);
    return { cmd: "git", args: ["diff", `${base}..${branch}`, "--name-status"] };
  }
  const base = sanitizeGitRef(input.diff_base || "main");
  return { cmd: "git", args: ["diff", `${base}..HEAD`, "--name-status"] };
}

/** Load cached graph data and build a priority map. */
async function loadGraphAndPriorities(projectDir: string): Promise<{
  graphDataAgeMs?: number;
  loadedGraph?: {
    nodes: Array<{ id: string; layer: string; violation_count: number; changed: boolean }>;
    edges: Array<{ source: string; target: string }>;
  };
  priorityMap: Map<string, FilePriorityScore>;
}> {
  const priorityMap = new Map<string, FilePriorityScore>();
  let graphDataAgeMs: number | undefined;
  try {
    const graphPath = join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
    const [raw, graphStat] = await Promise.all([readFile(graphPath, "utf-8"), stat(graphPath)]);
    graphDataAgeMs = Date.now() - graphStat.mtimeMs;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      const prioritizedFiles = computeFilePriorities(parsed.nodes, parsed.edges);
      for (const pf of prioritizedFiles) priorityMap.set(pf.path, pf);
      return { graphDataAgeMs, loadedGraph: parsed, priorityMap };
    }
  } catch {
    // No graph data available — graphDataAgeMs may still be set if stat succeeded
  }
  return { graphDataAgeMs, priorityMap };
}

/** Compute blast radius from KG database or fall back to graph edges. */
function computeBlastRadiusForPr(
  files: PrFileInfo[],
  projectDir: string,
  loadedGraph?: { edges: Array<{ source: string; target: string }> },
): BlastRadiusEntry[] {
  const kgDbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (existsSync(kgDbPath)) {
    let db: ReturnType<typeof initDatabase> | undefined;
    try {
      db = initDatabase(kgDbPath);
      return computeBlastRadiusFromKg(files, db);
    } catch {
      if (loadedGraph) return computeBlastRadius(files, loadedGraph.edges);
    } finally {
      db?.close();
    }
  } else if (loadedGraph) {
    return computeBlastRadius(files, loadedGraph.edges);
  }
  return [];
}

export async function getPrReviewData(input: PrReviewDataInput, projectDir: string): Promise<PrReviewDataOutput> {
  const driftStore = new DriftStore(projectDir);
  const isPrNumberMode = input.pr_number !== undefined;

  let diffCmd = buildDiffCommand(input);

  // Check for incremental review
  let lastReviewedSha: string | undefined;
  if (input.incremental && input.pr_number !== undefined) {
    const lastReview = await driftStore.getLastReviewForPr(input.pr_number);
    if (lastReview?.last_reviewed_sha) {
      lastReviewedSha = sanitizeGitRef(lastReview.last_reviewed_sha);
      diffCmd = { cmd: "git", args: ["diff", `${lastReviewedSha}..HEAD`, "--name-status"] };
    }
  }

  const diffCommand = `${diffCmd.cmd} ${diffCmd.args.join(" ")}`;
  const { graphDataAgeMs, loadedGraph, priorityMap } = await loadGraphAndPriorities(projectDir);

  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  let files: PrFileInfo[] = [];
  let execError: string | undefined;
  try {
    const stdout = await runDiffCommand(diffCmd, projectDir);
    files = parseDiffOutput(stdout, isPrNumberMode, inferLayer, priorityMap);
  } catch (err) {
    execError = err instanceof Error ? err.message : String(err);
  }

  // Build layer grouping
  const layerCounts = new Map<string, number>();
  for (const f of files) layerCounts.set(f.layer, (layerCounts.get(f.layer) || 0) + 1);
  const layers = Array.from(layerCounts.entries()).map(([name, file_count]) => ({ name, file_count }));

  // Classify and attach violations
  for (const file of files) {
    const { bucket, reason } = classifyFile(file);
    file.bucket = bucket;
    file.reason = reason;
  }

  try {
    const reviews = await driftStore.getReviews();
    const fileViolationMap = buildFileViolationMap(reviews);
    for (const file of files) file.violations = fileViolationMap.get(file.path) ?? [];
  } catch {
    for (const file of files) file.violations = [];
  }

  const narrative = generateNarrative(files, layers);
  const blastRadius = computeBlastRadiusForPr(files, projectDir, loadedGraph);

  const fileSummaries: PrFileSummary[] = files.map((f) => ({ path: f.path, layer: f.layer, status: f.status }));
  const impactFiles = files.filter(
    (f) => f.bucket === "needs-attention" || (f.priority_score ?? 0) >= 15 || (f.violations && f.violations.length > 0),
  );

  const totalViolations = files.reduce((sum, f) => sum + (f.violations?.length ?? 0), 0);
  const added = files.filter((f) => f.status === "added").length;
  const deleted = files.filter((f) => f.status === "deleted").length;

  return {
    files: fileSummaries,
    impact_files: impactFiles,
    layers,
    total_files: files.length,
    total_violations: totalViolations,
    net_new_files: added - deleted,
    incremental: !!lastReviewedSha,
    last_reviewed_sha: lastReviewedSha,
    diff_command: diffCommand,
    graph_data_age_ms: graphDataAgeMs,
    narrative,
    blast_radius: blastRadius,
    ...(execError ? { error: execError } : {}),
  };
}

/**
 * Compute blast radius for top high-impact changed files using the KG database.
 * Uses `computeUnifiedBlastRadius()` and converts to the `BlastRadiusEntry` format
 * for backward compatibility with the PR output shape.
 * Takes top 2-3 files by in_degree (minimum threshold: 3).
 */
function computeBlastRadiusFromKg(files: PrFileInfo[], db: ReturnType<typeof initDatabase>): BlastRadiusEntry[] {
  const IN_DEGREE_THRESHOLD = 3;
  const MAX_SEEDS = 3;
  const MAX_AFFECTED_PER_SEED = 10;

  const candidates = files
    .filter((f) => f.priority_factors?.is_changed && (f.priority_factors?.in_degree ?? 0) >= IN_DEGREE_THRESHOLD)
    .sort((a, b) => (b.priority_factors?.in_degree ?? 0) - (a.priority_factors?.in_degree ?? 0))
    .slice(0, MAX_SEEDS);

  if (candidates.length === 0) return [];

  return candidates.map((seed) => {
    const report = computeUnifiedBlastRadius(db, seed.path, { maxDepth: 1 });
    const affected = report.affected.slice(0, MAX_AFFECTED_PER_SEED).map((f) => ({ path: f.path, depth: f.depth }));
    return { file: seed.path, affected };
  });
}

/**
 * Compute blast radius for the top high-impact changed files.
 * Uses raw edges (source->target) to find direct importers (depth 1).
 * Takes top 2-3 files by in_degree (minimum threshold: 3).
 * Caps at 10 affected files per seed.
 * @deprecated Prefer computeBlastRadiusFromKg() when KG database is available.
 */
function computeBlastRadius(files: PrFileInfo[], edges: Array<{ source: string; target: string }>): BlastRadiusEntry[] {
  const IN_DEGREE_THRESHOLD = 3;
  const MAX_SEEDS = 3;
  const MAX_AFFECTED_PER_SEED = 10;

  // Find changed files with in_degree >= threshold, sorted descending
  const candidates = files
    .filter((f) => f.priority_factors?.is_changed && (f.priority_factors?.in_degree ?? 0) >= IN_DEGREE_THRESHOLD)
    .sort((a, b) => (b.priority_factors?.in_degree ?? 0) - (a.priority_factors?.in_degree ?? 0))
    .slice(0, MAX_SEEDS);

  if (candidates.length === 0) return [];

  // Build reverse adjacency: target -> set of importers (files that import it)
  const reverseAdj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!reverseAdj.has(edge.target)) {
      reverseAdj.set(edge.target, []);
    }
    reverseAdj.get(edge.target)!.push(edge.source);
  }

  return candidates.map((seed) => {
    const importers = reverseAdj.get(seed.path) ?? [];
    const affected = importers.slice(0, MAX_AFFECTED_PER_SEED).map((path) => ({
      path,
      depth: 1,
    }));
    return { file: seed.path, affected };
  });
}

// ── Git helpers ──

interface DiffCommand {
  cmd: string;
  args: string[];
}

async function runDiffCommand({ cmd, args }: DiffCommand, cwd: string): Promise<string> {
  if (cmd === "git") {
    const result = await gitExecAsync(args, cwd);
    if (!result.ok) {
      throw new Error(result.stderr || `git failed with exit code ${result.exitCode}`);
    }
    return result.stdout;
  }
  // Non-git commands (e.g. gh CLI) — use synchronous shell adapter
  const result = runShell(`${cmd} ${args.join(" ")}`, cwd);
  if (!result.ok) {
    throw new Error(result.stderr || `${cmd} failed with exit code ${result.exitCode}`);
  }
  return result.stdout;
}

// ── Parsing helpers ──

type StatusLetter = "A" | "M" | "D" | "R" | string;

function mapStatus(letter: StatusLetter): PrFileInfo["status"] {
  if (letter.startsWith("R")) return "renamed";
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      return "modified";
  }
}

/**
 * Parse diff command stdout into PrFileInfo[].
 *
 * For `git diff --name-status`: each line is `<STATUS>\t<path>` or for renames
 * `R<score>\t<old-path>\t<new-path>`.
 *
 * For `gh pr diff --name-only`: each line is just `<path>`, status is inferred
 * as "modified".
 */
function parseDiffOutput(
  stdout: string,
  isNameOnly: boolean,
  inferLayer: (path: string) => string,
  priorityMap: Map<string, FilePriorityScore>,
): PrFileInfo[] {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const results: PrFileInfo[] = [];

  for (const line of lines) {
    // Determine path and status from the line format
    let path: string;
    let status: PrFileInfo["status"];

    if (isNameOnly) {
      // gh pr diff --name-only: plain path per line, status inferred as "modified"
      path = line;
      status = "modified";
    } else {
      // git diff --name-status: <STATUS>\t<path> or R<score>\t<old>\t<new>
      const parts = line.split("\t");
      const statusLetter = parts[0];
      status = mapStatus(statusLetter);
      // For renames, use destination path (parts[2]); for others, use parts[1]
      const resolved = status === "renamed" && parts[2] ? parts[2] : parts[1];
      if (!resolved) continue;
      path = resolved;
    }

    const layer = inferLayer(path) || "unknown";
    const priority = priorityMap.get(path);
    // bucket/reason are placeholders — overwritten by classifyFile() in getPrReviewData
    const file: PrFileInfo = { path, layer, status, bucket: "low-risk", reason: "" };
    if (priority) {
      file.priority_score = priority.priority_score;
      file.priority_factors = priority.factors;
    }
    results.push(file);
  }

  return results;
}
