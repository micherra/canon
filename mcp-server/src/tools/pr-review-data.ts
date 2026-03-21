import { readFile, stat } from "fs/promises";
import { join } from "path";
import { PrStore } from "../drift/pr-store.js";
import { generateId } from "../utils/id.js";
import type { PrReviewEntry } from "../schema.js";
import { computeFilePriorities, type FilePriorityScore } from "../graph/priority.js";

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
}

/**
 * Get PR review data — file list grouped by layer with diff command.
 *
 * This tool prepares the data needed for a PR review. The actual review
 * is done by spawning canon-reviewer agents in the command layer.
 */
export async function getPrReviewData(
  input: PrReviewDataInput,
  projectDir: string,
  _pluginDir: string
): Promise<PrReviewDataOutput> {
  const store = new PrStore(projectDir);

  // Determine diff command — validate all interpolated values to prevent injection
  let diffCommand: string;
  if (input.pr_number) {
    if (!Number.isInteger(input.pr_number) || input.pr_number <= 0) {
      throw new Error("pr_number must be a positive integer");
    }
    diffCommand = `gh pr diff ${input.pr_number} --name-only`;
  } else if (input.branch) {
    const base = sanitizeGitRef(input.diff_base || "main");
    const branch = sanitizeGitRef(input.branch);
    diffCommand = `git diff ${base}..${branch} --name-only`;
  } else {
    const base = sanitizeGitRef(input.diff_base || "main");
    diffCommand = `git diff ${base}..HEAD --name-only`;
  }

  // Check for incremental review
  let lastReviewedSha: string | undefined;
  if (input.incremental && input.pr_number) {
    const lastReview = await store.getLastReviewForPr(input.pr_number);
    if (lastReview?.last_reviewed_sha) {
      lastReviewedSha = sanitizeGitRef(lastReview.last_reviewed_sha);
      diffCommand = `git diff ${lastReviewedSha}..HEAD --name-only`;
    }
  }

  // Enrich with graph-aware priority scores if graph data exists
  let prioritizedFiles: FilePriorityScore[] | undefined;
  let graphDataAgeMs: number | undefined;
  try {
    const graphPath = join(projectDir, ".canon", "graph-data.json");
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

  // Note: actual file list is populated by the command layer which runs
  // the diff command. This tool returns the command and metadata.
  return {
    files: [],
    layers: [],
    total_files: 0,
    incremental: !!lastReviewedSha,
    last_reviewed_sha: lastReviewedSha,
    diff_command: diffCommand,
    prioritized_files: prioritizedFiles,
    graph_data_age_ms: graphDataAgeMs,
  };
}

/**
 * Record a PR review result.
 */
export async function recordPrReview(
  input: {
    pr_number?: number;
    branch?: string;
    last_reviewed_sha?: string;
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    files: string[];
    violations: Array<{ principle_id: string; severity: string }>;
    honored: string[];
    score: {
      rules: { passed: number; total: number };
      opinions: { passed: number; total: number };
      conventions: { passed: number; total: number };
    };
  },
  projectDir: string
): Promise<{ recorded: boolean; id: string }> {
  const store = new PrStore(projectDir);
  const id = generateId("prrev");

  const entry: PrReviewEntry = {
    pr_review_id: id,
    timestamp: new Date().toISOString(),
    pr_number: input.pr_number,
    branch: input.branch,
    last_reviewed_sha: input.last_reviewed_sha,
    verdict: input.verdict,
    files: input.files,
    violations: input.violations,
    honored: input.honored,
    score: input.score,
  };

  await store.appendReview(entry);
  return { recorded: true, id };
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

