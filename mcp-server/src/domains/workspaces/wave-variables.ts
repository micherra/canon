/**
 * Wave variable utilities for inter-wave communication.
 *
 * Exports:
 * - escapeDollarBrace: trust-boundary sanitizer for agent-sourced text
 * - parseTaskIdsForWave: parse task IDs for a given wave from INDEX.md content
 * - extractFilePaths: extract file paths from summary/artifact text
 *
 * Note: resolveWaveVariables was removed — wave summaries now flow through
 * inject_context events rather than being read and injected here.
 */

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
 * Parse task IDs for a specific wave from INDEX.md content.
 * Expects rows like: | iwc-01 | 1 | ...
 * Also handles backtick-wrapped IDs: | `iwc-01` | 1 | ...
 *
 * Callers should validate that the returned array is non-empty when tasks
 * are expected — this function returns [] on parse failure without warning.
 */
export function parseTaskIdsForWave(indexContent: string, wave: number): string[] {
  const taskIds: string[] = [];
  const lines = indexContent.split("\n");

  for (const line of lines) {
    // Match table rows with optional backtick-wrapped IDs:
    // | task-id | wave-number | ...  OR  | `task-id` | wave-number | ...
    const match = line.match(/^\|\s*`?([a-zA-Z0-9_-]+)`?\s*\|\s*(\d+)\s*\|/);
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
 * Extract file paths from summary content.
 * Looks for backtick-quoted paths and lines that look like file paths.
 */
export function extractFilePaths(content: string): string[] {
  const paths = new Set<string>();

  // Match backtick-quoted paths: `src/foo/bar.ts`
  const backtickPattern = /`([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})`/g;
  let m = backtickPattern.exec(content);
  while (m !== null) {
    const candidate = m[1];
    if (looksLikeFilePath(candidate)) {
      paths.add(candidate);
    }
    m = backtickPattern.exec(content);
  }

  // Match lines that start with a path-like token (e.g., in "| `path` | created |" table rows)
  const linePattern = /\|\s*`?([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})`?\s*\|/g;
  let m2 = linePattern.exec(content);
  while (m2 !== null) {
    const candidate = m2[1].trim();
    if (looksLikeFilePath(candidate)) {
      paths.add(candidate);
    }
    m2 = linePattern.exec(content);
  }

  return Array.from(paths);
}

function looksLikeFilePath(s: string): boolean {
  // Must contain a slash or look like a relative path with an extension
  return (s.includes("/") || s.includes("\\")) && s.includes(".");
}
