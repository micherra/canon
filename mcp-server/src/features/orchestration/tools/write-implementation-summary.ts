import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { emitWriteReceipt } from "../services/write-receipt.ts";
import type { AreaMemoryWriter } from "./write-review.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

/** A structured decision record capturing what was chosen, why, and what influenced it. */
export type DecisionRecord = {
  choice: string;
  rationale: string;
  alternatives_considered?: string[];
  informed_by?: Array<{
    type: "area_memory" | "pitfall" | "principle" | "task_plan" | "codebase_pattern";
    ref: string;
  }>;
};

export type WriteImplementationSummaryInput = {
  workspace: string;
  slug: string;
  task_id: string;
  files_changed: Array<{
    path: string;
    action: "added" | "modified" | "deleted";
  }>;
  decisions_applied?: string[];
  deviations?: Array<{
    decision_id: string;
    reason: string;
  }>;
  tests_added?: string[];
  decisions?: DecisionRecord[];
};

export type WriteImplementationSummaryResult = {
  path: string;
  meta_path: string;
  files_changed_count: number;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateSlugAndTaskId(input: WriteImplementationSummaryInput): ToolResult<never> | null {
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
  if (!SLUG_PATTERN.test(input.task_id)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid task_id "${input.task_id}": must match /^[a-zA-Z0-9_-]+$/; only alphanumeric, underscore, and hyphen allowed`,
    );
  }
  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const plansRoot = resolve(join(input.workspace, "plans"));
  const rel = relative(plansRoot, plansDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError(
      "INVALID_INPUT",
      `Slug "${input.slug}" resolves outside workspace plans directory`,
    );
  }
  return null;
}

function appendOptionalSection(
  lines: string[],
  heading: string,
  items: string[] | undefined,
  format: (item: string) => string,
): void {
  if (!items || items.length === 0) return;
  lines.push(`### ${heading}`, "");
  for (const item of items) lines.push(format(item));
  lines.push("");
}

function buildDecisionsTable(decisions: DecisionRecord[]): string[] {
  const lines: string[] = [];
  lines.push("### Decisions", "");
  lines.push("| # | Choice | Rationale | Informed By |");
  lines.push("|---|--------|-----------|-------------|");
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const informedBy =
      d.informed_by && d.informed_by.length > 0
        ? d.informed_by.map((inf) => `${inf.type}:${escapeMdCell(inf.ref)}`).join(", ")
        : "—";
    lines.push(
      `| ${i + 1} | ${escapeMdCell(d.choice)} | ${escapeMdCell(d.rationale)} | ${informedBy} |`,
    );
  }
  lines.push("");
  return lines;
}

function buildSummaryMarkdown(input: WriteImplementationSummaryInput): string {
  const lines: string[] = [];
  lines.push(`## Implementation Summary: ${input.task_id}`, "");
  lines.push("### Files Changed", "", "| Path | Action |", "|------|--------|");
  for (const file of input.files_changed) {
    lines.push(`| ${escapeMdCell(file.path)} | ${escapeMdCell(file.action)} |`);
  }
  lines.push("");

  appendOptionalSection(
    lines,
    "Decisions Applied",
    input.decisions_applied,
    (dec) => `- ${escapeMdCell(dec)}`,
  );
  appendOptionalSection(
    lines,
    "Deviations",
    input.deviations?.map((d) => `**${escapeMdCell(d.decision_id)}**: ${escapeMdCell(d.reason)}`),
    (item) => `- ${item}`,
  );
  appendOptionalSection(
    lines,
    "Tests Added",
    input.tests_added,
    (test) => `- ${escapeMdCell(test)}`,
  );

  if (input.decisions && input.decisions.length > 0) {
    lines.push(...buildDecisionsTable(input.decisions));
  }

  return lines.join("\n");
}

function buildSummaryMeta(input: WriteImplementationSummaryInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    _type: "implementation_summary",
    _version: 1,
    files_changed: input.files_changed,
    task_id: input.task_id,
  };
  if (input.decisions_applied !== undefined) meta.decisions_applied = input.decisions_applied;
  if (input.deviations !== undefined) meta.deviations = input.deviations;
  if (input.tests_added !== undefined) meta.tests_added = input.tests_added;
  if (input.decisions !== undefined) meta.decisions = input.decisions;
  return meta;
}

/**
 * Log structured decision records as agent_decision events in the execution store.
 * Fail-open: store errors do not surface to callers.
 */
function logDecisionEvents(input: WriteImplementationSummaryInput): void {
  if (!input.decisions || input.decisions.length === 0) return;
  try {
    const store = getExecutionStore(input.workspace);
    const timestamp = new Date().toISOString();
    for (const decision of input.decisions) {
      store.appendEvent("agent_decision", {
        agent_type: "engineer",
        alternatives_considered: decision.alternatives_considered ?? [],
        choice: decision.choice,
        informed_by: decision.informed_by ?? [],
        rationale: decision.rationale,
        step_id: input.task_id,
        timestamp,
        workflow_slug: input.slug,
      });
    }
  } catch (err) {
    console.warn(
      "[write-impl-summary] decision event logging failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Extract area observations from engineer deviations and store them.
 * Maps each deviation to each subsystem touched by the changed files.
 * Fail-open: observation write errors do not surface to callers.
 */
function storeDeviationObservations(
  input: WriteImplementationSummaryInput,
  areaMemoryWriter: AreaMemoryWriter,
): void {
  if (!input.deviations || input.deviations.length === 0) return;
  const subsystemKeys = new Set(input.files_changed.map((f) => deriveSubsystemKey(f.path)));
  for (const dev of input.deviations) {
    const devContent = `Deviation from ${dev.decision_id}: ${dev.reason}`;
    for (const key of subsystemKeys) {
      try {
        areaMemoryWriter.insertObservation({
          content: devContent,
          source: "engineer",
          subsystem_key: key,
          workflow_slug: input.slug,
        });
      } catch (err) {
        console.warn(
          "[write-impl-summary] deviation observation insert failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

export async function writeImplementationSummary(
  input: WriteImplementationSummaryInput,
  areaMemoryWriter?: AreaMemoryWriter,
): Promise<ToolResult<WriteImplementationSummaryResult>> {
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }
  const validationError = validateSlugAndTaskId(input);
  if (validationError) return validationError;

  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const summaryMarkdown = buildSummaryMarkdown(input);
  const meta = buildSummaryMeta(input);

  await mkdir(plansDir, { recursive: true });
  const summaryPath = join(plansDir, `${input.task_id}-SUMMARY.md`);
  const metaPath = join(plansDir, `${input.task_id}-SUMMARY.meta.json`);

  await writeFile(summaryPath, summaryMarkdown, "utf-8");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  emitWriteReceipt(input.workspace, {
    artifact_kind: "implementation_summary",
    artifact_path: summaryPath,
    slug: input.slug,
    task_id: input.task_id,
  });

  logDecisionEvents(input);

  if (areaMemoryWriter) {
    try {
      storeDeviationObservations(input, areaMemoryWriter);
    } catch (err) {
      console.warn(
        "[write-impl-summary] area observation extraction failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return toolOk({
    files_changed_count: input.files_changed.length,
    meta_path: metaPath,
    path: summaryPath,
  });
}
