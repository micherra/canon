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
 * fixed filename, `join(project_dir, ".canon", "learning.jsonl")` — but
 * `project_dir` itself is caller-supplied and is NOT a fixed path, so the
 * security property is "one file per *scope-bound* project dir," not "a
 * fixed path": `project_dir` is validated by `isSafeProjectDirInput`
 * (ADR-0030 allow-list, not containment) AND additionally contained within
 * the caller's resolved session scope via `isPathInWorktree` before any fs
 * access — mirrors `sync_indexes` (`register-knowledge.ts` /
 * `sync-indexes.ts`). Accepting an unbound caller-supplied path would turn
 * a narrow, single-file append seam into a general arbitrary-directory-write
 * primitive callable by any agent granted this tool — a far larger surface
 * than the bug being fixed, and one reachable by overlay-influenced content
 * (`agent-never-trust-overlay-tier`). The narrow contract IS the security
 * property; do not add a path parameter for flexibility, and do not drop
 * the scope-containment check (see ADR-0056).
 */

import { join } from "node:path";
import { appendJsonlLine } from "@shared/lib/jsonl-append.ts";
import { isSafeProjectDirInput } from "@shared/lib/safe-project-dir.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { isPathInWorktree } from "@shared/lib/worktree-guard.ts";

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
 * `reconcile-learnings.ts`'s barrier placement exactly), THEN contains it
 * within `defaultProjectDir` — the caller's authoritative resolved session
 * scope (`resolveScope(extra)` at the registration seam) — fail-closed
 * `INVALID_INPUT` with zero writes on an out-of-scope `project_dir`. The
 * allow-list barrier alone is not containment (see module docblock); this
 * second check is what actually confines the write.
 *
 * The serialization check (a record that cannot form a single JSONL line)
 * runs BEFORE any I/O and is the only INPUT-caused failure; failures from
 * `appendJsonlLine`'s own I/O (`open`/`stat`/`read`/`appendFile` — e.g.
 * ENOSPC/EACCES/EIO/EMFILE) are not the agent's fault and are mapped to
 * `UNEXPECTED`/`recoverable: true` instead of `INVALID_INPUT`, matching the
 * sibling `reconcileLearnings` catch-all (`reconcile-learnings.ts`'s
 * fail-open `catch` block).
 */
export async function appendLearningRecord(
  input: AppendLearningRecordInput,
  defaultProjectDir: string,
): Promise<ToolResult<AppendLearningRecordOutput>> {
  if (!isSafeProjectDirInput(input.project_dir)) {
    return toolError("INVALID_INPUT", `Invalid project_dir: ${input.project_dir}`, false);
  }

  const contained = await isPathInWorktree(input.project_dir, defaultProjectDir);
  if (!contained.ok) {
    return toolError(
      "INVALID_INPUT",
      `append_learning_record: project_dir "${input.project_dir}" is outside the resolved project scope "${defaultProjectDir}"`,
      false,
    );
  }

  const path = join(input.project_dir, ".canon", "learning.jsonl");

  const line = JSON.stringify(input.record);
  if (line.includes("\n")) {
    return toolError(
      "INVALID_INPUT",
      "append_learning_record failed: serialized record contains a raw newline — a JSONL record must be single-line",
      false,
    );
  }

  try {
    const { healed } = await appendJsonlLine(path, input.record);
    return toolOk<AppendLearningRecordOutput>({ appended: true, healed, path });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[append-learning-record] append failed — ${detail}`);
    return toolError("UNEXPECTED", `append_learning_record failed: ${detail}`, true);
  }
}
