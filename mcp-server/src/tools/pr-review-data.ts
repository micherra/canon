import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExecAsync } from "../adapters/git-adapter-async.ts";
import { runShell } from "../adapters/process-adapter.ts";
import { CANON_DIR, CANON_FILES, LAYER_CENTRALITY } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import { computeUnifiedBlastRadius } from "../graph/kg-blast-radius.ts";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import type { FilePriorityScore } from "../graph/priority.ts";
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
  kg_freshness_ms?: number;
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

/** Build the "top layer" sentence for the narrative. */
function buildTopLayerSentence(layers: Array<{ name: string; file_count: number }>): string {
  const topLayer = layers.length > 0 ? layers.reduce((a, b) => (b.file_count > a.file_count ? b : a)).name : "unknown";
  const topLayerCount = layers.find((l) => l.name === topLayer)?.file_count ?? 0;
  const layerDesc = topLayerCount === 1 ? `with ${topLayerCount} file changed` : `with ${topLayerCount} files changed`;
  return `This PR primarily touches the ${topLayer} layer — ${layerDesc}.`;
}

/** Build the "totals" sentence for the narrative. */
function buildTotalsSentence(fileCount: number, layerCount: number): string {
  const layerWord = layerCount === 1 ? "layer" : "layers";
  return `${fileCount} ${fileCount === 1 ? "file" : "files"} across ${layerCount} ${layerWord}.`;
}

/** Build the "most consequential file" sentence for the narrative. */
function buildConsequentialSentence(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): string {
  let maxInDegree = -1;
  let consequentialFile: string | undefined;
  for (const f of files) {
    const deg = f.priority_factors?.in_degree;
    if (deg !== undefined && deg > maxInDegree) {
      maxInDegree = deg;
      consequentialFile = f.path;
    }
  }
  if (consequentialFile === undefined || maxInDegree <= 0) return "";
  const basename = consequentialFile.split("/").pop() ?? consequentialFile;
  const depWord = maxInDegree === 1 ? "file depends" : "files depend";
  return `The most consequential change is ${basename} (${maxInDegree} ${depWord} on it).`;
}

/** Build the "violations" sentence for the narrative. */
function buildViolationSentence(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): string {
  let totalViolations = 0;
  for (const f of files) {
    totalViolations += f.priority_factors?.violation_count ?? f.violations?.length ?? 0;
  }
  if (totalViolations <= 0) return "";
  const vWord = totalViolations === 1 ? "violation" : "violations";
  return `There ${totalViolations === 1 ? "is" : "are"} ${totalViolations} principle ${vWord} to address.`;
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

  return [
    buildTopLayerSentence(layers),
    buildTotalsSentence(files.length, layers.length),
    buildConsequentialSentence(files),
    buildViolationSentence(files),
  ]
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

/** Build the diff command from input parameters. */
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

/** Check for incremental review and override the diff command if applicable. */
async function resolveIncrementalDiff(
  input: PrReviewDataInput,
  driftStore: DriftStore,
  diffCmd: DiffCommand,
): Promise<{ diffCmd: DiffCommand; lastReviewedSha: string | undefined }> {
  if (!input.incremental || input.pr_number === undefined) {
    return { diffCmd, lastReviewedSha: undefined };
  }
  const lastReview = await driftStore.getLastReviewForPr(input.pr_number);
  if (!lastReview?.last_reviewed_sha) {
    return { diffCmd, lastReviewedSha: undefined };
  }
  const sha = sanitizeGitRef(lastReview.last_reviewed_sha);
  return {
    diffCmd: { cmd: "git", args: ["diff", `${sha}..HEAD`, "--name-status"] },
    lastReviewedSha: sha,
  };
}

/** Open the KG database and read freshness. Returns db handle or undefined. */
function openKgDatabase(projectDir: string): {
  kgDb: ReturnType<typeof initDatabase> | undefined;
  kgFreshnessMs: number | undefined;
} {
  const kgDbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(kgDbPath)) {
    return { kgDb: undefined, kgFreshnessMs: undefined };
  }
  try {
    const kgDb = initDatabase(kgDbPath);
    const query = new KgQuery(kgDb);
    const freshness = query.getKgFreshnessMs();
    return { kgDb, kgFreshnessMs: freshness ?? undefined };
  } catch {
    return { kgDb: undefined, kgFreshnessMs: undefined };
  }
}

/** Compute a single priority entry from a KG file row. */
function computeFilePriority(
  path: string,
  layer: string,
  degrees: { in_degree: number; out_degree: number },
  violationCount: number,
  isChanged: boolean,
): FilePriorityScore {
  const layerCentrality = LAYER_CENTRALITY[layer] ?? 0;
  const score = degrees.in_degree * 3 + violationCount * 2 + (isChanged ? 1 : 0) + layerCentrality;
  return {
    path,
    priority_score: Math.round(score * 100) / 100,
    factors: {
      in_degree: degrees.in_degree,
      violation_count: violationCount,
      is_changed: isChanged,
      layer,
      layer_centrality: layerCentrality,
    },
  };
}

/** Enrich files with KG priority data. Mutates the files array. */
function enrichWithKgPriorities(files: PrFileInfo[], kgDb: ReturnType<typeof initDatabase>): void {
  try {
    const query = new KgQuery(kgDb);
    const changedPaths = new Set(files.map((f) => f.path));
    const allFiles = query.getAllFilesWithStats();
    const degreeMap = query.getAllFileDegrees();
    const insightMaps = computeFileInsightMaps(kgDb);

    const priorityMap = new Map<string, FilePriorityScore>();
    for (const fileRow of allFiles) {
      const fileId = fileRow.file_id;
      if (fileId == null) continue;
      const degrees = degreeMap.get(fileId) ?? { in_degree: 0, out_degree: 0 };
      const path = fileRow.path;
      const layer = fileRow.layer ?? "unknown";
      const isChanged = changedPaths.has(path);
      const layerViolations = insightMaps.layerViolationsByPath.get(path) ?? [];
      priorityMap.set(path, computeFilePriority(path, layer, degrees, layerViolations.length, isChanged));
    }

    for (const file of files) {
      const priority = priorityMap.get(file.path);
      if (priority) {
        file.priority_score = priority.priority_score;
        file.priority_factors = priority.factors;
      }
    }
  } catch {
    // Priority computation failed — continue without priority data
  }
}

/** Build layer grouping from file list. */
function buildLayerGroups(files: PrFileInfo[]): Array<{ name: string; file_count: number }> {
  const layerCounts = new Map<string, number>();
  for (const f of files) {
    layerCounts.set(f.layer, (layerCounts.get(f.layer) || 0) + 1);
  }
  return Array.from(layerCounts.entries()).map(([name, file_count]) => ({ name, file_count }));
}

/** Classify files into buckets and attach violations. Mutates the files array. */
function classifyAndAttachBuckets(files: PrFileInfo[]): void {
  for (const file of files) {
    const { bucket, reason } = classifyFile(file);
    file.bucket = bucket;
    file.reason = reason;
  }
}

/** Attach per-file violations from DriftStore. Mutates the files array. */
async function attachDriftViolations(files: PrFileInfo[], driftStore: DriftStore): Promise<void> {
  try {
    const reviews = await driftStore.getReviews();
    const fileViolationMap = buildFileViolationMap(reviews);
    for (const file of files) {
      file.violations = fileViolationMap.get(file.path) ?? [];
    }
  } catch {
    for (const file of files) {
      file.violations = [];
    }
  }
}

/** Build the final output object from processed files. */
function buildOutput(
  files: PrFileInfo[],
  layers: Array<{ name: string; file_count: number }>,
  narrative: string,
  blastRadius: BlastRadiusEntry[],
  lastReviewedSha: string | undefined,
  diffCommand: string,
  kgFreshnessMs: number | undefined,
  execError: string | undefined,
): PrReviewDataOutput {
  const fileSummaries: PrFileSummary[] = files.map((f) => ({
    path: f.path,
    layer: f.layer,
    status: f.status,
  }));

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
    kg_freshness_ms: kgFreshnessMs,
    narrative,
    blast_radius: blastRadius,
    ...(execError ? { error: execError } : {}),
  };
}

/**
 * Get PR review data — file list grouped by layer with diff command.
 *
 * Runs the git diff command server-side, parses the output, infers layers,
 * and merges priority scores from graph data. The caller (UI) gets everything
 * in one call.
 */
export async function getPrReviewData(input: PrReviewDataInput, projectDir: string): Promise<PrReviewDataOutput> {
  const driftStore = new DriftStore(projectDir);
  const isPrNumberMode = input.pr_number !== undefined;

  let diffCmd = buildDiffCommand(input);
  const incremental = await resolveIncrementalDiff(input, driftStore, diffCmd);
  diffCmd = incremental.diffCmd;
  const lastReviewedSha = incremental.lastReviewedSha;

  const diffCommand = `${diffCmd.cmd} ${diffCmd.args.join(" ")}`;
  const { kgDb, kgFreshnessMs } = openKgDatabase(projectDir);

  const layerMappings = await loadLayerMappings(projectDir);
  const inferLayer = buildLayerInferrer(layerMappings);

  let files: PrFileInfo[] = [];
  let execError: string | undefined;
  try {
    const stdout = await runDiffCommand(diffCmd, projectDir);
    files = parseDiffOutput(stdout, isPrNumberMode, inferLayer, new Map());
  } catch (err) {
    execError = err instanceof Error ? err.message : String(err);
  }

  if (kgDb) {
    enrichWithKgPriorities(files, kgDb);
  }

  const layers = buildLayerGroups(files);
  classifyAndAttachBuckets(files);
  await attachDriftViolations(files, driftStore);

  const narrative = generateNarrative(files, layers);

  let blastRadius: BlastRadiusEntry[] = [];
  if (kgDb) {
    try {
      blastRadius = computeBlastRadiusFromKg(files, kgDb);
    } catch {
      // KG blast radius failed — return empty
    }
  }

  kgDb?.close();

  return buildOutput(files, layers, narrative, blastRadius, lastReviewedSha, diffCommand, kgFreshnessMs, execError);
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
  // Non-git commands (e.g. gh CLI) — use synchronous shell adapter.
  // Shell-escape each arg by wrapping in single quotes and escaping internal
  // single quotes (replace ' with '\'' ), to handle args with spaces/shell chars.
  const escapeArg = (a: string): string => `'${a.replace(/'/g, "'\\''")}'`;
  const result = runShell(`${cmd} ${args.map(escapeArg).join(" ")}`, cwd);
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
