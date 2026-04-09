import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureGitIntelFresh } from "@features/knowledge-graph/git-intel/git-intel-pipeline.ts";
import { computeUnifiedBlastRadius } from "@graph/kg-blast-radius.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { FilePriorityScore } from "@graph/priority.ts";
import { gitExecAsync } from "@platform/adapters/git-adapter-async.ts";
import { runShell } from "@platform/adapters/process-adapter.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { CANON_DIR, CANON_FILES, LAYER_CENTRALITY } from "@shared/constants.ts";
import { buildLayerInferrer, loadLayerMappings } from "@shared/lib/config.ts";
import { sanitizeGitRef } from "@shared/lib/git-ref.ts";
import {
  buildFileViolationMap,
  classifyFile,
  generateNarrative,
  parseDiffOutput,
} from "./pr-review-data-helpers.ts";

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
  /** Files identified as hotspots by git history analysis. Present when git intel data is available. */
  hotspot_files?: string[];
};

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

/** Identify hotspot files in the diff using git-intel data. */
function detectHotspotFiles(
  kgDb: ReturnType<typeof initDatabase> | undefined,
  files: PrFileInfo[],
  projectDir: string,
): string[] | undefined {
  if (!kgDb) return undefined;
  try {
    ensureGitIntelFresh(kgDb, projectDir);
    const hotspots = kgDb
      .prepare("SELECT file_path FROM hotspot_scores WHERE is_hotspot = 1")
      .all() as Array<{ file_path: string }>;
    const hotspotSet = new Set(hotspots.map((h) => h.file_path));
    const changedHotspots = files.filter((f) => hotspotSet.has(f.path)).map((f) => f.path);
    return changedHotspots.length > 0 ? changedHotspots : undefined;
  } catch {
    return undefined;
  }
}

type DiffCommand = {
  cmd: string;
  args: string[];
};

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

async function runDiffCommand({ cmd, args }: DiffCommand, cwd: string): Promise<string> {
  if (cmd === "git") {
    const result = await gitExecAsync(args, cwd);
    if (!result.ok) {
      throw new Error(result.stderr || `git failed with exit code ${result.exitCode}`);
    }
    return result.stdout;
  }
  // Non-git commands (e.g. gh CLI) — use synchronous shell adapter.
  const escapeArg = (a: string): string => `'${a.replace(/'/g, "'\\''")}'`;
  const result = runShell(`${cmd} ${args.map(escapeArg).join(" ")}`, cwd);
  if (!result.ok) {
    throw new Error(result.stderr || `${cmd} failed with exit code ${result.exitCode}`);
  }
  return result.stdout;
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

  const hotspot_files = detectHotspotFiles(kgDb, files, projectDir);

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
    ...(hotspot_files !== undefined ? { hotspot_files } : {}),
  };
}

/**
 * Compute blast radius for top high-impact changed files using the KG database.
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
