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
  DecisionSummary,
  PlannerContext,
  ReviewResult,
  ReviewViolation,
  RunSummary,
  RunbookStep,
  StepOutcome,
} from "../history-types.ts";

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
  const decisionSummaries = extractDecisionSummaries(workspacePath);
  const artifactInventory = buildArtifactInventory(workspacePath);

  // Compute timing from step outcomes
  const { startedAt, completedAt, totalDurationMs } = computeTiming(stepOutcomes);

  return {
    version: 1,
    archive_id: archiveId,
    run_metadata: {
      branch: metadata.branch,
      slug,
      flow: metadata.flow,
      tier: metadata.tier,
      task: metadata.task,
      started_at: startedAt,
      completed_at: completedAt,
      archived_at: metadata.archivedAt,
      total_duration_ms: totalDurationMs,
    },
    planner_context: plannerContext,
    step_outcomes: stepOutcomes,
    review_results: reviewResults,
    decision_summaries: decisionSummaries,
    artifact_inventory: artifactInventory,
  };
}

/**
 * Extract planner context from planning-brief.md and runbook.md.
 * Returns null if neither file exists; partial data if only one exists.
 */
export function extractPlannerContext(plansDir: string, slug: string): PlannerContext | null {
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
    outcome,
    effort_estimate: effortEstimate,
    value_estimate: valueEstimate,
    assumptions,
    recommended_approach: recommendedApproach,
    runbook_steps: runbookSteps,
  };
}

/**
 * Extract step outcomes from journal.json.
 * Returns empty array when journal.json is missing or malformed.
 */
export function extractStepOutcomes(workspacePath: string): StepOutcome[] {
  const journalPath = join(workspacePath, "journal.json");
  if (!existsSync(journalPath)) {
    return [];
  }

  try {
    const raw = readFileSync(journalPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isObject(parsed) || !Array.isArray((parsed as Record<string, unknown>)["steps"])) {
      return [];
    }

    const steps = (parsed as Record<string, unknown>)["steps"] as unknown[];
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
export function extractReviewResults(workspacePath: string): ReviewResult[] {
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
 * Extract decision summaries from workspace/decisions/ directory.
 * Parses YAML frontmatter and chosen option/rationale from .md files.
 * Returns empty array when decisions/ is missing.
 */
export function extractDecisionSummaries(workspacePath: string): DecisionSummary[] {
  const decisionsDir = join(workspacePath, "decisions");
  if (!existsSync(decisionsDir)) {
    return [];
  }

  const summaries: DecisionSummary[] = [];
  let entries: string[] = [];

  try {
    entries = readdirSync(decisionsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(decisionsDir, entry);
    try {
      const content = readFileSync(filePath, "utf-8");
      const summary = parseDecisionFile(content);
      if (summary !== null) {
        summaries.push(summary);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return summaries;
}

/**
 * Build artifact inventory — counts files per directory and lists top-level files.
 * Scans the workspace root for directories and files.
 */
export function buildArtifactInventory(workspacePath: string): ArtifactInventory {
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
          directories.push({ name: entry, file_count: fileCount });
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
 * Parse planning-brief.md for structured fields.
 * Extracts outcome, effort_estimate, value_estimate, assumptions, recommended_approach.
 */
function parsePlanningBrief(content: string): {
  outcome: string;
  effortEstimate: string;
  valueEstimate: string;
  assumptions: string[];
  recommendedApproach: string;
} {
  const lines = content.split("\n");
  let outcome = "";
  let effortEstimate = "";
  let valueEstimate = "";
  const assumptions: string[] = [];
  let recommendedApproach = "";

  let inAssumptions = false;
  let inRecommended = false;
  let foundRecommended = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Extract bold markers
    const outcomeMatch = trimmed.match(/^\*\*Outcome\*\*:\s*(.+)$/);
    if (outcomeMatch) {
      outcome = outcomeMatch[1]?.trim() ?? "";
      inAssumptions = false;
      inRecommended = false;
      continue;
    }

    const effortMatch = trimmed.match(/^\*\*Effort estimate\*\*:\s*(.+)$/);
    if (effortMatch) {
      effortEstimate = effortMatch[1]?.trim() ?? "";
      inAssumptions = false;
      inRecommended = false;
      continue;
    }

    const valueMatch = trimmed.match(/^\*\*Value estimate\*\*:\s*(.+)$/);
    if (valueMatch) {
      valueEstimate = valueMatch[1]?.trim() ?? "";
      inAssumptions = false;
      inRecommended = false;
      continue;
    }

    // Section headers
    if (trimmed === "## ASSUMPTIONS") {
      inAssumptions = true;
      inRecommended = false;
      continue;
    }

    if (trimmed.startsWith("## Recommended Approach")) {
      inAssumptions = false;
      inRecommended = true;
      continue;
    }

    // Stop at next section header
    if (trimmed.startsWith("## ") && inAssumptions) {
      inAssumptions = false;
      continue;
    }
    if (trimmed.startsWith("## ") && inRecommended) {
      inRecommended = false;
      continue;
    }

    // Collect assumptions (numbered list items)
    if (inAssumptions && /^\d+\./.test(trimmed)) {
      const text = trimmed.replace(/^\d+\.\s*/, "").trim();
      if (text) assumptions.push(text);
      continue;
    }

    // Collect first non-empty line of recommended approach
    if (inRecommended && !foundRecommended && trimmed.length > 0) {
      recommendedApproach = trimmed;
      foundRecommended = true;
    }
  }

  return { outcome, effortEstimate, valueEstimate, assumptions, recommendedApproach };
}

/**
 * Parse runbook.md for step definitions.
 * Extracts ### Step N: {step_id} sections with agent: and hitl: lines.
 */
function parseRunbookSteps(content: string): RunbookStep[] {
  const steps: RunbookStep[] = [];
  const lines = content.split("\n");

  let currentStep: Partial<RunbookStep> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Match "### Step N: {step_id}"
    const stepMatch = trimmed.match(/^###\s+Step\s+\d+:\s+(.+)$/);
    if (stepMatch) {
      if (currentStep?.step_id) {
        steps.push(finalizeStep(currentStep));
      }
      currentStep = { step_id: stepMatch[1]?.trim() ?? "" };
      continue;
    }

    if (currentStep) {
      // Match "agent: {value}"
      const agentMatch = trimmed.match(/^agent:\s*(.+)$/);
      if (agentMatch) {
        currentStep.agent = agentMatch[1]?.trim() ?? "";
        continue;
      }

      // Match "hitl: {value}"
      const hitlMatch = trimmed.match(/^hitl:\s*(.+)$/);
      if (hitlMatch) {
        currentStep.hitl = hitlMatch[1]?.trim() ?? "";
        continue;
      }
    }
  }

  // Flush last step
  if (currentStep?.step_id) {
    steps.push(finalizeStep(currentStep));
  }

  return steps;
}

function finalizeStep(partial: Partial<RunbookStep>): RunbookStep {
  return {
    step_id: partial.step_id ?? "",
    agent: partial.agent ?? "",
    ...(partial.hitl !== undefined ? { hitl: partial.hitl } : {}),
  };
}

/**
 * Convert a raw journal step object to a StepOutcome.
 * Missing/null fields default to null.
 */
function stepToOutcome(raw: unknown): StepOutcome {
  if (!isObject(raw)) {
    return {
      step_id: "",
      agent_type: "",
      status: "",
      started_at: null,
      completed_at: null,
      duration_ms: null,
      artifacts_expected: [],
    };
  }

  const obj = raw as Record<string, unknown>;
  const startedAt = typeof obj["started_at"] === "string" ? obj["started_at"] : null;
  const completedAt = typeof obj["completed_at"] === "string" ? obj["completed_at"] : null;

  let durationMs: number | null = null;
  if (startedAt !== null && completedAt !== null) {
    try {
      durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    } catch {
      durationMs = null;
    }
  }

  return {
    step_id: typeof obj["step_id"] === "string" ? obj["step_id"] : "",
    agent_type: typeof obj["agent_type"] === "string" ? obj["agent_type"] : "",
    status: typeof obj["status"] === "string" ? obj["status"] : "",
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    artifacts_expected: Array.isArray(obj["artifacts_expected"])
      ? (obj["artifacts_expected"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
  };
}

/**
 * Parse a review .md file for verdict, violations, and honored principles.
 * Returns null if the file has no usable frontmatter.
 */
function parseReviewFile(content: string): ReviewResult | null {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) {
    // No frontmatter — try with empty defaults
    return {
      verdict: "",
      files_reviewed: 0,
      principles_checked: 0,
      violations: [],
      honored: [],
    };
  }

  const verdict = typeof frontmatter["verdict"] === "string" ? frontmatter["verdict"] : "";
  const filesReviewed =
    typeof frontmatter["files-reviewed"] === "number" ? frontmatter["files-reviewed"] : 0;
  const principlesChecked =
    typeof frontmatter["principles-checked"] === "number" ? frontmatter["principles-checked"] : 0;

  const violations = extractViolationsSection(content);
  const honored = extractHonoredSection(content);

  return {
    verdict,
    files_reviewed: filesReviewed,
    principles_checked: principlesChecked,
    violations,
    honored,
  };
}

/**
 * Parse a decision .md file for id, title, chosen option, and rationale snippet.
 * Returns null if the file cannot be parsed.
 */
function parseDecisionFile(content: string): DecisionSummary | null {
  const frontmatter = extractFrontmatter(content);

  const decisionId =
    frontmatter !== null && typeof frontmatter["decision-id"] === "string"
      ? frontmatter["decision-id"]
      : "";
  const title =
    frontmatter !== null && typeof frontmatter["title"] === "string" ? frontmatter["title"] : "";

  const chosenOption = extractChosenOption(content);
  const rationaleSnippet = extractRationaleSnippet(content);

  if (!decisionId && !title) {
    return null;
  }

  return {
    decision_id: decisionId,
    title,
    chosen_option: chosenOption,
    rationale_snippet: rationaleSnippet,
  };
}

/**
 * Extract YAML frontmatter between --- delimiters.
 * Returns a parsed key/value object or null if no frontmatter found.
 */
function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || !match[1]) return null;

  const result: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // Try to parse numbers
    const num = Number(value);
    if (!Number.isNaN(num) && value !== "") {
      result[key] = num;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract violations from a "#### Violations" section in review content.
 * "No violations found." → empty array.
 */
function extractViolationsSection(content: string): ReviewViolation[] {
  const violations: ReviewViolation[] = [];

  // Find "#### Violations" section
  const sectionMatch = content.match(/####\s+Violations\s*\n([\s\S]*?)(?=\n####|\n###|\n##|$)/);
  if (!sectionMatch || !sectionMatch[1]) return violations;

  const sectionContent = sectionMatch[1].trim();
  if (
    sectionContent === "No violations found." ||
    sectionContent === "" ||
    sectionContent === "None."
  ) {
    return violations;
  }

  // Parse violation lines: "- **principle-id**: X — **severity**: Y — **file**: Z — message"
  for (const line of sectionContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    const principleMatch = trimmed.match(/\*\*principle-id\*\*:\s*([^\s—–-][^—–]*?)(?:\s*[—–]|$)/);
    const severityMatch = trimmed.match(/\*\*severity\*\*:\s*([^\s—–-][^—–]*?)(?:\s*[—–]|$)/);
    const fileMatch = trimmed.match(/\*\*file\*\*:\s*([^\s—–-][^—–]*?)(?:\s*[—–]|$)/);

    if (principleMatch) {
      const violation: ReviewViolation = {
        principle_id: principleMatch[1]?.trim() ?? "",
        severity: severityMatch?.[1]?.trim() ?? "unknown",
        file_path: fileMatch?.[1]?.trim() ?? null,
        message: extractViolationMessage(trimmed),
      };
      violations.push(violation);
    }
  }

  return violations;
}

/** Extract the trailing message from a violation line (after last —). */
function extractViolationMessage(line: string): string {
  // Split by em-dash or en-dash, take the last segment
  const parts = line.split(/\s*[—–]\s*/);
  const last = parts[parts.length - 1]?.trim() ?? "";
  // If last part doesn't look like a structured field, it's the message
  if (!last.startsWith("**")) return last;
  return "";
}

/**
 * Extract honored principles from "#### Honored" section.
 * Returns list of principle IDs (items starting with "- ").
 */
function extractHonoredSection(content: string): string[] {
  const honored: string[] = [];

  const sectionMatch = content.match(/####\s+Honored\s*\n([\s\S]*?)(?=\n####|\n###|\n##|$)/);
  if (!sectionMatch || !sectionMatch[1]) return honored;

  for (const line of sectionMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      honored.push(trimmed.slice(2).trim());
    }
  }

  return honored;
}

/**
 * Extract the chosen option from "### Chosen: {option}" line.
 */
function extractChosenOption(content: string): string {
  const match = content.match(/###\s+Chosen:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

/**
 * Extract and truncate rationale snippet from "### Rationale" section.
 * Truncates to ~200 characters.
 */
function extractRationaleSnippet(content: string): string {
  const sectionMatch = content.match(/###\s+Rationale\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  if (!sectionMatch || !sectionMatch[1]) return "";

  const text = sectionMatch[1].trim();
  if (text.length <= 200) return text;

  return text.slice(0, 200) + "...";
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
    return { startedAt: null, completedAt: null, totalDurationMs: null };
  }

  let startedAt: string | null = null;
  let completedAt: string | null = null;

  for (const step of steps) {
    if (step.started_at !== null) {
      if (startedAt === null || step.started_at < startedAt) {
        startedAt = step.started_at;
      }
    }
    if (step.completed_at !== null) {
      if (completedAt === null || step.completed_at > completedAt) {
        completedAt = step.completed_at;
      }
    }
  }

  let totalDurationMs: number | null = null;
  if (startedAt !== null && completedAt !== null) {
    try {
      totalDurationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    } catch {
      totalDurationMs = null;
    }
  }

  return { startedAt, completedAt, totalDurationMs };
}

/** Type guard for plain objects. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
