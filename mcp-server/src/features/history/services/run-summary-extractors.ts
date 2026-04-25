/**
 * Run Summary Extractors — pure text-parsing helpers for run-summary-builder.
 *
 * These functions parse planning-brief.md, runbook.md, review .md files,
 * and decision .md files into structured types for RunSummary construction.
 *
 * All functions are pure (no I/O) and never throw — parse errors return partial/empty data.
 */

import type {
  DecisionSummary,
  ReviewResult,
  ReviewViolation,
  RunbookStep,
} from "../history-types.ts";

// ---- Planning brief ----

/**
 * Parse planning-brief.md for structured fields.
 * Extracts outcome, effort_estimate, value_estimate, assumptions, recommended_approach.
 */
export function parsePlanningBrief(content: string): {
  outcome: string;
  effortEstimate: string;
  valueEstimate: string;
  assumptions: string[];
  recommendedApproach: string;
} {
  const lines = content.split("\n");
  const state = {
    assumptions: [] as string[],
    effortEstimate: "",
    foundRecommended: false,
    inAssumptions: false,
    inRecommended: false,
    outcome: "",
    recommendedApproach: "",
    valueEstimate: "",
  };

  for (const line of lines) {
    processPlanningBriefLine(line.trim(), state);
  }

  return {
    assumptions: state.assumptions,
    effortEstimate: state.effortEstimate,
    outcome: state.outcome,
    recommendedApproach: state.recommendedApproach,
    valueEstimate: state.valueEstimate,
  };
}

type PlanningBriefState = {
  outcome: string;
  effortEstimate: string;
  valueEstimate: string;
  assumptions: string[];
  recommendedApproach: string;
  inAssumptions: boolean;
  inRecommended: boolean;
  foundRecommended: boolean;
};

/** Process a single trimmed line against the planning brief parser state. */
function processPlanningBriefLine(trimmed: string, state: PlanningBriefState): void {
  if (extractBoldField(trimmed, "Outcome", state)) return;
  if (extractBoldField(trimmed, "Effort estimate", state)) return;
  if (extractBoldField(trimmed, "Value estimate", state)) return;
  if (processSectionHeader(trimmed, state)) return;
  if (state.inAssumptions && processAssumptionLine(trimmed, state)) return;
  if (state.inRecommended && !state.foundRecommended && trimmed.length > 0) {
    state.recommendedApproach = trimmed;
    state.foundRecommended = true;
  }
}

/** Extract a **Field**: value bold marker. Resets section state on match. Returns true if matched. */
function extractBoldField(trimmed: string, fieldName: string, state: PlanningBriefState): boolean {
  const match = trimmed.match(new RegExp(`^\\*\\*${fieldName}\\*\\*:\\s*(.+)$`));
  if (!match) return false;
  const value = match[1]?.trim() ?? "";
  if (fieldName === "Outcome") state.outcome = value;
  else if (fieldName === "Effort estimate") state.effortEstimate = value;
  else if (fieldName === "Value estimate") state.valueEstimate = value;
  state.inAssumptions = false;
  state.inRecommended = false;
  return true;
}

/** Handle ## section headers. Returns true if matched. */
function processSectionHeader(trimmed: string, state: PlanningBriefState): boolean {
  if (trimmed === "## ASSUMPTIONS") {
    state.inAssumptions = true;
    state.inRecommended = false;
    return true;
  }
  if (trimmed.startsWith("## Recommended Approach")) {
    state.inAssumptions = false;
    state.inRecommended = true;
    return true;
  }
  if (trimmed.startsWith("## ") && (state.inAssumptions || state.inRecommended)) {
    state.inAssumptions = false;
    state.inRecommended = false;
    return true;
  }
  return false;
}

/** Process an assumption list item line. Returns true if it was a numbered item. */
function processAssumptionLine(trimmed: string, state: PlanningBriefState): boolean {
  if (!/^\d+\./.test(trimmed)) return false;
  const text = trimmed.replace(/^\d+\.\s*/, "").trim();
  if (text) state.assumptions.push(text);
  return true;
}

// ---- Runbook steps ----

/**
 * Parse runbook.md for step definitions.
 * Extracts ### Step N: {step_id} sections with agent: and hitl: lines.
 */
export function parseRunbookSteps(content: string): RunbookStep[] {
  const steps: RunbookStep[] = [];
  let currentStep: Partial<RunbookStep> | null = null;

  for (const line of content.split("\n")) {
    const result = parseRunbookLine(line.trim(), currentStep);
    if (result.emitPrevious && currentStep?.step_id) {
      steps.push(finalizeStep(currentStep));
    }
    currentStep = result.currentStep;
  }

  if (currentStep?.step_id) {
    steps.push(finalizeStep(currentStep));
  }

  return steps;
}

/** Parse a single runbook line, returning the updated parser state. */
function parseRunbookLine(
  trimmed: string,
  currentStep: Partial<RunbookStep> | null,
): { currentStep: Partial<RunbookStep> | null; emitPrevious: boolean } {
  const stepMatch = trimmed.match(/^###\s+Step\s+\d+:\s+(.+)$/);
  if (stepMatch) {
    return {
      currentStep: { step_id: stepMatch[1]?.trim() ?? "" },
      emitPrevious: currentStep?.step_id !== undefined,
    };
  }

  if (currentStep !== null) {
    const agentMatch = trimmed.match(/^agent:\s*(.+)$/);
    if (agentMatch) {
      currentStep.agent = agentMatch[1]?.trim() ?? "";
    } else {
      const hitlMatch = trimmed.match(/^hitl:\s*(.+)$/);
      if (hitlMatch) {
        currentStep.hitl = hitlMatch[1]?.trim() ?? "";
      }
    }
  }

  return { currentStep, emitPrevious: false };
}

export function finalizeStep(partial: Partial<RunbookStep>): RunbookStep {
  return {
    agent: partial.agent ?? "",
    step_id: partial.step_id ?? "",
    ...(partial.hitl !== undefined ? { hitl: partial.hitl } : {}),
  };
}

// ---- Review file parsing ----

/**
 * Parse a review .md file for verdict, violations, and honored principles.
 * Returns null if the file has no usable frontmatter.
 */
export function parseReviewFile(content: string): ReviewResult | null {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) {
    return {
      files_reviewed: 0,
      honored: [],
      principles_checked: 0,
      verdict: "",
      violations: [],
    };
  }

  const verdict = typeof frontmatter.verdict === "string" ? frontmatter.verdict : "";
  const filesReviewed =
    typeof frontmatter["files-reviewed"] === "number" ? frontmatter["files-reviewed"] : 0;
  const principlesChecked =
    typeof frontmatter["principles-checked"] === "number" ? frontmatter["principles-checked"] : 0;

  const violations = extractViolationsSection(content);
  const honored = extractHonoredSection(content);

  return {
    files_reviewed: filesReviewed,
    honored,
    principles_checked: principlesChecked,
    verdict,
    violations,
  };
}

// ---- Decision file parsing ----

/**
 * Parse a decision .md file for id, title, chosen option, and rationale snippet.
 * Returns null if the file cannot be parsed.
 */
export function parseDecisionFile(content: string): DecisionSummary | null {
  const frontmatter = extractFrontmatter(content);

  const decisionId =
    frontmatter !== null && typeof frontmatter["decision-id"] === "string"
      ? frontmatter["decision-id"]
      : "";
  const title =
    frontmatter !== null && typeof frontmatter.title === "string" ? frontmatter.title : "";

  const chosenOption = extractChosenOption(content);
  const rationaleSnippet = extractRationaleSnippet(content);

  if (!decisionId && !title) {
    return null;
  }

  return {
    chosen_option: chosenOption,
    decision_id: decisionId,
    rationale_snippet: rationaleSnippet,
    title,
  };
}

// ---- Shared markdown extraction ----

/**
 * Extract YAML frontmatter between --- delimiters.
 * Returns a parsed key/value object or null if no frontmatter found.
 */
export function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return null;

  const result: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;

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
export function extractViolationsSection(content: string): ReviewViolation[] {
  const violations: ReviewViolation[] = [];

  const sectionMatch = content.match(/####\s+Violations\s*\n([\s\S]*?)(?=\n####|\n###|\n##|$)/);
  if (!sectionMatch?.[1]) return violations;

  const sectionContent = sectionMatch[1].trim();
  if (
    sectionContent === "No violations found." ||
    sectionContent === "" ||
    sectionContent === "None."
  ) {
    return violations;
  }

  for (const line of sectionContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    const principleMatch = trimmed.match(/\*\*principle-id\*\*:\s*([^\s—–-][^—–]*?)(?:\s*[—–]|$)/);
    const severityMatch = trimmed.match(/\*\*severity\*\*:\s*([^\s—–-][^—–]*?)(?:\s*[—–]|$)/);
    const fileMatch = trimmed.match(/\*\*file\*\*:\s*([^\s—–-][^—–]*?)(?:\s*[—–]|$)/);

    if (principleMatch) {
      violations.push({
        file_path: fileMatch?.[1]?.trim() ?? null,
        message: extractViolationMessage(trimmed),
        principle_id: principleMatch[1]?.trim() ?? "",
        severity: severityMatch?.[1]?.trim() ?? "unknown",
      });
    }
  }

  return violations;
}

/** Extract the trailing message from a violation line (after last —). */
export function extractViolationMessage(line: string): string {
  const parts = line.split(/\s*[—–]\s*/);
  const last = parts[parts.length - 1]?.trim() ?? "";
  if (!last.startsWith("**")) return last;
  return "";
}

/**
 * Extract honored principles from "#### Honored" section.
 * Returns list of principle IDs (items starting with "- ").
 */
export function extractHonoredSection(content: string): string[] {
  const honored: string[] = [];

  const sectionMatch = content.match(/####\s+Honored\s*\n([\s\S]*?)(?=\n####|\n###|\n##|$)/);
  if (!sectionMatch?.[1]) return honored;

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
export function extractChosenOption(content: string): string {
  const match = content.match(/###\s+Chosen:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

/**
 * Extract and truncate rationale snippet from "### Rationale" section.
 * Truncates to ~200 characters.
 */
export function extractRationaleSnippet(content: string): string {
  const sectionMatch = content.match(/###\s+Rationale\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  if (!sectionMatch?.[1]) return "";

  const text = sectionMatch[1].trim();
  if (text.length <= 200) return text;

  return `${text.slice(0, 200)}...`;
}
