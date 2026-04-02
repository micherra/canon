/**
 * get-spawn-prompt — thin wrapper around the prompt assembly pipeline.
 *
 * Delegates all prompt assembly to assemblePrompt. Keeps truncateProgress
 * and parseTimeout as local exports (utility functions used externally).
 * Re-exports canonical types from the pipeline module for backward compat.
 *
 * Canon: deep-modules — single-line delegation; all complexity lives in
 * the pipeline stages.
 * Canon: functions-do-one-thing — getSpawnPrompt does one thing: delegate.
 */

import { assemblePrompt } from "./prompt-pipeline/assemble-prompt.ts";
import type { SpawnPromptInput } from "./prompt-pipeline/types.ts";

// Re-export canonical types so existing callers need no import changes.
export type { SpawnPromptEntry, TaskItem, SpawnPromptResult } from "./prompt-pipeline/types.ts";

export { assemblePrompt };

export async function getSpawnPrompt(
  input: SpawnPromptInput,
): ReturnType<typeof assemblePrompt> {
  return assemblePrompt(input);
}

/**
 * Truncate progress.md content to at most maxEntries entry lines.
 * Header lines (lines before the first "- [" entry) are always preserved.
 * If entry count is within the cap, content is returned unchanged.
 */
export function truncateProgress(content: string, maxEntries: number): string {
  const lines = content.split("\n");

  // Find the index of the first entry line (starts with "- [")
  const firstEntryIndex = lines.findIndex((l) => l.startsWith("- ["));
  if (firstEntryIndex === -1) {
    // No entries found — return content unchanged
    return content;
  }

  const headerLines = lines.slice(0, firstEntryIndex);
  const entryAndTrailing = lines.slice(firstEntryIndex);

  // Separate actual entry lines from any trailing non-entry lines
  const entryLines = entryAndTrailing.filter((l) => l.startsWith("- ["));
  const trailingLines = entryAndTrailing.filter((l) => !l.startsWith("- ["));

  if (entryLines.length <= maxEntries) {
    return content;
  }

  if (maxEntries <= 0) {
    return [...headerLines, ...trailingLines].join("\n");
  }

  const keptEntries = entryLines.slice(-maxEntries);
  return [...headerLines, ...keptEntries, ...trailingLines].join("\n");
}

/**
 * Parse a human-readable timeout string into milliseconds.
 * Supports: "30s", "10m", "1h", "1h30m".
 */
export function parseTimeout(timeout: string): number | undefined {
  let totalMs = 0;
  let matched = false;
  const remaining = timeout.replace(/(\d+)\s*(h|m|s)/gi, (_, num, unit) => {
    matched = true;
    const n = parseInt(num, 10);
    switch (unit.toLowerCase()) {
      case "h": totalMs += n * 3600000; break;
      case "m": totalMs += n * 60000; break;
      case "s": totalMs += n * 1000; break;
    }
    return "";
  });
  if (!matched || remaining.trim()) return undefined;
  return totalMs;
}
