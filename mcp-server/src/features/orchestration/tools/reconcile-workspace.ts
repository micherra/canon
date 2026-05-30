/**
 * reconcileWorkspace — read-only cliff detection tool.
 *
 * Returns started/planned steps whose declared artifacts are missing on disk.
 * Call on resume/turn-start to detect agents that stopped before producing
 * their artifacts. Does NOT mutate the journal, archive, or run side-effects.
 *
 * Extracted from orchestration-journal.ts to keep that file under 600 lines.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
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
  transcript_path?: string; // step.transcript_path if already captured
};

export type ReconcileWorkspaceResult = {
  workspace: string;
  incomplete_steps: IncompleteStep[]; // started|planned with >=1 missing artifact
  needs_recovery: boolean; // incomplete_steps.length > 0
};

/** Build an IncompleteStep entry from a journal step, or null if not incomplete. */
function toIncompleteStep(workspace: string, step: JournalStep): IncompleteStep | null {
  if (step.status !== "started" && step.status !== "planned") return null;
  const missing = scanArtifactList(workspace, step.artifacts_expected ?? []);
  if (missing.length === 0) return null;
  const incomplete: IncompleteStep = {
    agent_type: step.agent_type,
    missing_artifacts: missing,
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
  const incompleteSteps = steps
    .map((step) => toIncompleteStep(workspace, step))
    .filter((s): s is IncompleteStep => s !== null);

  return toolOk({
    incomplete_steps: incompleteSteps,
    needs_recovery: incompleteSteps.length > 0,
    workspace,
  });
}
