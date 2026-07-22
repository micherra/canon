/**
 * orchestration-journal — MCP tools for the agent-teams orchestration journal.
 *
 * Two tools:
 *   - log_step: record a step's status (planned/started/completed/skipped)
 *     and associated metadata (agent, expected artifacts, domain skills
 *     loaded, outcome signals).
 *   - finalize_workspace: read the journal back and report which steps are
 *     incomplete, which expected artifacts are missing, aggregate
 *     quality signals, release file claims, record analytics, and archive.
 *
 * Both tools are registered unconditionally in register-orchestration.ts;
 * the handlers are pure and safe to call regardless of environment.
 *
 * Concurrency contract (single-writer invariant):
 *   logStep() does a read-modify-write on {workspace}/journal.json. The
 *   final write is atomic (write-to-temp + rename), but the read-modify-
 *   write sequence is NOT locked. Callers must guarantee that a given
 *   workspace has a single serial writer at any moment — today that is
 *   the lead's sequential spawn loop. Parallel-per wave tasks that call
 *   logStep directly on the same workspace will race and silently drop
 *   entries. Harden with a file lock or append-only JSONL when v2.1b
 *   introduces intra-task concurrency; see docs/agent-teams-migration-
 *   plan-v2.md §2.9 for the contract and dependency.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { scanArtifactList, scanArtifacts } from "../services/artifact-matching.ts";
import { backfillContextProvenanceAgentId } from "../services/context-provenance-backfill.ts";
import {
  computeFlowOutcome,
  computeGateNonEvaluations,
  computeT2NonFiring,
  getStepsMissingSkipReason,
} from "../services/finalize-helpers.ts";
import { tryTranscriptCapture } from "../services/transcript-capture-hook.ts";
import { archiveWorkspaceOnly, runCompletionSideEffects } from "../services/workspace-cleanup.ts";
import { releaseLock } from "../services/workspace-lock.ts";
import { enforceWriteReceipt } from "../services/write-receipt.ts";

// Pure type declarations live in journal-types.ts (line-limit-split-into-siblings
// convention) — re-exported here so existing importers are unaffected.
export type {
  FinalizeWorkspaceInput,
  FinalizeWorkspaceResult,
  Journal,
  JournalOutcome,
  JournalStep,
  JournalStepStatus,
  LogStepInput,
  LogStepResult,
} from "./journal-types.ts";

import type {
  FinalizeWorkspaceInput,
  FinalizeWorkspaceResult,
  Journal,
  JournalOutcome,
  JournalStep,
  JournalStepStatus,
  LogStepInput,
  LogStepResult,
} from "./journal-types.ts";

function journalPath(workspace: string): string {
  return join(workspace, "journal.json");
}

const VALID_STEP_STATUSES: ReadonlySet<string> = new Set<JournalStepStatus>([
  "planned",
  "started",
  "completed",
  "skipped",
]);

/**
 * Validates that a value has the minimum shape of a JournalStep.
 * Elements are written by this process but journal.json can be corrupted
 * or hand-edited. Validates all required fields and the status union values;
 * any element that fails this check is silently dropped.
 */
function isWellFormedStep(value: unknown): value is JournalStep {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.step_id === "string" &&
    typeof v.status === "string" &&
    VALID_STEP_STATUSES.has(v.status) &&
    Array.isArray(v.artifacts_expected) &&
    (v.agent_type === null || typeof v.agent_type === "string")
  );
}

async function readJournal(workspace: string): Promise<Journal> {
  const path = journalPath(workspace);
  if (!existsSync(path)) {
    return { steps: [], version: 1, workspace };
  }
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      "[canon] orchestration-journal: journal.json is syntactically invalid (truncated or hand-edited) — resetting to empty:",
      err instanceof Error ? err.message : err,
    );
    return { steps: [], version: 1, workspace };
  }
  // Validate at file I/O boundary: journal.json is written by this process but
  // could be corrupted or hand-edited. Normalise to a safe default shape.
  if (typeof parsed !== "object" || parsed === null) {
    return { steps: [], version: 1, workspace };
  }
  const obj = parsed as Record<string, unknown>;
  // Filter to well-formed step objects only — corrupted entries (null, missing fields)
  // would throw later in finalizeWorkspace/scanArtifacts.
  const steps = Array.isArray(obj.steps) ? obj.steps.filter(isWellFormedStep) : [];
  // Preserve session_id from the parsed file — the durable identity carrier the
  // stop-hook tail-enforcement gate matches a Stop event's session_id against
  // (see the Journal type doc). Malformed/non-string values are dropped (never
  // propagate a corrupt session_id downstream).
  const session_id = typeof obj.session_id === "string" ? obj.session_id : undefined;
  return { session_id, steps, version: 1, workspace };
}

async function writeJournal(workspace: string, journal: Journal): Promise<void> {
  await atomicWriteFile(journalPath(workspace), `${JSON.stringify(journal, null, 2)}\n`);
}

function upsertStep(journal: Journal, input: LogStepInput): JournalStep {
  const existing = journal.steps.find((s) => s.step_id === input.step_id);
  if (existing) {
    existing.status = input.status;
    if (input.agent_type !== undefined) existing.agent_type = input.agent_type;
    if (input.artifacts_expected !== undefined) {
      existing.artifacts_expected = input.artifacts_expected;
    }
    return existing;
  }
  const created: JournalStep = {
    agent_type: input.agent_type ?? null,
    artifacts_expected: input.artifacts_expected ?? [],
    status: input.status,
    step_id: input.step_id,
  };
  journal.steps.push(created);
  return created;
}

function applyTimestamps(step: JournalStep, status: JournalStepStatus): void {
  const now = new Date().toISOString();
  if (status === "started" && !step.started_at) {
    step.started_at = now;
  }
  if (status === "completed") {
    if (!step.started_at) step.started_at = now;
    step.completed_at = now;
  }
}

function applyMetadata(step: JournalStep, input: LogStepInput): void {
  if (input.domain_skills_loaded !== undefined) {
    step.domain_skills_loaded = input.domain_skills_loaded;
  }
  if (input.outcome !== undefined) step.outcome = input.outcome;
  if (input.skip_reason !== undefined) step.skip_reason = input.skip_reason;
  // Clear skip_reason when transitioning to a non-skipped terminal state.
  // Prevents stale skip_reason from persisting if the orchestrator later completes a step.
  if (input.status === "completed") {
    step.skip_reason = undefined;
  }
}

function enforceArtifacts(
  workspace: string,
  stepId: string,
  journal: Journal,
  inputArtifacts: string[] | undefined,
): ToolResult<null> | null {
  const existingStep = journal.steps.find((s) => s.step_id === stepId);
  const artifacts = inputArtifacts ?? existingStep?.artifacts_expected ?? [];
  const missing = scanArtifactList(workspace, artifacts);
  if (missing.length > 0) {
    return toolError(
      "INVALID_INPUT",
      `Cannot complete step '${stepId}': missing artifacts: ${missing.join(", ")}`,
      true,
      { artifacts_missing: missing },
    );
  }
  return null;
}

/**
 * Build the JournalStep shape `enforceWriteReceipt` needs (agent_type,
 * started_at, step_id) from the step's PRE-upsert journal entry plus this
 * call's input — mirrors `enforceArtifacts`'s `inputArtifacts ?? existingStep`
 * fallback pattern so an agent_type passed again at completion wins over the
 * one recorded at "started".
 */
function resolveStepForReceiptGate(
  journal: Journal,
  stepId: string,
  inputAgentType: string | null | undefined,
): JournalStep {
  const existingStep = journal.steps.find((s) => s.step_id === stepId);
  if (existingStep) {
    return { ...existingStep, agent_type: inputAgentType ?? existingStep.agent_type };
  }
  return {
    agent_type: inputAgentType ?? null,
    artifacts_expected: [],
    status: "completed",
    step_id: stepId,
  };
}

export type BatchLogStepsInput = {
  workspace: string;
  /** Project directory — threaded from resolveScope(extra) in register-journal.ts. */
  projectDir: string;
  steps: Array<{
    step_id: string;
    status: JournalStepStatus;
    agent_type?: string | null;
    artifacts_expected?: string[];
    domain_skills_loaded?: string[];
    outcome?: JournalOutcome;
    skip_reason?: string;
    agent_id?: string;
  }>;
};

export type BatchLogStepsResult = {
  results: LogStepResult[];
};

type CaptureTask = { logInput: LogStepInput; result: LogStepResult; step: JournalStep };
type BackfillTask = { agentId: string; stepId: string; workspace: string };

function processEntries(
  journal: Journal,
  input: BatchLogStepsInput,
): {
  results: LogStepResult[];
  captureTasks: CaptureTask[];
  backfillTasks: BackfillTask[];
  rejection?: ToolResult<null>;
} {
  const results: LogStepResult[] = [];
  const captureTasks: CaptureTask[] = [];
  const backfillTasks: BackfillTask[] = [];

  for (const entry of input.steps) {
    const logInput: LogStepInput = {
      agent_id: entry.agent_id,
      agent_type: entry.agent_type,
      artifacts_expected: entry.artifacts_expected,
      domain_skills_loaded: entry.domain_skills_loaded,
      outcome: entry.outcome,
      projectDir: input.projectDir,
      skip_reason: entry.skip_reason,
      status: entry.status,
      step_id: entry.step_id,
      workspace: input.workspace,
    };

    if (entry.status === "completed") {
      // Return immediately on rejection — no back-fill tasks accumulated yet for this
      // entry, so the partial backfillTasks list does NOT contain a stale event for
      // this rejected entry. Callers must check `rejection` before firing back-fills.
      const rejection = enforceCompletionGates(journal, logInput);
      if (rejection) return { backfillTasks, captureTasks, rejection, results };
    }

    const step = upsertStep(journal, logInput);
    applyTimestamps(step, entry.status);
    applyMetadata(step, logInput);

    const result: LogStepResult = { status: entry.status, step_id: entry.step_id };

    if (entry.status === "completed" && entry.agent_id) {
      captureTasks.push({ logInput, result, step });
      // Defer the back-fill write until AFTER the journal write succeeds.
      // Writing the event here (before the journal write) would leave a stale
      // context_provenance_agent_id in the execution store if a later entry causes
      // batchLogSteps to reject the entire batch. (Codex P2 fix 2026-06-24)
      backfillTasks.push({
        agentId: entry.agent_id,
        stepId: entry.step_id,
        workspace: input.workspace,
      });
    }

    results.push(result);
  }

  return { backfillTasks, captureTasks, results };
}

/**
 * Batch version of logStep — logs all entries in a single read-modify-write
 * cycle. Validates all entries upfront (fail-closed). If any entry has an
 * empty step_id the entire batch is rejected and nothing is written.
 */
export async function batchLogSteps(
  input: BatchLogStepsInput,
): Promise<ToolResult<BatchLogStepsResult>> {
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }

  // 1. Empty array fast-path — no I/O needed.
  if (input.steps.length === 0) {
    return toolOk({ results: [] });
  }

  // 2. Validate all entries upfront (fail-closed).
  for (const entry of input.steps) {
    if (!entry.step_id?.trim()) {
      return toolError("INVALID_INPUT", "Each step entry must have a non-empty step_id", false);
    }
    if (entry.status === "skipped" && !entry.skip_reason?.trim()) {
      return toolError("INVALID_INPUT", "skip_reason is required when status is 'skipped'", false);
    }
  }

  // 3. Single journal read.
  const journal = await readJournal(input.workspace);

  const { backfillTasks, captureTasks, results, rejection } = processEntries(journal, input);
  // Rejection: batch aborted, journal NOT written — back-fills must NOT fire.
  if (rejection) return rejection;

  // 5. Single journal write (before transcript capture — captures are best-effort).
  await writeJournal(input.workspace, journal);

  // 5a. Fire context-provenance back-fills AFTER the journal write so a rejected batch
  //     never leaves stale context_provenance_agent_id events in the execution store.
  for (const { agentId, stepId, workspace } of backfillTasks) {
    backfillContextProvenanceAgentId(workspace, stepId, agentId);
  }

  // 6. Run transcript captures in parallel (no await inside a loop).
  await Promise.all(
    captureTasks.map(({ logInput, result, step }) =>
      tryTranscriptCapture(step, result, logInput, journal.session_id),
    ),
  );

  // 7. If any captures added a transcript_path, persist those fields to the journal.
  const hasCaptures = captureTasks.some(({ step }) => step.transcript_path);
  if (hasCaptures) {
    await writeJournal(input.workspace, journal);
  }

  return toolOk({ results });
}

async function runStepCompletionSideEffects(
  step: JournalStep,
  result: LogStepResult,
  input: LogStepInput,
  sessionId?: string,
): Promise<void> {
  await tryTranscriptCapture(step, result, input, sessionId);
  if (input.agent_id) {
    backfillContextProvenanceAgentId(input.workspace, input.step_id, input.agent_id);
  }
}

/** Cheap, non-I/O input validation for logStep — extracted to keep logStep's own complexity bounded. */
function validateLogStepInput(input: LogStepInput): ToolResult<never> | null {
  if (!input.step_id?.trim()) {
    return toolError("INVALID_INPUT", "step_id must be a non-empty string", false);
  }
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }
  if (!input.workspace || !existsSync(input.workspace)) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace does not exist: ${input.workspace}`, false, {
      workspace: input.workspace,
    });
  }
  if (input.status === "skipped" && !input.skip_reason?.trim()) {
    return toolError("INVALID_INPUT", "skip_reason is required when status is 'skipped'", false);
  }
  if (input.status === "completed" && !input.agent_id && input.step_id !== "inline-fix") {
    return toolError(
      "INVALID_INPUT",
      "completed steps must include agent_id for transcript capture (exempt: inline-fix step_id, skipped status)",
      false,
    );
  }
  return null;
}

/** Both completion gates (artifacts, then write-receipt) for a single logStep call. */
function enforceCompletionGates(journal: Journal, input: LogStepInput): ToolResult<null> | null {
  const rejection = enforceArtifacts(
    input.workspace,
    input.step_id,
    journal,
    input.artifacts_expected,
  );
  if (rejection) return rejection;

  return enforceWriteReceipt(
    input.workspace,
    resolveStepForReceiptGate(journal, input.step_id, input.agent_type),
  );
}

export async function logStep(input: LogStepInput): Promise<ToolResult<LogStepResult>> {
  const validationError = validateLogStepInput(input);
  if (validationError) return validationError;

  const journal = await readJournal(input.workspace);

  if (input.status === "completed") {
    const rejection = enforceCompletionGates(journal, input);
    if (rejection) return rejection;
  }

  const step = upsertStep(journal, input);
  applyTimestamps(step, input.status);
  applyMetadata(step, input);

  const result: LogStepResult = { status: input.status, step_id: input.step_id };

  if (input.status === "completed") {
    await runStepCompletionSideEffects(step, result, input, journal.session_id);
  }

  await writeJournal(input.workspace, journal);

  return toolOk(result);
}

// Best-effort side effects on workspace completion: digest, analytics, trend summary, claims.
async function analyzeJournalSteps(workspace: string, steps: JournalStep[], projectDir: string) {
  const completed = steps.filter((s) => s.status === "completed");
  const skipped = steps.filter((s) => s.status === "skipped");
  const stepsMissing = steps
    .filter((s) => s.status === "planned" || s.status === "started")
    .map((s) => ({ status: s.status, step_id: s.step_id }));
  const stepsSkipped = skipped.map((s) => s.step_id);
  const stepsMissingSkipReason = getStepsMissingSkipReason(skipped);
  const stepsGhost = steps.filter((s) => s.status === "planned").map((s) => s.step_id);
  const artifacts = scanArtifacts(workspace, completed);
  const complete =
    stepsMissing.length === 0 &&
    stepsMissingSkipReason.length === 0 &&
    artifacts.missing.length === 0;
  const sideEffects = complete
    ? await runCompletionSideEffects(workspace, steps, projectDir)
    : undefined;
  const cleanup = complete ? await archiveWorkspaceOnly(workspace, projectDir) : undefined;
  return {
    artifacts,
    cleanup,
    complete,
    completed,
    gateNonEvaluations: computeGateNonEvaluations(steps),
    sideEffects,
    stepsGhost,
    stepsMissing,
    stepsMissingSkipReason,
    stepsSkipped,
  };
}

export async function finalizeWorkspace(
  input: FinalizeWorkspaceInput,
): Promise<ToolResult<FinalizeWorkspaceResult>> {
  const { workspace, projectDir, session_id } = input;

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
  const {
    artifacts,
    cleanup,
    complete,
    completed,
    gateNonEvaluations,
    sideEffects,
    stepsGhost,
    stepsMissing,
    stepsMissingSkipReason,
    stepsSkipped,
  } = await analyzeJournalSteps(workspace, steps, projectDir);

  // Release the workspace mutex. Run regardless of `complete` so an incomplete
  // finalize (e.g. a cancelled build) still unlocks the workspace.
  // Best-effort: releaseLock never throws for expected conditions (ENOENT, owner
  // mismatch). Pass session_id so we don't delete a peer session's lock.
  const { released: lock_released } = releaseLock(workspace, { session_id });

  return toolOk({
    artifacts_expected: artifacts.expected,
    artifacts_missing: artifacts.missing,
    artifacts_skipped_unresolved: artifacts.skipped_unresolved,
    complete,
    flow_outcome: computeFlowOutcome(steps),
    gate_non_evaluations: gateNonEvaluations,
    lock_released,
    steps_completed: completed.length,
    steps_ghost: stepsGhost,
    steps_logged: steps.length,
    steps_missing: stepsMissing,
    steps_missing_skip_reason: stepsMissingSkipReason,
    steps_skipped: stepsSkipped,
    t2_non_firing: computeT2NonFiring(steps),
    ...(cleanup
      ? {
          teardown_deferred: cleanup.teardown_deferred,
          teardown_owner:
            "age-based janitor sweep on a subsequent finalize/invoke_janitor run (reclaims this workspace once its ship step is completed AND its age exceeds max_abandoned_workspace_age_hours; null disables auto-reclaim), or direct-merge git branch -d",
          workspace_archived: cleanup.archived,
        }
      : {}),
    ...(sideEffects ?? {}),
  });
}

// Exports for registration layer and reconcile-workspace.ts (same module family, no barrel).
// writeJournal is also reused by init-workspace.ts to seed/refresh session_id
// (tail-gate-codex-fix P1) — the single journal writer, not a second one.
export const journalFilename = "journal.json";
export { journalPath as _journalPath, readJournal, scanArtifactList, writeJournal };
