/**
 * Run Summary Extractors — pure text-parsing helpers for run-summary-builder.
 *
 * These functions parse planning-brief.md, runbook.md, and review .md files
 * into structured types for RunSummary construction.
 *
 * All functions are pure (no I/O) and never throw — parse errors return partial/empty data.
 */

import type { ReviewResult, ReviewViolation, RunbookStep } from "./archive-types.ts";

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

function finalizeStep(partial: Partial<RunbookStep>): RunbookStep {
  return {
    agent: partial.agent ?? "",
    step_id: partial.step_id ?? "",
    ...(partial.hitl !== undefined ? { hitl: partial.hitl } : {}),
  };
}

// ---- Notable resolution (digest enrichment) ----

const NOTABLE_RESOLUTION_MAX_CHARS = 200;

/**
 * Extract a single-line "notable resolution" from an engineer SUMMARY (preferred)
 * or architect DESIGN.md (fallback), for the build-digest `### Notable Resolution`
 * section. First non-empty source wins:
 *   1. summaryContent: first data row of the `### Decisions` table (Rationale cell)
 *   2. summaryContent: first item under `### Deviations` (the reason after `**{id}**:`)
 *   3. designContent: first bullet under `### Decisions made`
 *   4. otherwise: ""
 *
 * Pure, no I/O, never throws — matches the sibling extractor contract. Result is
 * capped at 200 chars, single line (newlines stripped, whitespace collapsed).
 */
export function extractNotableResolution(summaryContent: string, designContent?: string): string {
  try {
    const fromDecisions = extractFromDecisionsTable(summaryContent ?? "");
    if (fromDecisions) return toSingleLine(fromDecisions);

    const fromDeviations = extractFromDeviations(summaryContent ?? "");
    if (fromDeviations) return toSingleLine(fromDeviations);

    if (designContent) {
      const fromDesign = extractFromDesignDecisionsMade(designContent);
      if (fromDesign) return toSingleLine(fromDesign);
    }

    return "";
  } catch {
    return "";
  }
}

/** Collapse to a single line and cap at NOTABLE_RESOLUTION_MAX_CHARS. */
function toSingleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > NOTABLE_RESOLUTION_MAX_CHARS
    ? collapsed.slice(0, NOTABLE_RESOLUTION_MAX_CHARS)
    : collapsed;
}

/** Split a markdown table row into trimmed cells (outer pipes stripped). */
function splitTableRow(line: string): string[] {
  const withoutOuterPipes = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

/** Extract the Rationale cell from the first data row of the `### Decisions` table. */
function extractFromDecisionsTable(content: string): string {
  const sectionMatch = content.match(/^###\s+Decisions\s*\n([\s\S]*?)(?=\n##|\n###|$)/m);
  if (!sectionMatch?.[1]) return "";

  const tableLines = sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (tableLines.length < 3) return "";

  const header = splitTableRow(tableLines[0]);
  const dataRow = splitTableRow(tableLines[2]);
  const rationaleIdx = header.findIndex((cell) => /rationale/i.test(cell));
  if (rationaleIdx === -1) return "";

  return dataRow[rationaleIdx] ?? "";
}

/** Extract the reason text of the first item under `### Deviations` (after `**{id}**:`). */
function extractFromDeviations(content: string): string {
  const sectionMatch = content.match(/^###\s+Deviations\s*\n([\s\S]*?)(?=\n##|\n###|$)/m);
  if (!sectionMatch?.[1]) return "";

  const body = sectionMatch[1];
  const startMatch = body.match(/^-\s*\*\*(.+?)\*\*:\s*/m);
  if (!startMatch || startMatch.index === undefined) return "";

  const afterPrefix = body.slice(startMatch.index + startMatch[0].length);
  const nextBulletIdx = afterPrefix.search(/\n-\s/);
  const reason = nextBulletIdx === -1 ? afterPrefix : afterPrefix.slice(0, nextBulletIdx);
  return reason.trim();
}

/** Extract the text of the first bullet under `### Decisions made`. */
function extractFromDesignDecisionsMade(content: string): string {
  const sectionMatch = content.match(/^###\s+Decisions made\s*\n([\s\S]*?)(?=\n##|\n###|$)/m);
  if (!sectionMatch?.[1]) return "";

  for (const line of sectionMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) return trimmed.slice(2).trim();
  }
  return "";
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

// ---- Shared markdown extraction ----

/**
 * Extract YAML frontmatter between --- delimiters.
 * Returns a parsed key/value object or null if no frontmatter found.
 */
function extractFrontmatter(content: string): Record<string, unknown> | null {
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
function extractViolationsSection(content: string): ReviewViolation[] {
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
function extractViolationMessage(line: string): string {
  const parts = line.split(/\s*[—–]\s*/);
  const last = parts[parts.length - 1]?.trim() ?? "";
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
  if (!sectionMatch?.[1]) return honored;

  for (const line of sectionMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      honored.push(trimmed.slice(2).trim());
    }
  }

  return honored;
}
