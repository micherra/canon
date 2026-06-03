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
 *   plan-v2.md §2.9 for the dependency.
 *
 * See v2 migration plan §2.9 and phase1-06 PLAN for the contract.
 */

import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { tryWriteBuildTrendSummary } from "../services/build-trend-summary-writer.ts";
import { tryWriteBuildDigest } from "../services/digest-writer.ts";
import {
  archiveAndDeleteWorkspace,
  tryAppendAnalytics,
  tryReleaseClaims,
  tryRunJanitor,
} from "../services/workspace-cleanup.ts";
import { captureTranscript } from "./capture-transcript.ts";

export type JournalStepStatus = "planned" | "started" | "completed" | "skipped";

export type JournalOutcome = {
  fix_iterations?: number;
  review_verdict?: string;
  test_pass_rate?: number;
};

export type JournalStep = {
  agent_type: string | null;
  artifacts_expected: string[];
  completed_at?: string;
  domain_skills_loaded?: string[];
  outcome?: JournalOutcome;
  skip_reason?: string;
  started_at?: string;
  status: JournalStepStatus;
  step_id: string;
  transcript_path?: string;
};

export type Journal = {
  steps: JournalStep[];
  version: 1;
  workspace: string;
};

export type LogStepInput = {
  /** Agent ID for transcript capture. When provided on a completed step, logStep calls captureTranscript internally. */
  agent_id?: string;
  agent_type?: string | null;
  artifacts_expected?: string[];
  domain_skills_loaded?: string[];
  outcome?: JournalOutcome;
  skip_reason?: string;
  status: JournalStepStatus;
  step_id: string;
  workspace: string;
};

export type LogStepResult = {
  /**
   * Artifact paths declared in `artifacts_expected` that do not exist on disk
   * after the step completed. Only populated when `status === "completed"` and
   * at least one declared artifact is missing. Absent (not an empty array) when
   * all artifacts are present or when the step is not completed.
   *
   * Paths with unresolved `${variable}` template fragments and paths prefixed
   * with `outcome:` are excluded from this check — they are not file paths.
   */
  artifacts_missing?: string[];
  status: JournalStepStatus;
  step_id: string;
  transcript_path?: string;
  transcript_warning?: string;
};

export type FinalizeWorkspaceInput = {
  workspace: string;
};

export type FinalizeWorkspaceResult = {
  artifacts_expected: string[];
  artifacts_missing: string[];
  /**
   * Artifact expectations whose paths still contain an unresolved
   * `${variable}` template fragment. We do NOT treat these as missing
   * (that would produce false negatives for runbooks authored with
   * variables); we surface them here so the lead can confirm the
   * template was substituted correctly before declaring done.
   */
  artifacts_skipped_unresolved: string[];
  complete: boolean;
  flow_outcome: {
    domain_skills_used: string[];
    /**
     * Review verdict from the LAST completed step that emitted one
     * (iteration order preserved by `journal.steps` append order, which
     * matches `logStep` call order). Answers "did this flow end
     * approved?" — not "was there ever an approve?" For multi-pass
     * review→fix→re-review flows, this is the re-review verdict, not
     * the original review.
     */
    review_verdict: string | null;
    /**
     * Sum of `outcome.fix_iterations` across all steps that reported one.
     * Per-step semantic is "iterations within that step" (e.g. a single
     * fix-state's inner convergence loop). Summing across steps gives
     * total fix-mode activity across the whole flow — useful for skill-
     * correlation analysis (§4b P4), not for reasoning about any single
     * step's work.
     */
    fix_iterations: number;
    total_steps: number;
    /**
     * Wall-clock duration: `max(completed_at) - min(started_at)` across
     * all steps that emitted timestamps. Not the sum of per-step
     * durations (which would exclude idle time between steps).
     */
    total_duration_ms: number | null;
  };
  steps_completed: number;
  steps_logged: number;
  /**
   * Steps that are logged but not yet in a terminal state (completed or
   * skipped). Includes both "planned" entries (registered but never
   * executed) and "started" entries (execution began but did not
   * complete). A non-empty array blocks `complete: true`.
   */
  steps_missing: Array<{ step_id: string; status: JournalStepStatus }>;
  /**
   * Skipped steps that have no `skip_reason`. These represent L4 defense-in-
   * depth violations — the L1 check in logStep/batchLogSteps should have
   * rejected these writes, but journals can be corrupted by bugs, manual
   * edits, or older code paths. A non-empty array blocks `complete: true`.
   */
  steps_missing_skip_reason: string[];
  steps_skipped: string[];
  /**
   * Step IDs of steps that were registered with `status: "planned"` but
   * never transitioned to `started`, `completed`, or `skipped`. These are
   * "ghost" steps — they appear in the journal but were never executed.
   * A subset of `steps_missing` (which includes both "planned" and "started").
   * Always an array (empty when no ghosts). Informational only — does not add
   * additional blocking beyond `steps_missing` (which already includes these
   * steps and blocks `complete`).
   */
  steps_ghost: string[];
  /** Present only when complete is true. True when archive succeeded. */
  workspace_archived?: boolean;
  /** Present only when complete is true. True when workspace directory was deleted. */
  workspace_deleted?: boolean;
  /** Present only when complete is true. True when file claims were released successfully. */
  claims_released?: boolean;
  /** Present only when complete is true. True when flow analytics were recorded successfully. */
  analytics_recorded?: boolean;
  /** Present only when complete is true. True when build digest was written to auto-memory. */
  digest_written?: boolean;
  /** Present only when complete is true. True when build trend summary was written to workspace. */
  trend_summary_written?: boolean;
};

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
  return { steps, version: 1, workspace };
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

async function tryTranscriptCapture(
  step: JournalStep,
  result: LogStepResult,
  input: LogStepInput,
): Promise<void> {
  if (!input.agent_id) return;
  const captureResult = await captureTranscript({
    agent_id: input.agent_id,
    agent_type: step.agent_type ?? "unknown",
    step_id: input.step_id,
    workspace: input.workspace,
  });
  if (captureResult.ok && captureResult.transcript_path) {
    step.transcript_path = captureResult.transcript_path;
    result.transcript_path = captureResult.transcript_path;
    // Persist to ExecutionStore so get_transcript can find the path via getTranscriptPath().
    try {
      const store = getExecutionStore(input.workspace);
      store.setTranscriptPath(input.step_id, captureResult.transcript_path);
    } catch {
      // best-effort — transcript capture itself already succeeded; don't fail the step
    }
  }
  if (captureResult.ok && captureResult.warning) {
    result.transcript_warning = captureResult.warning;
  }
}

export type BatchLogStepsInput = {
  workspace: string;
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

function processEntries(
  journal: Journal,
  input: BatchLogStepsInput,
): { results: LogStepResult[]; captureTasks: CaptureTask[]; rejection?: ToolResult<null> } {
  const results: LogStepResult[] = [];
  const captureTasks: CaptureTask[] = [];

  for (const entry of input.steps) {
    const logInput: LogStepInput = {
      agent_id: entry.agent_id,
      agent_type: entry.agent_type,
      artifacts_expected: entry.artifacts_expected,
      domain_skills_loaded: entry.domain_skills_loaded,
      outcome: entry.outcome,
      skip_reason: entry.skip_reason,
      status: entry.status,
      step_id: entry.step_id,
      workspace: input.workspace,
    };

    if (entry.status === "completed") {
      const rejection = enforceArtifacts(
        input.workspace,
        entry.step_id,
        journal,
        entry.artifacts_expected,
      );
      if (rejection) return { captureTasks, rejection, results };
    }

    const step = upsertStep(journal, logInput);
    applyTimestamps(step, entry.status);
    applyMetadata(step, logInput);

    const result: LogStepResult = { status: entry.status, step_id: entry.step_id };

    if (entry.status === "completed" && entry.agent_id) {
      captureTasks.push({ logInput, result, step });
    }

    results.push(result);
  }

  return { captureTasks, results };
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

  const { captureTasks, results, rejection } = processEntries(journal, input);
  if (rejection) return rejection;

  // 5. Single journal write (before transcript capture — captures are best-effort).
  await writeJournal(input.workspace, journal);

  // 6. Run transcript captures in parallel (no await inside a loop).
  await Promise.all(
    captureTasks.map(({ logInput, result, step }) => tryTranscriptCapture(step, result, logInput)),
  );

  // 7. If any captures added a transcript_path, persist those fields to the journal.
  const hasCaptures = captureTasks.some(({ step }) => step.transcript_path);
  if (hasCaptures) {
    await writeJournal(input.workspace, journal);
  }

  return toolOk({ results });
}

export async function logStep(input: LogStepInput): Promise<ToolResult<LogStepResult>> {
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

  const journal = await readJournal(input.workspace);

  if (input.status === "completed") {
    const rejection = enforceArtifacts(
      input.workspace,
      input.step_id,
      journal,
      input.artifacts_expected,
    );
    if (rejection) return rejection;
  }

  const step = upsertStep(journal, input);
  applyTimestamps(step, input.status);
  applyMetadata(step, input);

  const result: LogStepResult = { status: input.status, step_id: input.step_id };

  if (input.status === "completed") {
    await tryTranscriptCapture(step, result, input);
  }

  await writeJournal(input.workspace, journal);

  return toolOk(result);
}

// Pure compute: for a literal *-SUMMARY.md path (no glob *), return the
// directory-scoped *-SUMMARY.md glob so artifactExists can discover the real
// slug/task_id-named summary. null for globs and non-SUMMARY stems (fixed-stem
// artifacts must exact-match to keep the safety property).
function summaryGlobFallback(artifact: string): string | null {
  if (artifact.includes("*") || !/-SUMMARY\.md$/.test(artifact)) return null;
  const slash = artifact.lastIndexOf("/");
  return `${slash === -1 ? "" : artifact.slice(0, slash + 1)}*-SUMMARY.md`;
}
// Resolves an artifact path (plain or glob) against workspace root and worktree/.
// For a literal *-SUMMARY.md expectation that misses, retries once via
// summaryGlobFallback to discover the real auto-named summary without relaxing
// fixed-stem (DESIGN.md, REVIEW.md) checks.
function artifactExists(workspace: string, artifact: string): boolean {
  if (globSync(artifact, { cwd: workspace }).length > 0) return true;
  const worktreePath = join(workspace, "worktree");
  if (globSync(artifact, { cwd: worktreePath }).length > 0) return true;
  const fallback = summaryGlobFallback(artifact);
  if (fallback) {
    if (globSync(fallback, { cwd: workspace }).length > 0) return true;
    if (globSync(fallback, { cwd: worktreePath }).length > 0) return true;
  }
  return false;
}

/**
 * Scan a list of artifact paths for missing files.
 *
 * Skips entries that are:
 * - Prefixed with `outcome:` — these are outcome descriptions, not file paths
 * - Containing `${` — these are unresolved template variables
 *
 * Returns an array of artifact paths that are missing from disk. Returns an
 * empty array when all artifacts are present (or all entries are skipped).
 */
function scanArtifactList(workspace: string, artifacts: readonly string[]): string[] {
  const missing: string[] = [];
  for (const art of artifacts) {
    if (art.startsWith("outcome:")) continue;
    if (art.includes("${")) continue;
    if (!artifactExists(workspace, art)) {
      missing.push(art);
    }
  }
  return missing;
}

type ArtifactScan = {
  expected: string[];
  missing: string[];
  skipped_unresolved: string[];
};

/**
 * Classify a single artifact path into one of three buckets: skip (outcome/unresolved),
 * missing, or present. Returns "outcome" | "unresolved" | "missing" | "present".
 */
function classifyArtifact(
  workspace: string,
  art: string,
): "outcome" | "unresolved" | "missing" | "present" {
  if (art.startsWith("outcome:")) return "outcome";
  if (art.includes("${")) return "unresolved";
  return artifactExists(workspace, art) ? "present" : "missing";
}

function scanArtifacts(workspace: string, completed: readonly JournalStep[]): ArtifactScan {
  const expected: string[] = [];
  const missing: string[] = [];
  const skipped_unresolved: string[] = [];
  for (const step of completed) {
    for (const art of step.artifacts_expected ?? []) {
      expected.push(art);
      const classification = classifyArtifact(workspace, art);
      if (classification === "unresolved") skipped_unresolved.push(art);
      else if (classification === "missing") missing.push(art);
    }
  }
  return { expected, missing, skipped_unresolved };
}

/** Wall clock: max(completed_at) − min(started_at). Null when no timestamps. */
function computeTotalDurationMs(steps: readonly JournalStep[]): number | null {
  const starts = steps.map((s) => s.started_at).filter((t): t is string => typeof t === "string");
  const ends = steps.map((s) => s.completed_at).filter((t): t is string => typeof t === "string");
  if (starts.length === 0 || ends.length === 0) return null;
  const minStart = Math.min(...starts.map((s) => Date.parse(s)));
  const maxEnd = Math.max(...ends.map((s) => Date.parse(s)));
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
  return maxEnd - minStart;
}

export function computeFlowOutcome(
  steps: readonly JournalStep[],
): FinalizeWorkspaceResult["flow_outcome"] {
  const domain_skills_used = Array.from(
    new Set(steps.flatMap((s) => s.domain_skills_loaded ?? [])),
  ).sort();

  // Last verdict wins: for review→fix→re-review flows the re-review is
  // the one that answers "did this flow end approved?"
  let review_verdict: string | null = null;
  for (const s of steps) {
    if (s.outcome?.review_verdict) review_verdict = s.outcome.review_verdict;
  }

  const fix_iterations = steps.reduce((sum, s) => sum + (s.outcome?.fix_iterations ?? 0), 0);

  return {
    domain_skills_used,
    fix_iterations,
    review_verdict,
    total_duration_ms: computeTotalDurationMs(steps),
    total_steps: steps.length,
  };
}

/** L4 defense-in-depth: returns step IDs of skipped steps that have no skip_reason.
 * The L1 check in logStep/batchLogSteps should have blocked these writes,
 * but journals can be corrupted by bugs, manual edits, or older code paths. */
function getStepsMissingSkipReason(skipped: readonly JournalStep[]): string[] {
  return skipped
    .filter((s) => typeof s.skip_reason !== "string" || !s.skip_reason.trim())
    .map((s) => s.step_id);
}

// Best-effort side effects on workspace completion: digest, analytics, trend summary, claims.
// digest MUST run before archiveAndDeleteWorkspace — it reads workspace files that archive deletes.
async function runCompletionSideEffects(workspace: string, steps: JournalStep[]) {
  const digest_written = await tryWriteBuildDigest(workspace);
  const analytics_recorded = await tryAppendAnalytics(workspace, steps);
  const trend_summary_written = await tryWriteBuildTrendSummary(workspace);
  const claims_released = await tryReleaseClaims(workspace);
  await tryRunJanitor();
  return { analytics_recorded, claims_released, digest_written, trend_summary_written };
}

export async function finalizeWorkspace(
  input: FinalizeWorkspaceInput,
): Promise<ToolResult<FinalizeWorkspaceResult>> {
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

  const completed = steps.filter((s) => s.status === "completed");
  const stepsMissing = steps
    .filter((s) => s.status === "planned" || s.status === "started")
    .map((s) => ({ status: s.status, step_id: s.step_id }));
  const skipped = steps.filter((s) => s.status === "skipped");
  const stepsSkipped = skipped.map((s) => s.step_id);
  const stepsMissingSkipReason = getStepsMissingSkipReason(skipped);
  const stepsGhost = steps.filter((s) => s.status === "planned").map((s) => s.step_id);

  const artifacts = scanArtifacts(workspace, completed);
  const complete =
    stepsMissing.length === 0 &&
    stepsMissingSkipReason.length === 0 &&
    artifacts.missing.length === 0;

  const sideEffects = complete ? await runCompletionSideEffects(workspace, steps) : undefined;
  const cleanup = complete ? await archiveAndDeleteWorkspace(workspace) : undefined;

  return toolOk({
    artifacts_expected: artifacts.expected,
    artifacts_missing: artifacts.missing,
    artifacts_skipped_unresolved: artifacts.skipped_unresolved,
    complete,
    flow_outcome: computeFlowOutcome(steps),
    steps_completed: completed.length,
    steps_ghost: stepsGhost,
    steps_logged: steps.length,
    steps_missing: stepsMissing,
    steps_missing_skip_reason: stepsMissingSkipReason,
    steps_skipped: stepsSkipped,
    ...(cleanup
      ? { workspace_archived: cleanup.archived, workspace_deleted: cleanup.deleted }
      : {}),
    ...(sideEffects ?? {}),
  });
}

// Re-export for registration layer.
export const journalFilename = "journal.json";
export { journalPath as _journalPath };
