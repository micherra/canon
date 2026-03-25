import { readFile, stat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { PrStore } from "../drift/pr-store.ts";
import { computeFilePriorities, type FilePriorityScore } from "../graph/priority.ts";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { buildLayerInferrer, loadLayerMappings } from "../utils/config.ts";

export interface PrReviewDataInput {
  pr_number?: number;
  branch?: string;
  diff_base?: string;
  incremental?: boolean;
}

export interface PrFileInfo {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
  priority_score?: number;
  priority_factors?: FilePriorityScore["factors"];
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
  const store = new PrStore(projectDir);

  // Determine whether this is a gh pr diff (name-only) or git diff (name-status)
  const isPrNumberMode = input.pr_number !== undefined;

  // Determine diff command — validate all interpolated values to prevent injection
  let diffCommand: string;
  if (isPrNumberMode) {
    if (!Number.isInteger(input.pr_number) || input.pr_number! <= 0) {
      throw new Error("pr_number must be a positive integer");
    }
    diffCommand = `gh pr diff ${input.pr_number} --name-only`;
  } else if (input.branch) {
    const base = sanitizeGitRef(input.diff_base || "main");
    const branch = sanitizeGitRef(input.branch);
    diffCommand = `git diff ${base}..${branch} --name-status`;
  } else {
    const base = sanitizeGitRef(input.diff_base || "main");
    diffCommand = `git diff ${base}..HEAD --name-status`;
  }

  // Check for incremental review
  let lastReviewedSha: string | undefined;
  if (input.incremental && input.pr_number !== undefined) {
    const lastReview = await store.getLastReviewForPr(input.pr_number);
    if (lastReview?.last_reviewed_sha) {
      lastReviewedSha = sanitizeGitRef(lastReview.last_reviewed_sha);
      diffCommand = `git diff ${lastReviewedSha}..HEAD --name-status`;
    }
  }

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
    const stdout = await runDiffCommand(diffCommand, projectDir);
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

  return {
    files,
    layers,
    total_files: files.length,
    incremental: !!lastReviewedSha,
    last_reviewed_sha: lastReviewedSha,
    diff_command: diffCommand,
    prioritized_files: prioritizedFiles,
    graph_data_age_ms: graphDataAgeMs,
    ...(execError ? { error: execError } : {}),
  };
}

// ── Git helpers ──

function runDiffCommand(diffCommand: string, cwd: string): Promise<string> {
  // Parse the command into executable + args. Commands are well-controlled
  // (constructed above), so simple split is safe here.
  const parts = diffCommand.split(" ");
  const cmd = parts[0];
  const args = parts.slice(1);
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
      const file: PrFileInfo = { path, layer, status: "modified" };
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
      const file: PrFileInfo = { path, layer, status };
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
