import { randomBytes } from "crypto";
import { PrStore } from "../drift/pr-store.js";
import type { PrReviewEntry } from "../schema.js";

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

  // Determine diff command
  let diffCommand: string;
  if (input.pr_number) {
    diffCommand = `gh pr diff ${input.pr_number} --name-only`;
  } else if (input.branch) {
    const base = input.diff_base || "main";
    diffCommand = `git diff ${base}..${input.branch} --name-only`;
  } else {
    const base = input.diff_base || "main";
    diffCommand = `git diff ${base}..HEAD --name-only`;
  }

  // Check for incremental review
  let lastReviewedSha: string | undefined;
  if (input.incremental && input.pr_number) {
    const lastReview = await store.getLastReviewForPr(input.pr_number);
    if (lastReview?.last_reviewed_sha) {
      lastReviewedSha = lastReview.last_reviewed_sha;
      // Adjust diff command to only show changes since last review
      diffCommand = `git diff ${lastReviewedSha}..HEAD --name-only`;
    }
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

function generateId(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${prefix}_${y}${m}${d}_${randomBytes(2).toString("hex")}`;
}
