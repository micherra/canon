/**
 * `append_learning_record` MCP tool — the sanctioned agent-facing seam for
 * appending to `.canon/learning.jsonl` (ADR-0056).
 *
 * Why a whole tool for one line to one file: the writer of learning.jsonl
 * is an AGENT executing freeform Bash against prose instructions, not code
 * (PROBE-FINDINGS.md P2 Finding C) — prose cannot bind an agent's shell
 * idiom, and one improvised append without a trailing newline corrupted the
 * corpus (P1). This tool removes the failure mode from the agent's reach
 * entirely: the agent hands over a structured `record` object and the TOOL
 * serializes and newline-terminates it via `appendJsonlLine`
 * (`@shared/lib/jsonl-append.ts`) — there is no byte-level control left in
 * the agent's hands to get wrong.
 *
 * There is deliberately NO target-path parameter. The tool writes to a
 * fixed `join(project_dir, ".canon", "learning.jsonl")`. Accepting a
 * caller-supplied path would turn a narrow, single-file append seam into a
 * general arbitrary-file-append primitive callable by any agent granted
 * this tool — a far larger surface than the bug being fixed, and one
 * reachable by overlay-influenced content (`agent-never-trust-overlay-tier`).
 * The narrow contract IS the security property; do not add a path
 * parameter for flexibility (see ADR-0056).
 */

import { join } from "node:path";
import { appendJsonlLine } from "@shared/lib/jsonl-append.ts";
import { isSafeProjectDirInput } from "@shared/lib/safe-project-dir.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

export type AppendLearningRecordInput = {
  project_dir: string;
  record: Record<string, unknown>;
};

export type AppendLearningRecordOutput = {
  appended: true;
  path: string;
  healed: boolean;
};

/**
 * Appends `record` as one JSONL line to `{project_dir}/.canon/learning.jsonl`.
 *
 * Validates `project_dir` at this seam before any filesystem access
 * (`validate-at-trust-boundaries`, ADR-0030 pattern — copies
 * `reconcile-learnings.ts`'s barrier placement exactly). A record that
 * cannot serialize as a single JSONL line (rejected by `appendJsonlLine`)
 * is mapped to `INVALID_INPUT`, never allowed to throw past this handler.
 */
export async function appendLearningRecord(
  input: AppendLearningRecordInput,
): Promise<ToolResult<AppendLearningRecordOutput>> {
  if (!isSafeProjectDirInput(input.project_dir)) {
    return toolError("INVALID_INPUT", `Invalid project_dir: ${input.project_dir}`, false);
  }

  const path = join(input.project_dir, ".canon", "learning.jsonl");

  try {
    const { healed } = await appendJsonlLine(path, input.record);
    return toolOk<AppendLearningRecordOutput>({ appended: true, healed, path });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return toolError("INVALID_INPUT", `append_learning_record failed: ${detail}`, false);
  }
}
