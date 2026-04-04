import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { toolOk, toolError, type ToolResult } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

export interface WriteDesignBriefInput {
  workspace: string;
  slug: string;
  task_id: string;
  file_targets: Array<{
    path: string;
    action: "create" | "modify" | "delete";
    description?: string;
  }>;
  constraints: string[];
  test_expectations: Array<{
    description: string;
    file?: string;
  }>;
  decisions_referenced?: string[];
  dependencies?: string[];
}

export interface WriteDesignBriefResult {
  path: string;
  meta_path: string;
  file_target_count: number;
  constraint_count: number;
}

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

function generateMarkdown(input: WriteDesignBriefInput): string {
  const lines: string[] = [];
  lines.push(`## Design Brief: ${input.task_id}`);
  lines.push("");

  // File targets table
  lines.push("### File Targets");
  lines.push("");
  lines.push("| Path | Action | Description |");
  lines.push("|------|--------|-------------|");
  for (const ft of input.file_targets) {
    const desc = ft.description ?? "—";
    lines.push(
      `| ${escapeMdCell(ft.path)} | ${escapeMdCell(ft.action)} | ${escapeMdCell(desc)} |`,
    );
  }
  lines.push("");

  // Constraints list
  lines.push("### Constraints");
  lines.push("");
  for (const c of input.constraints) {
    lines.push(`- ${escapeMdCell(c)}`);
  }
  lines.push("");

  // Test expectations table
  lines.push("### Test Expectations");
  lines.push("");
  lines.push("| Description | File |");
  lines.push("|-------------|------|");
  for (const te of input.test_expectations) {
    const file = te.file ?? "—";
    lines.push(`| ${escapeMdCell(te.description)} | ${escapeMdCell(file)} |`);
  }
  lines.push("");

  // Optional: decisions referenced
  if (input.decisions_referenced && input.decisions_referenced.length > 0) {
    lines.push("### Decisions Referenced");
    lines.push("");
    for (const d of input.decisions_referenced) {
      lines.push(`- ${escapeMdCell(d)}`);
    }
    lines.push("");
  }

  // Optional: dependencies
  if (input.dependencies && input.dependencies.length > 0) {
    lines.push("### Dependencies");
    lines.push("");
    for (const dep of input.dependencies) {
      lines.push(`- ${escapeMdCell(dep)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeDesignBrief(
  input: WriteDesignBriefInput,
): Promise<ToolResult<WriteDesignBriefResult>> {
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
      `Invalid task_id "${input.task_id}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  // Validate path traversal safety on the handoffs directory
  const handoffsDir = resolve(join(input.workspace, "handoffs"));
  const workspaceRoot = resolve(input.workspace);
  const rel = relative(workspaceRoot, handoffsDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError(
      "INVALID_INPUT",
      `Workspace "${input.workspace}" resolves outside expected directory`,
    );
  }

  const content = generateMarkdown(input);

  // Build meta JSON
  const meta: Record<string, unknown> = {
    _type: "design_brief",
    _version: 1,
    task_id: input.task_id,
    slug: input.slug,
    file_targets: input.file_targets,
    constraints: input.constraints,
    test_expectations: input.test_expectations,
  };
  if (input.decisions_referenced !== undefined) {
    meta.decisions_referenced = input.decisions_referenced;
  }
  if (input.dependencies !== undefined) {
    meta.dependencies = input.dependencies;
  }

  // Write files
  await mkdir(handoffsDir, { recursive: true });
  const briefPath = join(handoffsDir, "DESIGN-BRIEF.md");
  const metaPath = join(handoffsDir, "DESIGN-BRIEF.meta.json");

  await writeFile(briefPath, content, "utf-8");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    path: briefPath,
    meta_path: metaPath,
    file_target_count: input.file_targets.length,
    constraint_count: input.constraints.length,
  });
}
