import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

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
  return meta;
}

export async function writeImplementationSummary(
  input: WriteImplementationSummaryInput,
): Promise<ToolResult<WriteImplementationSummaryResult>> {
  const validationError = validateSlugAndTaskId(input);
  if (validationError) return validationError;

  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const content = buildSummaryMarkdown(input);
  const meta = buildSummaryMeta(input);

  await mkdir(plansDir, { recursive: true });
  const summaryPath = join(plansDir, "IMPLEMENTATION-SUMMARY.md");
  const metaPath = join(plansDir, "IMPLEMENTATION-SUMMARY.meta.json");

  await writeFile(summaryPath, content, "utf-8");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    files_changed_count: input.files_changed.length,
    meta_path: metaPath,
    path: summaryPath,
  });
}
