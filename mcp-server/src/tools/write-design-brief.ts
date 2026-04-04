import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

export type WriteDesignBriefInput = {
  constraints: string[];
  decisions_referenced?: string[];
  dependencies?: string[];
  file_targets: Array<{
    path: string;
    action: "create" | "modify" | "delete";
    description?: string;
  }>;
  slug: string;
  task_id: string;
  test_expectations: Array<{
    description: string;
    file?: string;
  }>;
  workspace: string;
};

export type WriteDesignBriefResult = {
  constraint_count: number;
  file_target_count: number;
  meta_path: string;
  path: string;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

function appendOptionalList(lines: string[], heading: string, items?: string[]): void {
  if (items && items.length > 0) {
    lines.push(`### ${heading}`);
    lines.push("");
    for (const item of items) {
      lines.push(`- ${escapeMdCell(item)}`);
    }
    lines.push("");
  }
}

function generateMarkdown(input: WriteDesignBriefInput): string {
  const lines: string[] = [];
  lines.push(`## Design Brief: ${input.task_id}`);
  lines.push("");

  lines.push("### File Targets");
  lines.push("");
  lines.push("| Path | Action | Description |");
  lines.push("|------|--------|-------------|");
  for (const ft of input.file_targets) {
    const desc = ft.description ?? "—";
    lines.push(`| ${escapeMdCell(ft.path)} | ${escapeMdCell(ft.action)} | ${escapeMdCell(desc)} |`);
  }
  lines.push("");

  lines.push("### Constraints");
  lines.push("");
  for (const c of input.constraints) {
    lines.push(`- ${escapeMdCell(c)}`);
  }
  lines.push("");

  lines.push("### Test Expectations");
  lines.push("");
  lines.push("| Description | File |");
  lines.push("|-------------|------|");
  for (const te of input.test_expectations) {
    const file = te.file ?? "—";
    lines.push(`| ${escapeMdCell(te.description)} | ${escapeMdCell(file)} |`);
  }
  lines.push("");

  appendOptionalList(lines, "Decisions Referenced", input.decisions_referenced);
  appendOptionalList(lines, "Dependencies", input.dependencies);

  return lines.join("\n");
}

export async function writeDesignBrief(
  input: WriteDesignBriefInput,
): Promise<ToolResult<WriteDesignBriefResult>> {
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  if (!SLUG_PATTERN.test(input.task_id)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid task_id "${input.task_id}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

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

  const meta: Record<string, unknown> = {
    _type: "design_brief",
    _version: 1,
    constraints: input.constraints,
    file_targets: input.file_targets,
    slug: input.slug,
    task_id: input.task_id,
    test_expectations: input.test_expectations,
  };
  if (input.decisions_referenced !== undefined) {
    meta.decisions_referenced = input.decisions_referenced;
  }
  if (input.dependencies !== undefined) {
    meta.dependencies = input.dependencies;
  }

  await mkdir(handoffsDir, { recursive: true });
  const briefPath = join(handoffsDir, "DESIGN-BRIEF.md");
  const metaPath = join(handoffsDir, "DESIGN-BRIEF.meta.json");

  await writeFile(briefPath, content, "utf-8");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    constraint_count: input.constraints.length,
    file_target_count: input.file_targets.length,
    meta_path: metaPath,
    path: briefPath,
  });
}
