/**
 * invoke_janitor tool handler — thin wrapper over runJanitor service.
 *
 * Gate failures and task errors are reported inside the JanitorResult.
 * Unexpected throws propagate to wrapHandler, which returns UNEXPECTED CanonToolError.
 */

import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { type JanitorResult, runJanitor } from "../services/janitor.ts";

/**
 * Run the Canon janitor.
 *
 * @param input.project_dir - Explicit project root override (caller-supplied)
 * @param scope             - Resolved project scope from resolveScope(extra) — no cwd reads
 * @returns ToolResult wrapping the JanitorResult (always ok: true)
 */
export async function invokeJanitor(
  input: { project_dir?: string },
  scope: string,
): Promise<ToolResult<{ janitor: JanitorResult }>> {
  const projectDir = input.project_dir || scope;
  const result = await runJanitor(projectDir);
  return toolOk({ janitor: result });
}
