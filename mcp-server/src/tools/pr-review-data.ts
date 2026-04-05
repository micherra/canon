import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExecAsync } from "../platform/adapters/git-adapter-async.ts";
import { runShell } from "../platform/adapters/process-adapter.ts";
import { CANON_DIR, CANON_FILES, LAYER_CENTRALITY } from "../shared/constants.ts";
import { DriftStore } from "../drift/store.ts";
import { computeUnifiedBlastRadius } from "../graph/kg-blast-radius.ts";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import type { FilePriorityScore } from "../graph/priority.ts";
import type { ReviewEntry } from "../shared/schema.ts";
import { buildLayerInferrer, loadLayerMappings } from "../utils/config.ts";
import { sanitizeGitRef } from "../shared/lib/git-ref.ts";

export type PrReviewDataInput = {
  pr_number?: number;
  branch?: string;
  diff_base?: string;
  incremental?: boolean;
};

export type PrViolation = {
  principle_id: string;
  severity: "rule" | "strong-opinion" | "convention";
  message?: string;
};

export type PrFileInfo = {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
  priority_score?: number;
  priority_factors?: FilePriorityScore["factors"];
  bucket: "needs-attention" | "worth-a-look" | "low-risk";
  reason: string;
  violations?: PrViolation[];
};

export type BlastRadiusEntry = {
  file: string;
  affected: Array<{ path: string; depth: number }>;
};

/** Lightweight file entry for clustering — path, status, layer only. */
export type PrFileSummary = {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
};

export type PrReviewDataOutput = {
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
};

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
/** Find the file with the highest in_degree among changed files. */
function findMostConsequentialFile(
  files: Array<Omit<PrFileInfo, "bucket" | "reason">>,
): { path: string; in_degree: number } | null {
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
    return { in_degree: maxInDegree, path: consequentialFile };
  }
  return null;
}

/** Count total violations across all files. */
function countTotalViolations(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): number {
  let total = 0;
  for (const f of files) {
    total += f.priority_factors?.violation_count ?? f.violations?.length ?? 0;
  }
  return total;
}

/** Build the layer summary sentence. */
function buildLayerSummary(layers: Array<{ name: string; file_count: number }>): string {
  const topLayer =
    layers.length > 0
      ? layers.reduce((a, b) => (b.file_count > a.file_count ? b : a)).name
      : "unknown";
  const topLayerCount = layers.find((l) => l.name === topLayer)?.file_count ?? 0;
  const layerDesc =
    topLayerCount === 1
      ? `with ${topLayerCount} file changed`
      : `with ${topLayerCount} files changed`;
  return `This PR primarily touches the ${topLayer} layer — ${layerDesc}.`;
}

/** Build the consequential file sentence, or empty string. */
function buildConsequentialSentence(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): string {
  const consequential = findMostConsequentialFile(files);
  if (!consequential) return "";
  const basename = consequential.path.split("/").pop() ?? consequential.path;
  const depWord = consequential.in_degree === 1 ? "file depends" : "files depend";
  return `The most consequential change is ${basename} (${consequential.in_degree} ${depWord} on it).`;
}

/** Build the violation count sentence, or empty string. */
function buildViolationSentence(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): string {
  const totalViolations = countTotalViolations(files);
  if (totalViolations === 0) return "";
  const vWord = totalViolations === 1 ? "violation" : "violations";
  return `There ${totalViolations === 1 ? "is" : "are"} ${totalViolations} principle ${vWord} to address.`;
}

export function generateNarrative(
  files: Array<Omit<PrFileInfo, "bucket" | "reason">>,
  layers: Array<{ name: string; file_count: number }>,
): string {
  if (files.length === 0) return "This PR has no changed files.";

  const sentence1 = buildLayerSummary(layers);
  const layerWord = layers.length === 1 ? "layer" : "layers";
  const sentence2 = `${files.length} ${files.length === 1 ? "file" : "files"} across ${layers.length} ${layerWord}.`;
  const sentence3 = buildConsequentialSentence(files);
  const sentence4 = buildViolationSentence(files);

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
/** Append a violation to the per-file violation map. */
function appendViolation(
  map: Map<string, PrViolation[]>,
  targetFile: string,
  violation: PrViolation,
): void {
  const entry = map.get(targetFile);
  if (entry) {
    entry.push(violation);
  } else {
    map.set(targetFile, [violation]);
  }
}

export function buildFileViolationMap(reviews: ReviewEntry[]): Map<string, PrViolation[]> {
  const map = new Map<string, PrViolation[]>();

  for (const review of reviews) {
    for (const v of review.violations) {
      const targetFile = v.file_path ?? review.files[0];
      if (!targetFile) continue;

      appendViolation(map, targetFile, {
        principle_id: v.principle_id,
        severity: v.severity as PrViolation["severity"],
        ...(v.message !== undefined ? { message: v.message } : {}),
      });
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
/** Build the diff command based on input parameters. */
function buildDiffCommand(input: PrReviewDataInput): DiffCommand {
  if (input.pr_number !== undefined) {
    if (!Number.isInteger(input.pr_number) || input.pr_number! <= 0) {
      throw new Error("pr_number must be a positive integer");
    }
    return { args: ["pr", "diff", String(input.pr_number), "--name-only"], cmd: "gh" };
  }
  if (input.branch) {
    const base = sanitizeGitRef(input.diff_base || "main");
    const branch = sanitizeGitRef(input.branch);
    return { args: ["diff", `${base}..${branch}`, "--name-status"], cmd: "git" };
  }
  const base = sanitizeGitRef(input.diff_base || "main");
  return { args: ["diff", `${base}..HEAD`, "--name-status"], cmd: "git" };
}

/** Open the KG database and retrieve freshness. Returns db handle or undefined. */
function openKgDb(
  projectDir: string,
): { kgDb: ReturnType<typeof initDatabase>; kgFreshnessMs: number | undefined } | undefined {
  const kgDbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(kgDbPath)) return undefined;

  let kgDb: ReturnType<typeof initDatabase> | undefined;
  try {
    kgDb = initDatabase(kgDbPath);
    const query = new KgQuery(kgDb);
    const freshness = query.getKgFreshnessMs();
    return { kgDb, kgFreshnessMs: freshness ?? undefined };
  } catch {
    kgDb?.close();
    return undefined;
  }
}

/** Compute a priority score entry for a single file row. */
function computeFilePriority(
  fileRow: { file_id?: number; path: string; layer?: string },
  degreeMap: Map<number, { in_degree: number; out_degree: number }>,
  insightMaps: ReturnType<typeof computeFileInsightMaps>,
  changedPaths: Set<string>,
): FilePriorityScore | null {
  const fileId = fileRow.file_id;
  if (fileId == null) return null;
  const degrees = degreeMap.get(fileId) ?? { in_degree: 0, out_degree: 0 };
  const layer = fileRow.layer ?? "unknown";
  const isChanged = changedPaths.has(fileRow.path);
  const violationCount = (insightMaps.layerViolationsByPath.get(fileRow.path) ?? []).length;
  const layerCentrality = LAYER_CENTRALITY[layer] ?? 0;
  const score = degrees.in_degree * 3 + violationCount * 2 + (isChanged ? 1 : 0) + layerCentrality;

  return {
    factors: {
      in_degree: degrees.in_degree,
      is_changed: isChanged,
      layer,
      layer_centrality: layerCentrality,
      violation_count: violationCount,
    },
    path: fileRow.path,
    priority_score: Math.round(score * 100) / 100,
  };
}

/** Compute priority scores from KG data and merge into file entries. */
function enrichWithPriorityScores(
  files: PrFileInfo[],
  kgDb: ReturnType<typeof initDatabase>,
): void {
  try {
    const query = new KgQuery(kgDb);
    const changedPaths = new Set(files.map((f) => f.path));
    const allFiles = query.getAllFilesWithStats();
    const degreeMap = query.getAllFileDegrees();
    const insightMaps = computeFileInsightMaps(kgDb);

    const priorityMap = new Map<string, FilePriorityScore>();
    for (const fileRow of allFiles) {
      const entry = computeFilePriority(fileRow, degreeMap, insightMaps, changedPaths);
      if (entry) priorityMap.set(entry.path, entry);
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

/** Attach per-file violations from DriftStore reviews. */
async function attachViolations(files: PrFileInfo[], driftStore: DriftStore): Promise<void> {
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

/** Resolve incremental diff command if applicable. */
async function resolveIncrementalDiff(
  input: PrReviewDataInput,
  driftStore: DriftStore,
  baseDiffCmd: { cmd: string; args: string[] },
): Promise<{ diffCmd: { cmd: string; args: string[] }; lastReviewedSha?: string }> {
  if (!input.incremental || input.pr_number === undefined) return { diffCmd: baseDiffCmd };
  const lastReview = await driftStore.getLastReviewForPr(input.pr_number);
  if (!lastReview?.last_reviewed_sha) return { diffCmd: baseDiffCmd };
  const sha = sanitizeGitRef(lastReview.last_reviewed_sha);
  return {
    diffCmd: { args: ["diff", `${sha}..HEAD`, "--name-status"], cmd: "git" },
    lastReviewedSha: sha,
  };
}

/** Build layer grouping from files. */
function buildLayerGrouping(files: PrFileInfo[]): Array<{ name: string; file_count: number }> {
  const layerCounts = new Map<string, number>();
  for (const f of files) {
    layerCounts.set(f.layer, (layerCounts.get(f.layer) || 0) + 1);
  }
  return Array.from(layerCounts.entries()).map(([name, file_count]) => ({ file_count, name }));
}

/** Compute blast radius from KG, returning empty array on failure. */
function safeComputeBlastRadius(
  files: PrFileInfo[],
  kgDb: ReturnType<typeof initDatabase> | undefined,
): BlastRadiusEntry[] {
  if (!kgDb) return [];
  try {
    return computeBlastRadiusFromKg(files, kgDb);
  } catch {
    return [];
  }
}

export async function getPrReviewData(
  input: PrReviewDataInput,
  projectDir: string,
): Promise<PrReviewDataOutput> {
  const driftStore = new DriftStore(projectDir);
  const isPrNumberMode = input.pr_number !== undefined;

  const baseDiffCmd = buildDiffCommand(input);
  const { diffCmd, lastReviewedSha } = await resolveIncrementalDiff(input, driftStore, baseDiffCmd);
  const diffCommand = `${diffCmd.cmd} ${diffCmd.args.join(" ")}`;

  const kgResult = openKgDb(projectDir);
  const kgDb = kgResult?.kgDb;

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

  if (kgDb) enrichWithPriorityScores(files, kgDb);

  const layers = buildLayerGrouping(files);
  for (const file of files) {
    const { bucket, reason } = classifyFile(file);
    file.bucket = bucket;
    file.reason = reason;
  }
  await attachViolations(files, driftStore);

  const narrative = generateNarrative(files, layers);
  const blastRadius = safeComputeBlastRadius(files, kgDb);
  const totalViolations = files.reduce((sum, f) => sum + (f.violations?.length ?? 0), 0);
  const added = files.filter((f) => f.status === "added").length;
  const deleted = files.filter((f) => f.status === "deleted").length;

  kgDb?.close();

  return {
    blast_radius: blastRadius,
    diff_command: diffCommand,
    files: files.map((f) => ({ layer: f.layer, path: f.path, status: f.status })),
    impact_files: files.filter(
      (f) =>
        f.bucket === "needs-attention" ||
        (f.priority_score ?? 0) >= 15 ||
        (f.violations && f.violations.length > 0),
    ),
    incremental: !!lastReviewedSha,
    kg_freshness_ms: kgResult?.kgFreshnessMs,
    last_reviewed_sha: lastReviewedSha,
    layers,
    narrative,
    net_new_files: added - deleted,
    total_files: files.length,
    total_violations: totalViolations,
    ...(execError ? { error: execError } : {}),
  };
}

/**
 * Compute blast radius for top high-impact changed files using the KG database.
 * Uses `computeUnifiedBlastRadius()` and converts to the `BlastRadiusEntry` format
 * for backward compatibility with the PR output shape.
 * Takes top 2-3 files by in_degree (minimum threshold: 3).
 */
function computeBlastRadiusFromKg(
  files: PrFileInfo[],
  db: ReturnType<typeof initDatabase>,
): BlastRadiusEntry[] {
  const IN_DEGREE_THRESHOLD = 3;
  const MAX_SEEDS = 3;
  const MAX_AFFECTED_PER_SEED = 10;

  const candidates = files
    .filter(
      (f) =>
        f.priority_factors?.is_changed &&
        (f.priority_factors?.in_degree ?? 0) >= IN_DEGREE_THRESHOLD,
    )
    .sort((a, b) => (b.priority_factors?.in_degree ?? 0) - (a.priority_factors?.in_degree ?? 0))
    .slice(0, MAX_SEEDS);

  if (candidates.length === 0) return [];

  return candidates.map((seed) => {
    const report = computeUnifiedBlastRadius(db, seed.path, { maxDepth: 1 });
    const affected = report.affected
      .slice(0, MAX_AFFECTED_PER_SEED)
      .map((f) => ({ depth: f.depth, path: f.path }));
    return { affected, file: seed.path };
  });
}

type DiffCommand = {
  cmd: string;
  args: string[];
};

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
/** Parse a single line from name-status diff output into path and status. */
function parseNameStatusLine(line: string): { path: string; status: PrFileInfo["status"] } | null {
  const parts = line.split("\t");
  const statusLetter = parts[0];
  const status = mapStatus(statusLetter);
  const resolved = status === "renamed" && parts[2] ? parts[2] : parts[1];
  if (!resolved) return null;
  return { path: resolved, status };
}

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
    let path: string;
    let status: PrFileInfo["status"];

    if (isNameOnly) {
      path = line;
      status = "modified";
    } else {
      const parsed = parseNameStatusLine(line);
      if (!parsed) continue;
      ({ path, status } = parsed);
    }

    const layer = inferLayer(path) || "unknown";
    const priority = priorityMap.get(path);
    const file: PrFileInfo = { bucket: "low-risk", layer, path, reason: "", status };
    if (priority) {
      file.priority_score = priority.priority_score;
      file.priority_factors = priority.factors;
    }
    results.push(file);
  }

  return results;
}
