/**
 * Canon task-list module — read-only wrapper for Claude Code's task list.
 *
 * Phase 1 of the Canon → agent teams migration. Claude Code can pin a task
 * list to a named directory via the `CLAUDE_CODE_TASK_LIST_ID` env var;
 * the list persists under `~/.claude/tasks/<id>/` across sessions and
 * across context compactions.
 *
 * This module is the server-side read path into that directory. It lets
 * the lead-mode orchestrator enumerate the tasks pinned to a workspace
 * without routing through Claude Code's own MCP surface. It is
 * **read-only** by design in Phase 1 — mutation is done by Claude Code
 * (the lead session) via its own task tools.
 *
 * No MCP tool surface. Pure library, safe to import without side
 * effects. Side effects (filesystem reads) happen only inside the
 * exported functions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** A single task as persisted by Claude Code under the task list dir. */
export type TaskRecord = {
  /** Active-form rendering, if the caller wrote one. */
  active_form?: string;
  /** Short human-readable title or content. */
  content: string;
  /** Task identifier (stable across sessions). Usually the file stem. */
  id: string;
  /** Free-form metadata preserved from the source file. */
  metadata?: Record<string, unknown>;
  /** Modification time of the source file (epoch ms). */
  mtime_ms: number;
  /** Absolute path the record was parsed from. */
  source_path: string;
  /** Current task status. Values observed in practice: pending, in_progress, completed, blocked. */
  status: string;
};

/** Options accepted by `readTaskList`. */
export type ReadTaskListOptions = {
  /**
   * Task list identifier. Defaults to the `CLAUDE_CODE_TASK_LIST_ID`
   * environment variable if unset.
   */
  task_list_id?: string;
  /**
   * Override for the task list root. Defaults to `~/.claude/tasks/`.
   * Exposed for tests.
   */
  tasks_root?: string;
};

/** Result returned by `readTaskList`. */
export type ReadTaskListResult = {
  /** Whether the path exists on disk. */
  exists: boolean;
  /** Resolved absolute path of the task list directory. */
  path: string;
  /** Parsed task records, sorted by `id`. */
  tasks: TaskRecord[];
  /** Warnings accumulated while parsing (non-fatal). */
  warnings: string[];
};

/** The absence of a task list id is not an error — return an empty shell. */
const EMPTY_RESULT: Omit<ReadTaskListResult, "path"> = {
  exists: false,
  tasks: [],
  warnings: [],
};

/**
 * Resolve the filesystem path for a task list id.
 *
 * Pure function. Does not check for existence.
 */
export function resolveTaskListPath(taskListId: string, tasksRoot?: string): string {
  const root = tasksRoot ?? join(homedir(), ".claude", "tasks");
  return join(root, taskListId);
}

/**
 * Read the pinned Claude Code task list from disk.
 *
 * Side effects: only reads files. Never throws — malformed files produce
 * warnings, missing directories produce an empty result.
 */
export function readTaskList(options: ReadTaskListOptions = {}): ReadTaskListResult {
  const id = options.task_list_id ?? process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (!id) {
    return {
      path: "",
      ...EMPTY_RESULT,
      warnings: ["CLAUDE_CODE_TASK_LIST_ID is not set; returning an empty task list."],
    };
  }

  const path = resolveTaskListPath(id, options.tasks_root);
  if (!existsSync(path)) {
    return { path, ...EMPTY_RESULT };
  }

  const warnings: string[] = [];
  const entries = listDirSafe(path, warnings);
  if (entries === null) {
    return { exists: true, path, tasks: [], warnings };
  }

  const tasks: TaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = loadTaskFromFile(join(path, entry), warnings);
    if (record) tasks.push(record);
  }

  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { exists: true, path, tasks, warnings };
}

/** List a directory; on failure push a warning and return null. */
function listDirSafe(dirPath: string, warnings: string[]): string[] | null {
  try {
    return readdirSync(dirPath);
  } catch (err) {
    warnings.push(`Failed to read task list directory ${dirPath}: ${(err as Error).message}`);
    return null;
  }
}

/** Load a single task file into a TaskRecord; accumulate warnings on failure. */
function loadTaskFromFile(filePath: string, warnings: string[]): TaskRecord | null {
  try {
    const statInfo = statSync(filePath);
    if (!statInfo.isFile()) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseTaskFile(raw, filePath);
    if (!parsed) {
      warnings.push(`Skipped ${filePath}: not a recognizable task record`);
      return null;
    }
    return {
      ...parsed,
      mtime_ms: statInfo.mtimeMs,
      source_path: filePath,
    };
  } catch (err) {
    warnings.push(`Failed to parse ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Parse one task file's contents into a record.
 *
 * Exposed as a helper so tests can exercise the parser without touching
 * the filesystem.
 */
export function parseTaskFile(
  raw: string,
  sourcePath: string,
): Omit<TaskRecord, "source_path" | "mtime_ms"> | null {
  const record = tryParseObject(raw);
  if (!record) return null;

  // Claude Code task files observed in practice have these fields. We
  // accept a superset and only require `id` + `status` + `content`.
  return {
    active_form: extractActiveForm(record),
    content: typeof record.content === "string" ? record.content : "",
    id: extractTaskId(record, sourcePath),
    metadata: extractMetadata(record),
    status: typeof record.status === "string" ? record.status : "unknown",
  };
}

/** Parse raw text as JSON; return the object or null if empty / not-an-object. */
function tryParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;
  return parsed as Record<string, unknown>;
}

/** Resolve the task id, falling back to the filename stem. */
function extractTaskId(record: Record<string, unknown>, sourcePath: string): string {
  const raw = record.id ?? record.task_id ?? basename(sourcePath, ".json");
  return typeof raw === "string" ? raw : String(raw);
}

/** Accept both snake_case and camelCase active-form fields. */
function extractActiveForm(record: Record<string, unknown>): string | undefined {
  if (typeof record.active_form === "string") return record.active_form;
  if (typeof record.activeForm === "string") return record.activeForm;
  return undefined;
}

/** Everything outside the known key set becomes metadata; absent if empty. */
const KNOWN_TASK_KEYS = new Set([
  "id",
  "task_id",
  "status",
  "content",
  "active_form",
  "activeForm",
]);

function extractMetadata(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!KNOWN_TASK_KEYS.has(k)) metadata[k] = v;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Filter tasks by status. Convenience wrapper around `readTaskList`.
 *
 * Side effects: delegates to `readTaskList`, so it reads the filesystem
 * but never throws.
 */
export function readTasksByStatus(status: string, options: ReadTaskListOptions = {}): TaskRecord[] {
  return readTaskList(options).tasks.filter((t) => t.status === status);
}

/**
 * Summarize the task list into counts per status. Useful for
 * lead-mode's status heartbeat logging.
 */
export function summarizeTaskList(options: ReadTaskListOptions = {}): {
  total: number;
  by_status: Record<string, number>;
  path: string;
} {
  const result = readTaskList(options);
  const by_status: Record<string, number> = {};
  for (const task of result.tasks) {
    by_status[task.status] = (by_status[task.status] ?? 0) + 1;
  }
  return { by_status, path: result.path, total: result.tasks.length };
}
