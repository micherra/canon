/**
 * Wave variable utilities for inter-wave communication.
 *
 * Exports:
 * - escapeDollarBrace: trust-boundary sanitizer for agent-sourced text
 * - parseTaskIdsForWave: parse task IDs for a given wave from INDEX.md content
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
