/**
 * Wave variable resolution for inter-wave communication.
 *
 * Reads plan files, summaries, and diffs to populate the variables map
 * that is injected into agent spawn prompts at wave boundaries.
 *
 * All values sourced from agent output pass through escapeDollarBrace
 * before entering the variables map to prevent unintended prompt injection.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gitExec } from "../adapters/git-adapter.ts";
import path from "node:path";

/**
 * Escapes `${` patterns in agent-sourced text to prevent unintended
 * variable expansion when the text is later processed by substituteVariables.
 *
 * This is the trust-boundary sanitizer: any string sourced from agent output
 * (summaries, plan files, git diffs) must pass through this function before
 * being placed in the variables map.
 */
export function escapeDollarBrace(text: string): string {
  return text.replace(/\$\{/g, "\\${");
}

/**
 * Resolve wave variables for injection into agent spawn prompts.
 *
 * Returns a map with five keys:
 * - wave_plans: concatenated plan files for the current wave
 * - wave_summaries: concatenated summary files from the previous wave
 * - wave_files: file paths extracted from previous wave summaries
 * - wave_diff: output of git diff HEAD~1
 * - all_summaries: all summary files across all completed waves
 *
 * Follows graceful degradation: missing files emit warnings and return
 * partial data. Never throws.
 */
export async function resolveWaveVariables(
  workspace: string,
  wave: number,
  slug: string,
  _totalWaves: number,
  projectDir?: string,
): Promise<Record<string, string>> {
  const plansDir = path.join(workspace, "plans", slug);

  const [wave_plans, wave_summaries, wave_files, all_summaries] =
    await Promise.all([
      readWavePlans(plansDir, wave),
      readWaveSummaries(plansDir, wave),
      readWaveFiles(plansDir, wave),
      readAllSummaries(plansDir),
    ]);

  const resolvedProjectDir = projectDir ?? process.env.CANON_PROJECT_DIR ?? process.cwd();
  const wave_diff = readWaveDiff(resolvedProjectDir);

  return {
    wave_plans,
    wave_summaries,
    wave_files,
    wave_diff,
    all_summaries,
  };
}

// ---------------------------------------------------------------------------
// Private helpers — each resolves one variable
// ---------------------------------------------------------------------------

/**
 * Read and concatenate plan files for the current wave.
 * Parses INDEX.md to find which task IDs belong to the current wave.
 */
async function readWavePlans(plansDir: string, wave: number): Promise<string> {
  const taskIds = await parseIndexForWave(plansDir, wave);
  if (taskIds.length === 0) {
    return "";
  }

  const contents = await Promise.all(
    taskIds.map((taskId) =>
      safeReadFile(
        path.join(plansDir, `${taskId}-PLAN.md`),
        `wave_plans: plan file for ${taskId}`,
      ),
    ),
  );

  return escapeDollarBrace(contents.filter((c): c is string => c !== null).join("\n\n"));
}

/**
 * Read and concatenate summary files from the previous wave (wave - 1).
 * Returns empty string for wave 1 (no prior wave).
 */
async function readWaveSummaries(plansDir: string, wave: number): Promise<string> {
  if (wave <= 1) {
    return "";
  }

  const taskIds = await parseIndexForWave(plansDir, wave - 1);
  if (taskIds.length === 0) {
    return "";
  }

  const contents = await Promise.all(
    taskIds.map((taskId) =>
      safeReadFile(
        path.join(plansDir, `${taskId}-SUMMARY.md`),
        `wave_summaries: summary for ${taskId}`,
      ),
    ),
  );

  return escapeDollarBrace(contents.filter((c): c is string => c !== null).join("\n\n"));
}

/**
 * Extract file paths mentioned in previous wave summaries.
 * Looks for lines that match common path patterns (src/..., mcp-server/..., etc.).
 * Returns empty string for wave 1.
 */
async function readWaveFiles(plansDir: string, wave: number): Promise<string> {
  if (wave <= 1) {
    return "";
  }

  const taskIds = await parseIndexForWave(plansDir, wave - 1);
  if (taskIds.length === 0) {
    return "";
  }

  const allPaths = new Set<string>();

  const contents = await Promise.all(
    taskIds.map((taskId) =>
      safeReadFile(
        path.join(plansDir, `${taskId}-SUMMARY.md`),
        `wave_files: summary for ${taskId}`,
      ),
    ),
  );

  for (const content of contents) {
    if (content !== null) {
      extractFilePaths(content).forEach((p) => allPaths.add(p));
    }
  }

  return escapeDollarBrace(Array.from(allPaths).join("\n"));
}

/**
 * Run git diff HEAD~1 and return the output.
 * Returns empty string on failure (git not available, no prior commit, etc.).
 * cwd is set to projectDir to ensure we diff the correct repository when the
 * MCP server process cwd differs from the project root.
 */
function readWaveDiff(cwd: string): string {
  const result = gitExec(["diff", "HEAD~1"], cwd);
  if (!result.ok) {
    console.error(`wave_diff: git diff failed — exitCode=${result.exitCode}`);
    return "";
  }
  return escapeDollarBrace(result.stdout);
}

/**
 * Read all *-SUMMARY.md files across all completed waves.
 * Concatenates them in task-ID order.
 */
async function readAllSummaries(plansDir: string): Promise<string> {
  const indexPath = path.join(plansDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    console.error(`all_summaries: INDEX.md not found at ${indexPath}`);
    return "";
  }

  let indexContent: string;
  try {
    indexContent = await readFile(indexPath, "utf-8");
  } catch (err) {
    console.error(`all_summaries: failed to read INDEX.md — ${String(err)}`);
    return "";
  }

  // Parse all task IDs from the index regardless of wave
  const taskIds = parseAllTaskIds(indexContent);
  if (taskIds.length === 0) {
    return "";
  }

  const contents: string[] = [];
  for (const taskId of taskIds) {
    const summaryPath = path.join(plansDir, `${taskId}-SUMMARY.md`);
    const content = await safeReadFile(summaryPath, null); // silent — not all may be done
    if (content !== null) {
      contents.push(content);
    }
  }

  return escapeDollarBrace(contents.join("\n\n"));
}

// ---------------------------------------------------------------------------
// INDEX.md parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse INDEX.md and return task IDs that belong to the given wave number.
 */
async function parseIndexForWave(plansDir: string, wave: number): Promise<string[]> {
  const indexPath = path.join(plansDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    console.error(`parseIndexForWave: INDEX.md not found at ${indexPath}`);
    return [];
  }

  let content: string;
  try {
    content = await readFile(indexPath, "utf-8");
  } catch (err) {
    console.error(`parseIndexForWave: failed to read INDEX.md — ${String(err)}`);
    return [];
  }

  return parseTaskIdsForWave(content, wave);
}

/**
 * Parse task IDs for a specific wave from INDEX.md content.
 * Expects rows like: | iwc-01 | 1 | ...
 */
export function parseTaskIdsForWave(indexContent: string, wave: number): string[] {
  const taskIds: string[] = [];
  const lines = indexContent.split("\n");

  for (const line of lines) {
    // Match table rows: | task-id | wave-number | ...
    const match = line.match(/^\|\s*([a-zA-Z0-9_-]+)\s*\|\s*(\d+)\s*\|/);
    if (!match) continue;

    const taskId = match[1].trim();
    const rowWave = parseInt(match[2], 10);

    // Skip header rows
    if (taskId === "Task" || taskId === "---") continue;

    if (rowWave === wave) {
      taskIds.push(taskId);
    }
  }

  return taskIds;
}

/**
 * Parse all task IDs from INDEX.md content (any wave).
 */
function parseAllTaskIds(indexContent: string): string[] {
  const taskIds: string[] = [];
  const lines = indexContent.split("\n");

  for (const line of lines) {
    const match = line.match(/^\|\s*([a-zA-Z0-9_-]+)\s*\|\s*(\d+)\s*\|/);
    if (!match) continue;

    const taskId = match[1].trim();
    if (taskId === "Task" || taskId === "---") continue;

    taskIds.push(taskId);
  }

  return taskIds;
}

// ---------------------------------------------------------------------------
// File path extraction
// ---------------------------------------------------------------------------

/**
 * Extract file paths from summary content.
 * Looks for backtick-quoted paths and lines that look like file paths.
 */
export function extractFilePaths(content: string): string[] {
  const paths = new Set<string>();

  // Match backtick-quoted paths: `src/foo/bar.ts`
  const backtickPattern = /`([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,10})`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickPattern.exec(content)) !== null) {
    const candidate = m[1];
    if (looksLikeFilePath(candidate)) {
      paths.add(candidate);
    }
  }

  // Match lines that start with a path-like token (e.g., in "| `path` | created |" table rows)
  const linePattern = /\|\s*`?([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,10})`?\s*\|/g;
  while ((m = linePattern.exec(content)) !== null) {
    const candidate = m[1].trim();
    if (looksLikeFilePath(candidate)) {
      paths.add(candidate);
    }
  }

  return Array.from(paths);
}

function looksLikeFilePath(s: string): boolean {
  // Must contain a slash or look like a relative path with an extension
  return (s.includes("/") || s.includes("\\")) && s.includes(".");
}

// ---------------------------------------------------------------------------
// Safe file read
// ---------------------------------------------------------------------------

/**
 * Read a file, returning null if it doesn't exist or can't be read.
 * Logs a warning only if warningPrefix is provided.
 */
async function safeReadFile(
  filePath: string,
  warningPrefix: string | null,
): Promise<string | null> {
  if (!existsSync(filePath)) {
    if (warningPrefix) {
      console.error(`${warningPrefix}: file not found — ${filePath}`);
    }
    return null;
  }

  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if (warningPrefix) {
      console.error(`${warningPrefix}: failed to read ${filePath} — ${String(err)}`);
    }
    return null;
  }
}
