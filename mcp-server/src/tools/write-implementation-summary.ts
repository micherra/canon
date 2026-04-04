import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { toolOk, toolError, type ToolResult } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

export interface WriteImplementationSummaryInput {
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
}

export interface WriteImplementationSummaryResult {
  path: string;
  meta_path: string;
  files_changed_count: number;
}

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function writeImplementationSummary(
  input: WriteImplementationSummaryInput,
): Promise<ToolResult<WriteImplementationSummaryResult>> {
  // Validate slug
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  // Validate task_id
  if (!SLUG_PATTERN.test(input.task_id)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid task_id "${input.task_id}": must match /^[a-zA-Z0-9_-]+$/; only alphanumeric, underscore, and hyphen allowed`,
    );
  }

  // Validate path traversal safety
  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const plansRoot = resolve(join(input.workspace, "plans"));
  const rel = relative(plansRoot, plansDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError(
      "INVALID_INPUT",
      `Slug "${input.slug}" resolves outside workspace plans directory`,
    );
  }

  // Build normalized markdown
  const lines: string[] = [];
  lines.push(`## Implementation Summary: ${input.task_id}`);
  lines.push("");

  // Files changed table
  lines.push("### Files Changed");
  lines.push("");
  lines.push("| Path | Action |");
  lines.push("|------|--------|");
  for (const file of input.files_changed) {
    lines.push(`| ${escapeMdCell(file.path)} | ${escapeMdCell(file.action)} |`);
  }
  lines.push("");

  // Decisions applied
  if (input.decisions_applied && input.decisions_applied.length > 0) {
    lines.push("### Decisions Applied");
    lines.push("");
    for (const dec of input.decisions_applied) {
      lines.push(`- ${escapeMdCell(dec)}`);
    }
    lines.push("");
  }

  // Deviations
  if (input.deviations && input.deviations.length > 0) {
    lines.push("### Deviations");
    lines.push("");
    for (const dev of input.deviations) {
      lines.push(`- **${escapeMdCell(dev.decision_id)}**: ${escapeMdCell(dev.reason)}`);
    }
    lines.push("");
  }

  // Tests added
  if (input.tests_added && input.tests_added.length > 0) {
    lines.push("### Tests Added");
    lines.push("");
    for (const test of input.tests_added) {
      lines.push(`- ${escapeMdCell(test)}`);
    }
    lines.push("");
  }

  const content = lines.join("\n");

  // Build meta JSON
  const meta: Record<string, unknown> = {
    _type: "implementation_summary",
    _version: 1,
    task_id: input.task_id,
    files_changed: input.files_changed,
  };
  if (input.decisions_applied !== undefined) {
    meta.decisions_applied = input.decisions_applied;
  }
  if (input.deviations !== undefined) {
    meta.deviations = input.deviations;
  }
  if (input.tests_added !== undefined) {
    meta.tests_added = input.tests_added;
  }

  // Write files
  await mkdir(plansDir, { recursive: true });
  const summaryPath = join(plansDir, "IMPLEMENTATION-SUMMARY.md");
  const metaPath = join(plansDir, "IMPLEMENTATION-SUMMARY.meta.json");

  await writeFile(summaryPath, content, "utf-8");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    path: summaryPath,
    meta_path: metaPath,
    files_changed_count: input.files_changed.length,
  });
}
