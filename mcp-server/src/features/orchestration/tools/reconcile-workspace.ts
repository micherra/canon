/**
 * reconcileWorkspace — read-only cliff detection tool.
 *
 * Returns started/planned steps whose declared artifacts are either missing on
 * disk OR present but still a `## Status: Partial` / `IN_PROGRESS` skeleton.
 * Call on resume/turn-start to detect agents that stopped before producing (or
 * finishing) their artifacts. Does NOT mutate the journal, archive, or run
 * side-effects.
 *
 * Extracted from orchestration-journal.ts to keep that file under 600 lines.
 */

import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { JournalStep } from "./orchestration-journal.ts";
import {
  _journalPath as journalPath,
  readJournal,
  scanArtifactList,
} from "./orchestration-journal.ts";

export type ReconcileWorkspaceInput = { workspace: string };

export type IncompleteStep = {
  step_id: string;
  agent_type: string | null;
  status: "started" | "planned";
  started_at?: string;
  missing_artifacts: string[]; // from scanArtifactList(step.artifacts_expected)
  partial_artifacts: string[]; // present on disk but still a Partial/IN_PROGRESS skeleton
  transcript_path?: string; // step.transcript_path if already captured
};

export type ReconcileWorkspaceResult = {
  workspace: string;
  // started|planned with >=1 missing OR partial artifact
  incomplete_steps: IncompleteStep[];
  needs_recovery: boolean; // incomplete_steps.length > 0
};

/**
 * Skeleton markers written by single-artifact agents on step 1 (per
 * `rules/agent-artifact-write-before-return.md`). A present artifact still
 * carrying one of these is a recoverable cliff, not a finished deliverable:
 * - `## Status: Partial` — architect, security skeletons
 * - `IN_PROGRESS` verdict — reviewer Early Output Protocol stub (frontmatter
 *   `verdict: IN_PROGRESS` and `## Canon Review — Verdict: IN_PROGRESS`)
 */
const PARTIAL_MARKERS: readonly RegExp[] = [
  /^#{1,6}\s*Status:\s*Partial\b/im,
  /^verdict:\s*IN_PROGRESS\b/im,
  /Verdict:\s*IN_PROGRESS\b/i,
];

/** Resolve an artifact entry (plain path or glob) to concrete files, checking
 * both the workspace root and the worktree/ subdirectory (mirrors artifactExists). */
function resolveArtifactFiles(workspace: string, artifact: string): string[] {
  const files: string[] = [];
  for (const root of [workspace, join(workspace, "worktree")]) {
    for (const match of globSync(artifact, { cwd: root })) {
      files.push(join(root, match));
    }
  }
  return files;
}

/** True when any file the artifact resolves to still carries a skeleton marker. */
async function isPartialArtifact(workspace: string, artifact: string): Promise<boolean> {
  for (const file of resolveArtifactFiles(workspace, artifact)) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue; // unreadable → not classifiable as partial here; missing-scan owns absence
    }
    const head = content.slice(0, 8192); // markers live in frontmatter / first heading
    if (PARTIAL_MARKERS.some((re) => re.test(head))) return true;
  }
  return false;
}

/** Of the present (non-missing, non-template) artifacts, those still partial. */
async function scanPartialArtifacts(
  workspace: string,
  artifacts: readonly string[],
  missing: readonly string[],
): Promise<string[]> {
  const partial: string[] = [];
  for (const art of artifacts) {
    if (art.startsWith("outcome:")) continue;
    if (art.includes("${")) continue;
    if (missing.includes(art)) continue; // absence is reported via missing_artifacts
    if (await isPartialArtifact(workspace, art)) partial.push(art);
  }
  return partial;
}

/** Build an IncompleteStep entry from a journal step, or null if not incomplete. */
async function toIncompleteStep(
  workspace: string,
  step: JournalStep,
): Promise<IncompleteStep | null> {
  if (step.status !== "started" && step.status !== "planned") return null;
  const expected = step.artifacts_expected ?? [];
  const missing = scanArtifactList(workspace, expected);
  const partial = await scanPartialArtifacts(workspace, expected, missing);
  if (missing.length === 0 && partial.length === 0) return null;
  const incomplete: IncompleteStep = {
    agent_type: step.agent_type,
    missing_artifacts: missing,
    partial_artifacts: partial,
    status: step.status,
    step_id: step.step_id,
  };
  if (step.started_at) incomplete.started_at = step.started_at;
  if (step.transcript_path) incomplete.transcript_path = step.transcript_path;
  return incomplete;
}

/**
 * Read-only reconciliation: return started/planned steps whose declared
 * artifacts are missing on disk (cliff detection). Call on resume/turn-start
 * to detect agents that stopped before producing their artifacts.
 *
 * Does NOT mutate the journal, archive, or run side-effects.
 */
export async function reconcileWorkspace(
  input: ReconcileWorkspaceInput,
): Promise<ToolResult<ReconcileWorkspaceResult>> {
  const { workspace } = input;

  if (!workspace) {
    return toolError("INVALID_INPUT", "workspace must be a non-empty string", false);
  }

  if (!isAbsolute(workspace)) {
    return toolError("INVALID_INPUT", `workspace must be an absolute path; got: "${workspace}"`);
  }

  const path = journalPath(workspace);
  if (!existsSync(path)) {
    return toolError("WORKSPACE_NOT_FOUND", `No journal found at ${path}`, false, { workspace });
  }

  const { steps } = await readJournal(workspace);
  const incompleteSteps = (
    await Promise.all(steps.map((step) => toIncompleteStep(workspace, step)))
  ).filter((s): s is IncompleteStep => s !== null);

  return toolOk({
    incomplete_steps: incompleteSteps,
    needs_recovery: incompleteSteps.length > 0,
    workspace,
  });
}
