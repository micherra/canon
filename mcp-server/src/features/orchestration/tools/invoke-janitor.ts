/**
 * invoke_janitor tool handler — thin wrapper over runJanitor service.
 *
 * Always returns toolOk — janitor never produces a toolError.
 * Gate failures and task errors are reported inside the JanitorResult.
 *
 * Canon principles:
 *   - toolresult-contract: returns ToolResult<{ janitor: JanitorResult }>, never throws
 *   - no-silent-failures: all outcomes reported in JanitorResult.tasks
 */

import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { type JanitorResult, runJanitor } from "../services/janitor.ts";

/**
 * Run the Canon janitor.
 *
 * @param input.project_dir - Project root (falls back to CANON_PROJECT_DIR env, then cwd)
 * @returns ToolResult wrapping the JanitorResult (always ok: true)
 */
export async function invokeJanitor(
  input: { project_dir?: string },
): Promise<ToolResult<{ janitor: JanitorResult }>> {
  const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
  const result = await runJanitor(projectDir);
  return toolOk({ janitor: result });
}
