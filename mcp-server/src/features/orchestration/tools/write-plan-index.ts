import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { assertWorkspaceInitialized } from "../services/validate-workspace-initialized.ts";

export type WritePlanIndexInput = {
  workspace: string;
  slug: string;
  tasks: Array<{
    task_id: string;
    wave: number;
    depends_on?: string[];
    files?: string[];
    principles?: string[];
  }>;
};

export type WritePlanIndexResult = {
  path: string;
  task_count: number;
  wave_count: number;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Validate input fields and resolve the plans directory. Returns error or plansDir. */
function validatePlanIndexInput(input: WritePlanIndexInput): ToolResult<{ plansDir: string }> {
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }

  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  for (const task of input.tasks) {
    if (!SLUG_PATTERN.test(task.task_id)) {
      return toolError(
        "INVALID_INPUT",
        `Invalid task_id "${task.task_id}": must match /^[a-zA-Z0-9_-]+$/; only alphanumeric, underscore, and hyphen allowed`,
      );
    }
    if (task.wave < 1) {
      return toolError(
        "INVALID_INPUT",
        `Task "${task.task_id}" has invalid wave ${task.wave}: must be >= 1`,
      );
    }
  }

  const ids = input.tasks.map((t) => t.task_id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    return toolError("INVALID_INPUT", `Duplicate task IDs: ${[...new Set(dupes)].join(", ")}`);
  }

  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const plansRoot = resolve(join(input.workspace, "plans"));
  if (!plansDir.startsWith(`${plansRoot}/`)) {
    return toolError(
      "INVALID_INPUT",
      `Slug "${input.slug}" resolves outside workspace plans directory`,
    );
  }

  return toolOk({ plansDir });
}

/** Build the normalized markdown table content for the plan index. */
function generatePlanIndexMarkdown(input: WritePlanIndexInput): string {
  const header = "| Task | Wave | Depends on | Files | Principles |";
  const separator = "|------|------|------------|-------|------------|";
  const rows = input.tasks.map((t) => {
    const deps = t.depends_on?.join(", ") ?? "—";
    const files = t.files?.join(", ") ?? "";
    const principles = t.principles?.join(", ") ?? "";
    return `| ${t.task_id} | ${t.wave} | ${deps} | ${files} | ${principles} |`;
  });
  return `## Plan Index: ${input.slug}\n\n${header}\n${separator}\n${rows.join("\n")}\n`;
}

export async function writePlanIndex(
  input: WritePlanIndexInput,
): Promise<ToolResult<WritePlanIndexResult>> {
  const validation = validatePlanIndexInput(input);
  if (!validation.ok) return validation;
  const { plansDir } = validation;

  const wsErr = assertWorkspaceInitialized(input.workspace);
  if (wsErr) return wsErr;

  const content = generatePlanIndexMarkdown(input);
  const waveCount = new Set(input.tasks.map((t) => t.wave)).size;

  await mkdir(plansDir, { recursive: true });
  const indexPath = join(plansDir, "INDEX.md");
  await writeFile(indexPath, content, "utf-8");

  return toolOk({
    path: indexPath,
    task_count: input.tasks.length,
    wave_count: waveCount,
  });
}
