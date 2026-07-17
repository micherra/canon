/**
 * `append_learning_record` MCP tool — the sanctioned agent-facing seam for
 * appending to `.canon/learning.jsonl` (ADR-0058).
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
 * (`agent-never-trust-overlay-tier`). Do not add a path parameter for
 * flexibility, and do not drop the scope-containment check (see ADR-0058).
 *
 * `project_dir` containment alone is NOT sufficient: a genuine, in-scope
 * `project_dir` can still have a `project_dir/.canon` that is itself a
 * symlink resolving out of scope — the exact write target this tool joins
 * onto (round-3 adversarial finding, ADR-0058 amendment). The write target
 * (`.canon/learning.jsonl`) is re-contained via
 * `isPathContainedResolvingAncestor` — the SAME primitive `reconcileLearnings`
 * uses for its own `.canon`-subpath check — which tolerates a not-yet-created
 * target (this tool creates `.canon/` on a legitimate first run) while still
 * rejecting a `.canon` that resolves outside the caller's scope. Because
 * `learning.jsonl` sits directly under `.canon`, this check runs on the
 * resolved path of the actual write target, not merely an ancestor of it —
 * confirmed by control fixture: a *pre-existing* symlink at
 * `.canon/learning.jsonl` pointing at an already-existing out-of-scope file
 * IS correctly rejected (`realpath` follows it to the real target, which
 * fails containment).
 *
 * NOT re-contained (documented, accepted residual — ADR-0058 "Amendment:
 * fix-review round 4"): a *dangling* symlink at `.canon/learning.jsonl` —
 * the symlink object exists, but its target path does not exist yet —
 * bypasses this check. `isPathContainedResolvingAncestor`'s ancestor-walk
 * cannot distinguish "nothing here at all" (the legitimate not-yet-created
 * first-run case) from "a symlink exists here but its target hasn't been
 * created yet"; both make `realpath` throw, so both fall back to the
 * nearest existing ancestor (`.canon`, real and in-scope) and pass.
 * `appendJsonlLine`'s subsequent `open`/`appendFile` then follows the
 * symlink and CREATES the attacker-chosen file at the dangling target with
 * the caller's record — confirmed live against a control fixture. This
 * grants no capability beyond the `Bash` grant this tool's callers already
 * hold. See ADR-0058 "Amendment: fix-review round 4" for the full writeup
 * and the deferred root-cause follow-up (a leaf `lstat` in the shared
 * primitive to detect a symlink object before falling through to the
 * ancestor-walk fallback).
 */

import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonlLine } from "@shared/lib/jsonl-append.ts";
import { isSafeProjectDirInput } from "@shared/lib/safe-project-dir.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { isPathContainedResolvingAncestor, isPathInWorktree } from "@shared/lib/worktree-guard.ts";

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
 * second check is what actually confines `project_dir`, but NOT the
 * `.canon` subpath joined onto it — a THIRD check, via
 * `isPathContainedResolvingAncestor`, re-contains the actual write target
 * (`project_dir/.canon/learning.jsonl`) against `defaultProjectDir`. That
 * check tolerates the target (or `.canon` itself) not existing yet — this
 * function creates `.canon/` on a legitimate first run — while still
 * rejecting a `.canon` that resolves out of scope via a symlink, or a
 * pre-existing `learning.jsonl` symlink resolving to an already-existing
 * out-of-scope file. It does NOT reject a *dangling* `learning.jsonl`
 * symlink (target not yet existing) — see module docblock and ADR-0058
 * "Amendment: fix-review round 4" for the confirmed, accepted residual.
 *
 * The newline check (a record that serializes but cannot form a single
 * JSONL line) runs BEFORE any I/O and is the only checked,
 * mapped-to-`INVALID_INPUT` failure. `JSON.stringify` itself is NOT
 * wrapped in a try: a value that cannot be serialized at all (a circular
 * reference or a `BigInt`) throws uncaught out of this function and is
 * caught upstream by `gatedWrapHandler` as `UNEXPECTED`, not
 * `INVALID_INPUT` — unreachable in practice for a real MCP caller, whose
 * `record` already round-tripped through the transport's `JSON.parse` and
 * so cannot contain a circular reference or a `BigInt`, but true for any
 * direct in-process TS caller. Failures from `appendJsonlLine`'s own I/O
 * (`open`/`stat`/`read`/`appendFile` — e.g. ENOSPC/EACCES/EIO/EMFILE) are
 * not the agent's fault and are mapped to `UNEXPECTED`/`recoverable: true`
 * instead of `INVALID_INPUT`, matching the sibling `reconcileLearnings`
 * catch-all (`reconcile-learnings.ts`'s fail-open `catch` block).
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

  // project_dir containment alone does not stop project_dir/.canon itself
  // being a symlink escape one level down (round-3 finding) — re-contain
  // the actual write target. Tolerates .canon/learning.jsonl not existing
  // yet (this function creates .canon/ below on a legitimate first run).
  if (!(await isPathContainedResolvingAncestor(defaultProjectDir, path, realpath))) {
    return toolError(
      "INVALID_INPUT",
      `append_learning_record: ".canon" under project_dir "${input.project_dir}" escapes the resolved project scope "${defaultProjectDir}"`,
      false,
    );
  }

  const line = JSON.stringify(input.record);
  if (line.includes("\n")) {
    return toolError(
      "INVALID_INPUT",
      "append_learning_record failed: serialized record contains a raw newline — a JSONL record must be single-line",
      false,
    );
  }

  try {
    await mkdir(join(input.project_dir, ".canon"), { recursive: true });
    const { healed } = await appendJsonlLine(path, input.record);
    return toolOk<AppendLearningRecordOutput>({ appended: true, healed, path });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[append-learning-record] append failed — ${detail}`);
    return toolError("UNEXPECTED", `append_learning_record failed: ${detail}`, true);
  }
}
