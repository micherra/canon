/**
 * Run Summary Builder — extracts structured data from workspace files for cross-run analysis.
 *
 * Each extraction function is independently wrapped in try/catch.
 * Parse errors return partial/empty data. Missing dirs/files return null/empty.
 * buildRunSummary always returns a valid RunSummary — never throws.
 *
 * Canon principles:
 *   - fail-closed-by-default: extraction errors return partial data, not exceptions
 *   - validate-at-trust-boundaries: file contents are validated before use
 *   - bounded-context-boundaries: only imports from history feature and shared kernel
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactInventory,
  PlannerContext,
  ReviewResult,
  RunbookStep,
  RunSummary,
  StepOutcome,
} from "../history-types.ts";
import {
  parsePlanningBrief,
  parseReviewFile,
  parseRunbookSteps,
} from "./run-summary-extractors.ts";

// ---- Public API ----

/**
 * Build a complete RunSummary from workspace files.
 * Always returns a valid RunSummary — never throws.
 */
export function buildRunSummary(input: {
  workspacePath: string;
  slug: string;
  archiveId: string;
  metadata: {
    branch: string;
    flow: string;
    tier: string;
    task: string;
    archivedAt: string;
  };
}): RunSummary {
  const { workspacePath, slug, archiveId, metadata } = input;

  const plansDir = join(workspacePath, "plans");
  const plannerContext = extractPlannerContext(plansDir, slug);
  const stepOutcomes = extractStepOutcomes(workspacePath);
  const reviewResults = extractReviewResults(workspacePath);
  const artifactInventory = buildArtifactInventory(workspacePath);

  // Compute timing from step outcomes
  const { startedAt, completedAt, totalDurationMs } = computeTiming(stepOutcomes);

  return {
    archive_id: archiveId,
    artifact_inventory: artifactInventory,
    decision_summaries: [],
    planner_context: plannerContext,
    review_results: reviewResults,
    run_metadata: {
      archived_at: metadata.archivedAt,
      branch: metadata.branch,
      completed_at: completedAt,
      flow: metadata.flow,
      slug,
      started_at: startedAt,
      task: metadata.task,
      tier: metadata.tier,
      total_duration_ms: totalDurationMs,
    },
    step_outcomes: stepOutcomes,
    version: 1,
  };
}

/**
 * Extract planner context from planning-brief.md and runbook.md.
 * Returns null if neither file exists; partial data if only one exists.
 */
function extractPlannerContext(plansDir: string, slug: string): PlannerContext | null {
  const briefPath = join(plansDir, slug, "planning-brief.md");
  const runbookPath = join(plansDir, slug, "runbook.md");

  const hasBrief = existsSync(briefPath);
  const hasRunbook = existsSync(runbookPath);

  if (!hasBrief && !hasRunbook) {
    return null;
  }

  let outcome = "";
  let effortEstimate = "";
  let valueEstimate = "";
  let assumptions: string[] = [];
  let recommendedApproach = "";
  let runbookSteps: RunbookStep[] = [];

  if (hasBrief) {
    try {
      const content = readFileSync(briefPath, "utf-8");
      ({ outcome, effortEstimate, valueEstimate, assumptions, recommendedApproach } =
        parsePlanningBrief(content));
    } catch {
      // Silently return defaults — extraction errors don't fail the summary
    }
  }

  if (hasRunbook) {
    try {
      const content = readFileSync(runbookPath, "utf-8");
      runbookSteps = parseRunbookSteps(content);
    } catch {
      // Silently return defaults
    }
  }

  return {
    assumptions,
    effort_estimate: effortEstimate,
    outcome,
    recommended_approach: recommendedApproach,
    runbook_steps: runbookSteps,
    value_estimate: valueEstimate,
  };
}

/**
 * Extract step outcomes from journal.json.
 * Returns empty array when journal.json is missing or malformed.
 */
function extractStepOutcomes(workspacePath: string): StepOutcome[] {
  const journalPath = join(workspacePath, "journal.json");
  if (!existsSync(journalPath)) {
    return [];
  }

  try {
    const raw = readFileSync(journalPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isObject(parsed) || !Array.isArray((parsed as Record<string, unknown>).steps)) {
      return [];
    }

    const steps = (parsed as Record<string, unknown>).steps as unknown[];
    return steps.map(stepToOutcome);
  } catch {
    return [];
  }
}

/**
 * Extract review results from workspace/reviews/ directory.
 * Parses YAML frontmatter and violation/honored sections from .md files.
 * Returns empty array when reviews/ is missing.
 */
function extractReviewResults(workspacePath: string): ReviewResult[] {
  const reviewsDir = join(workspacePath, "reviews");
  if (!existsSync(reviewsDir)) {
    return [];
  }

  const results: ReviewResult[] = [];
  let entries: string[] = [];

  try {
    entries = readdirSync(reviewsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(reviewsDir, entry);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = parseReviewFile(content);
      if (result !== null) {
        results.push(result);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/**
 * Build artifact inventory — counts files per directory and lists top-level files.
 * Scans the workspace root for directories and files.
 */
function buildArtifactInventory(workspacePath: string): ArtifactInventory {
  const directories: { name: string; file_count: number }[] = [];
  const files: string[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(workspacePath);
  } catch {
    return { directories, files, total_files: 0 };
  }

  for (const entry of entries) {
    const entryPath = join(workspacePath, entry);
    try {
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        const fileCount = countFilesInDir(entryPath);
        if (fileCount > 0) {
          directories.push({ file_count: fileCount, name: entry });
        }
      } else if (stat.isFile()) {
        files.push(entry);
      }
    } catch {
      // Skip unreadable entries
    }
  }

  const total_files = directories.reduce((sum, d) => sum + d.file_count, 0) + files.length;
  return { directories, files, total_files };
}

// ---- Private helpers ----

/**
 * Convert a raw journal step object to a StepOutcome.
 * Missing/null fields default to null.
 */
function stepToOutcome(raw: unknown): StepOutcome {
  if (!isObject(raw)) {
    return {
      agent_type: "",
      artifacts_expected: [],
      completed_at: null,
      duration_ms: null,
      started_at: null,
      status: "",
      step_id: "",
    };
  }

  const obj = raw as Record<string, unknown>;
  const startedAt = typeof obj.started_at === "string" ? obj.started_at : null;
  const completedAt = typeof obj.completed_at === "string" ? obj.completed_at : null;

  let durationMs: number | null = null;
  if (startedAt !== null && completedAt !== null) {
    try {
      durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    } catch {
      durationMs = null;
    }
  }

  return {
    agent_type: typeof obj.agent_type === "string" ? obj.agent_type : "",
    artifacts_expected: Array.isArray(obj.artifacts_expected)
      ? (obj.artifacts_expected as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    completed_at: completedAt,
    duration_ms: durationMs,
    started_at: startedAt,
    status: typeof obj.status === "string" ? obj.status : "",
    step_id: typeof obj.step_id === "string" ? obj.step_id : "",
  };
}

/**
 * Count all files in a directory (non-recursive, top-level only).
 */
function countFilesInDir(dirPath: string): number {
  try {
    const entries = readdirSync(dirPath);
    let count = 0;
    for (const entry of entries) {
      try {
        const stat = statSync(join(dirPath, entry));
        if (stat.isFile()) count++;
      } catch {
        // Skip unreadable entries
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Compute timing from step outcomes.
 * Returns the earliest started_at and latest completed_at across all steps.
 */
function computeTiming(steps: StepOutcome[]): {
  startedAt: string | null;
  completedAt: string | null;
  totalDurationMs: number | null;
} {
  if (steps.length === 0) {
    return { completedAt: null, startedAt: null, totalDurationMs: null };
  }

  const { startedAt, completedAt } = computeTimeBounds(steps);
  const totalDurationMs = calcDurationMs(startedAt, completedAt);
  return { completedAt, startedAt, totalDurationMs };
}

/** Scan step outcomes for the earliest started_at and latest completed_at. */
function computeTimeBounds(steps: StepOutcome[]): {
  startedAt: string | null;
  completedAt: string | null;
} {
  let startedAt: string | null = null;
  let completedAt: string | null = null;

  for (const step of steps) {
    if (step.started_at !== null && (startedAt === null || step.started_at < startedAt)) {
      startedAt = step.started_at;
    }
    if (step.completed_at !== null && (completedAt === null || step.completed_at > completedAt)) {
      completedAt = step.completed_at;
    }
  }

  return { completedAt, startedAt };
}

/** Compute duration in milliseconds between two ISO timestamps. Returns null on error. */
function calcDurationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  try {
    return new Date(completedAt).getTime() - new Date(startedAt).getTime();
  } catch {
    return null;
  }
}

/** Type guard for plain objects. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
