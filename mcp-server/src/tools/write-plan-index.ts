import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { toolOk, toolError, type ToolResult } from "../utils/tool-result.ts";

export interface WritePlanIndexInput {
  workspace: string;
  slug: string;
  tasks: Array<{
    task_id: string;
    wave: number;
    depends_on?: string[];
    files?: string[];
    principles?: string[];
  }>;
}

export interface WritePlanIndexResult {
  path: string;
  task_count: number;
  wave_count: number;
}

const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function writePlanIndex(
  input: WritePlanIndexInput,
): Promise<ToolResult<WritePlanIndexResult>> {
  // Validate task IDs and wave numbers
  for (const task of input.tasks) {
    if (!TASK_ID_PATTERN.test(task.task_id)) {
      return toolError(
        "INVALID_INPUT",
        `Invalid task_id "${task.task_id}": must match /^[a-zA-Z0-9_-]+$/`,
      );
    }
    if (task.wave < 1) {
      return toolError(
        "INVALID_INPUT",
        `Task "${task.task_id}" has invalid wave ${task.wave}: must be >= 1`,
      );
    }
  }

  // Check for duplicate task IDs
  const ids = input.tasks.map((t) => t.task_id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    return toolError(
      "INVALID_INPUT",
      `Duplicate task IDs: ${[...new Set(dupes)].join(", ")}`,
    );
  }

  // Build normalized markdown table
  const header = "| Task | Wave | Depends on | Files | Principles |";
  const separator = "|------|------|------------|-------|------------|";
  const rows = input.tasks.map((t) => {
    const deps = t.depends_on?.join(", ") ?? "—";
    const files = t.files?.join(", ") ?? "";
    const principles = t.principles?.join(", ") ?? "";
    return `| ${t.task_id} | ${t.wave} | ${deps} | ${files} | ${principles} |`;
  });

  const waveCount = new Set(input.tasks.map((t) => t.wave)).size;
  const content = `## Plan Index: ${input.slug}\n\n${header}\n${separator}\n${rows.join("\n")}\n`;

  const plansDir = join(input.workspace, "plans", input.slug);
  await mkdir(plansDir, { recursive: true });
  const indexPath = join(plansDir, "INDEX.md");
  await writeFile(indexPath, content, "utf-8");

  return toolOk({
    path: indexPath,
    task_count: input.tasks.length,
    wave_count: waveCount,
  });
}
