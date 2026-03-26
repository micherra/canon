import { readFile, stat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { DriftStore } from "../drift/store.ts";
import { computeFilePriorities, type FilePriorityScore } from "../graph/priority.ts";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { buildLayerInferrer, loadLayerMappings } from "../utils/config.ts";
import type { ReviewEntry } from "../schema.ts";

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

export interface PrReviewDataOutput {
  files: PrFileInfo[];
  layers: Array<{ name: string; file_count: number }>;
  total_files: number;
  incremental: boolean;
  last_reviewed_sha?: string;
  diff_command: string;
  prioritized_files?: FilePriorityScore[];
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
export function classifyFile(
  file: Omit<PrFileInfo, "bucket" | "reason">,
): { bucket: PrFileInfo["bucket"]; reason: string } {
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
  const topLayer = layers.length > 0
    ? layers.reduce((a, b) => (b.file_count > a.file_count ? b : a)).name
    : "unknown";

  // Sentence 1: top layer + description
  const topLayerCount = layers.find((l) => l.name === topLayer)?.file_count ?? 0;
  const layerDesc =
    topLayerCount === 1
      ? `with ${topLayerCount} file changed`
      : `with ${topLayerCount} files changed`;
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

  return [sentence1, sentence2, sentence3, sentence4]
    .filter(Boolean)
    .join(" ");
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
export function buildFileViolationMap(
  reviews: ReviewEntry[],
): Map<string, PrViolation[]> {
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
export async function getPrReviewData(
  input: PrReviewDataInput,
  projectDir: string
): Promise<PrReviewDataOutput> {
  const driftStore = new DriftStore(projectDir);

  // Determine whether this is a gh pr diff (name-only) or git diff (name-status)
  const isPrNumberMode = input.pr_number !== undefined;

  // Build structured command — never string-split later
  let diffCmd: DiffCommand;
  if (isPrNumberMode) {
    if (!Number.isInteger(input.pr_number) || input.pr_number! <= 0) {
      throw new Error("pr_number must be a positive integer");
    }
    diffCmd = { cmd: "gh", args: ["pr", "diff", String(input.pr_number), "--name-only"] };
  } else if (input.branch) {
    const base = sanitizeGitRef(input.diff_base || "main");
    const branch = sanitizeGitRef(input.branch);
    diffCmd = { cmd: "git", args: ["diff", `${base}..${branch}`, "--name-status"] };
  } else {
    const base = sanitizeGitRef(input.diff_base || "main");
    diffCmd = { cmd: "git", args: ["diff", `${base}..HEAD`, "--name-status"] };
  }

  // Check for incremental review
  let lastReviewedSha: string | undefined;
  if (input.incremental && input.pr_number !== undefined) {
    const lastReview = await driftStore.getLastReviewForPr(input.pr_number);
    if (lastReview?.last_reviewed_sha) {
      lastReviewedSha = sanitizeGitRef(lastReview.last_reviewed_sha);
      diffCmd = { cmd: "git", args: ["diff", `${lastReviewedSha}..HEAD`, "--name-status"] };
    }
  }

  // Human-readable command string for display
  const diffCommand = `${diffCmd.cmd} ${diffCmd.args.join(" ")}`;

  // Enrich with graph-aware priority scores if graph data exists
  let prioritizedFiles: FilePriorityScore[] | undefined;
  let graphDataAgeMs: number | undefined;
  try {
    const graphPath = join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
    const [raw, graphStat] = await Promise.all([
      readFile(graphPath, "utf-8"),
      stat(graphPath),
    ]);
    graphDataAgeMs = Date.now() - graphStat.mtimeMs;
    const graph = JSON.parse(raw);
    if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
      prioritizedFiles = computeFilePriorities(graph.nodes, graph.edges);
    }
  } catch {
    // No graph data available — priority enrichment skipped
  }

  // Build a map from path -> priority score for fast merge
  const priorityMap = new Map<string, FilePriorityScore>();
  if (prioritizedFiles) {
    for (const pf of prioritizedFiles) {
      priorityMap.set(pf.path, pf);
    }
  }

  // Load layer inferrer
  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  // Run the diff command and parse the output
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
  for (const f of files) {
    layerCounts.set(f.layer, (layerCounts.get(f.layer) || 0) + 1);
  }
  const layers = Array.from(layerCounts.entries()).map(([name, file_count]) => ({
    name,
    file_count,
  }));

  // Classify each file into a bucket with a human-readable reason
  for (const file of files) {
    const { bucket, reason } = classifyFile(file);
    file.bucket = bucket;
    file.reason = reason;
  }

  // Attach per-file violations from DriftStore general reviews
  try {
    const reviews = await driftStore.getReviews();
    const fileViolationMap = buildFileViolationMap(reviews);
    for (const file of files) {
      file.violations = fileViolationMap.get(file.path) ?? [];
    }
  } catch {
    // DriftStore unavailable — violations skipped, each file gets empty array
    for (const file of files) {
      file.violations = [];
    }
  }

  // Generate plain-English narrative
  const narrative = generateNarrative(files, layers);

  // Compute blast radius for top high-impact files using raw graph edges
  let blastRadius: BlastRadiusEntry[] = [];
  try {
    const graphPath = join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
    const raw = await readFile(graphPath, "utf-8");
    const graph = JSON.parse(raw) as { nodes: unknown[]; edges: Array<{ source: string; target: string }> };
    if (Array.isArray(graph.edges)) {
      blastRadius = computeBlastRadius(files, graph.edges);
    }
  } catch {
    // No graph data available — blast radius skipped
  }

  return {
    files,
    layers,
    total_files: files.length,
    incremental: !!lastReviewedSha,
    last_reviewed_sha: lastReviewedSha,
    diff_command: diffCommand,
    prioritized_files: prioritizedFiles,
    graph_data_age_ms: graphDataAgeMs,
    narrative,
    blast_radius: blastRadius,
    ...(execError ? { error: execError } : {}),
  };
}

/**
 * Compute blast radius for the top high-impact changed files.
 * Uses raw edges (source->target) to find direct importers (depth 1).
 * Takes top 2-3 files by in_degree (minimum threshold: 3).
 * Caps at 10 affected files per seed.
 */
function computeBlastRadius(
  files: PrFileInfo[],
  edges: Array<{ source: string; target: string }>,
): BlastRadiusEntry[] {
  const IN_DEGREE_THRESHOLD = 3;
  const MAX_SEEDS = 3;
  const MAX_AFFECTED_PER_SEED = 10;

  // Find changed files with in_degree >= threshold, sorted descending
  const candidates = files
    .filter(
      (f) =>
        f.priority_factors?.is_changed &&
        (f.priority_factors?.in_degree ?? 0) >= IN_DEGREE_THRESHOLD,
    )
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

function runDiffCommand({ cmd, args }: DiffCommand, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout);
    });
  });
}

// ── Parsing helpers ──

type StatusLetter = "A" | "M" | "D" | "R" | string;

function mapStatus(letter: StatusLetter): PrFileInfo["status"] {
  if (letter.startsWith("R")) return "renamed";
  switch (letter) {
    case "A": return "added";
    case "D": return "deleted";
    default: return "modified";
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
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const results: PrFileInfo[] = [];

  for (const line of lines) {
    if (isNameOnly) {
      // gh pr diff --name-only: plain path per line
      const path = line;
      const layer = inferLayer(path) || "unknown";
      const priority = priorityMap.get(path);
      // bucket/reason are placeholders — overwritten by classifyFile() in getPrReviewData
      const file: PrFileInfo = { path, layer, status: "modified", bucket: "low-risk", reason: "" };
      if (priority) {
        file.priority_score = priority.priority_score;
        file.priority_factors = priority.factors;
      }
      results.push(file);
    } else {
      // git diff --name-status: <STATUS>\t<path> or R<score>\t<old>\t<new>
      const parts = line.split("\t");
      const statusLetter = parts[0];
      const status = mapStatus(statusLetter);
      // For renames, use destination path (parts[2]); for others, use parts[1]
      const path = status === "renamed" && parts[2] ? parts[2] : parts[1];
      if (!path) continue;

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
  }

  return results;
}

const GIT_REF_PATTERN = /^[a-zA-Z0-9_.\/\-]+$/;

function sanitizeGitRef(ref: string): string {
  if (!ref || !GIT_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}". Only alphanumeric, '.', '/', '_', '-' allowed.`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`Invalid git ref: "${ref}". Refs must not start with '-'.`);
  }
  if (ref.includes("..")) {
    throw new Error(`Invalid git ref: "${ref}". Refs must not contain '..'.`);
  }
  return ref;
}
