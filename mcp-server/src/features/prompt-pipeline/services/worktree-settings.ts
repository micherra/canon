/**
 * Worktree settings injection — pure file-writing utility.
 *
 * Writes `.claude/settings.local.json` into agent worktrees so that tools in
 * the agent's ADR-014 profile are auto-approved without prompting.
 *
 * Canon alignment:
 * - fail-closed-by-default: injectWorktreeSettings returns false on failure;
 *   the failure mode is "more prompts", not "blocked agent".
 * - least-privilege-access: only tools in the agent's specific ADR-014 profile
 *   are added as allow rules. No blanket wildcard permissions.
 *
 * This module has no imports from adapters — it is a pure file-writing utility
 * that uses node:fs/promises directly for async I/O.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of built-in Claude Code tools that can be granted via allow rules.
 * MCP tools are already covered by the project-level settings.json (mcp__canon__*)
 * and must be excluded to avoid duplication and confusion.
 */
const BUILTIN_CLAUDE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
]);

// ---------------------------------------------------------------------------
// profileToAllowRules
// ---------------------------------------------------------------------------

/**
 * Convert an array of tool names from ResolvedProfile.tools into Claude Code
 * permission allow rule strings.
 *
 * Only built-in Claude Code tools are included. MCP tools (graph_query,
 * semantic_search, write_plan_index, etc.) are excluded because they are
 * already covered by the project-level settings.json.
 *
 * @param tools - Array of tool names from ResolvedProfile.tools
 * @returns Array of Claude Code allow rule strings (e.g. ["Bash", "Edit", "Read"])
 */
export const profileToAllowRules = (tools: string[]): string[] => {
  return tools.filter((tool) => BUILTIN_CLAUDE_TOOLS.has(tool));
};

// ---------------------------------------------------------------------------
// buildWorktreeSettings
// ---------------------------------------------------------------------------

/**
 * Build the full settings.local.json structure from an array of allow rules.
 *
 * Returns { permissions: { allow: [] } } when allowRules is empty (fail-closed:
 * no extra permissions granted when profile has no built-in tools).
 *
 * @param allowRules - Array of Claude Code allow rule strings
 * @returns settings.local.json-compatible object
 */
export const buildWorktreeSettings = (
  allowRules: string[],
): { permissions: { allow: string[] } } => {
  return {
    permissions: {
      allow: allowRules,
    },
  };
};

// ---------------------------------------------------------------------------
// injectWorktreeSettings
// ---------------------------------------------------------------------------

/**
 * Write .claude/settings.local.json into a worktree directory.
 *
 * Creates the .claude/ directory if it doesn't exist, then atomically writes
 * the settings file (write to temp, rename) to avoid partial writes.
 *
 * Returns true on success, false on failure. Never throws — failure mode is
 * "agent gets standard prompting" not "agent is blocked".
 *
 * @param worktreePath - Absolute path to the worktree directory (trusted Canon path)
 * @param tools - Array of tool names from ResolvedProfile.tools
 * @returns Promise<true> on success, Promise<false> on any error
 */
export const injectWorktreeSettings = async (
  worktreePath: string,
  tools: string[],
): Promise<boolean> => {
  // Validate: path must be non-empty and absolute (path traversal guard)
  if (!worktreePath || !isAbsolute(worktreePath)) {
    console.warn(
      `[worktree-settings] injectWorktreeSettings: invalid worktreePath "${worktreePath}" — must be non-empty absolute path`,
    );
    return false;
  }

  try {
    const claudeDir = join(worktreePath, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");
    const tempPath = join(claudeDir, "settings.local.json.tmp");

    // Create .claude/ directory (idempotent)
    await mkdir(claudeDir, { recursive: true });

    // Build settings content
    const allowRules = profileToAllowRules(tools);
    const settings = buildWorktreeSettings(allowRules);
    const content = JSON.stringify(settings, null, 2);

    // Atomic write: write to temp, then rename to final path
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, settingsPath);

    return true;
  } catch (err) {
    console.warn(
      `[worktree-settings] injectWorktreeSettings failed for "${worktreePath}":`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
};
