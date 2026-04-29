/**
 * orchestration-journal — MCP tools for the agent-teams orchestration journal.
 *
 * Two tools:
 *   - log_step: record a step's status (planned/started/completed/skipped)
 *     and associated metadata (agent, expected artifacts, domain skills
 *     loaded, outcome signals).
 *   - verify_completion: read the journal back and report which steps are
 *     incomplete, which expected artifacts are missing, and aggregate
 *     quality signals across the flow run.
 *
 * Both tools are gated behind CANON_AGENT_TEAMS_MODE=on via their
 * registration in register-orchestration.ts; the handlers themselves are
 * pure and safe to call regardless.
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

import { existsSync, globSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { archiveWorkspace } from "@features/history/services/archive-service.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

function resolveProjectDir(): string {
  return process.env.CANON_PROJECT_DIR ?? process.cwd();
}

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
  started_at?: string;
  status: JournalStepStatus;
  step_id: string;
};

export type Journal = {
  steps: JournalStep[];
  version: 1;
  workspace: string;
};

export type LogStepInput = {
  agent_type?: string | null;
  artifacts_expected?: string[];
  domain_skills_loaded?: string[];
  outcome?: JournalOutcome;
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
};

export type VerifyCompletionInput = {
  workspace: string;
};

export type VerifyCompletionResult = {
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
  steps_skipped: string[];
  /** Present only when complete is true. True when archive succeeded. */
  workspace_archived?: boolean;
  /** Present only when complete is true. True when workspace directory was deleted. */
  workspace_deleted?: boolean;
};

function journalPath(workspace: string): string {
  return join(workspace, "journal.json");
}

async function readJournal(workspace: string): Promise<Journal> {
  const path = journalPath(workspace);
  if (!existsSync(path)) {
    return { steps: [], version: 1, workspace };
  }
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Journal;
  if (!Array.isArray(parsed.steps)) parsed.steps = [];
  return parsed;
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
}

export async function logStep(input: LogStepInput): Promise<ToolResult<LogStepResult>> {
  if (!input.step_id?.trim()) {
    return toolError("INVALID_INPUT", "step_id must be a non-empty string", false);
  }
  if (!input.workspace || !existsSync(input.workspace)) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace does not exist: ${input.workspace}`, false, {
      workspace: input.workspace,
    });
  }

  const journal = await readJournal(input.workspace);
  const step = upsertStep(journal, input);
  applyTimestamps(step, input.status);
  applyMetadata(step, input);
  await writeJournal(input.workspace, journal);

  const result: LogStepResult = { status: input.status, step_id: input.step_id };
  if (input.status === "completed") {
    const missing = scanArtifactsForStep(input.workspace, step);
    if (missing.length > 0) {
      result.artifacts_missing = missing;
    }
  }
  return toolOk(result);
}

/**
 * Resolve an artifact path (possibly with a glob) against the workspace.
 * Plain paths and glob patterns are both handled by node:fs globSync —
 * returns true when at least one file matches. `${var}` template fragments
 * are handled upstream in scanArtifacts and never reach this function.
 */
function artifactExists(workspace: string, artifact: string): boolean {
  return globSync(artifact, { cwd: workspace }).length > 0;
}

/**
 * Scan a single step's declared artifacts for missing files.
 *
 * Skips entries that are:
 * - Prefixed with `outcome:` — these are outcome descriptions, not file paths
 * - Containing `${` — these are unresolved template variables
 *
 * Returns an array of artifact paths that are missing from disk. Returns an
 * empty array when all artifacts are present (or all entries are skipped).
 */
function scanArtifactsForStep(workspace: string, step: JournalStep): string[] {
  const missing: string[] = [];
  for (const art of step.artifacts_expected ?? []) {
    // Skip outcome descriptions (not file paths)
    if (art.startsWith("outcome:")) continue;
    // Skip unresolved template variables
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

function scanArtifacts(workspace: string, completed: readonly JournalStep[]): ArtifactScan {
  const expected: string[] = [];
  const missing: string[] = [];
  const skipped_unresolved: string[] = [];
  for (const step of completed) {
    for (const art of step.artifacts_expected ?? []) {
      expected.push(art);
      // Skip outcome descriptions (not file paths) — defensive fix: outcome:
      // entries would otherwise be passed to globSync which silently returns
      // no matches, causing false-positive missing reports.
      if (art.startsWith("outcome:")) continue;
      if (art.includes("${")) {
        skipped_unresolved.push(art);
      } else if (!artifactExists(workspace, art)) {
        missing.push(art);
      }
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

function computeFlowOutcome(steps: readonly JournalStep[]): VerifyCompletionResult["flow_outcome"] {
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

async function archiveAndDeleteWorkspace(
  workspace: string,
): Promise<{ archived: boolean; deleted: boolean }> {
  let archived = false;
  try {
    const session = getExecutionStore(workspace).getSession();
    const branch = session?.branch ?? "unknown";
    const slug = session?.slug ?? basename(workspace);
    await archiveWorkspace({
      branch,
      projectDir: resolveProjectDir(),
      slug,
      workspacePath: workspace,
    });
    archived = true;
  } catch (err: unknown) {
    console.warn("[canon] workspace archive failed:", err instanceof Error ? err.message : err);
  }

  let deleted = false;
  try {
    rmSync(workspace, { force: true, recursive: true });
    deleted = true;
  } catch (err: unknown) {
    console.warn("[canon] workspace deletion failed:", err instanceof Error ? err.message : err);
  }

  return { archived, deleted };
}

export async function verifyCompletion(
  input: VerifyCompletionInput,
): Promise<ToolResult<VerifyCompletionResult>> {
  const { workspace } = input;

  if (!workspace) {
    return toolError("INVALID_INPUT", "workspace must be a non-empty string", false);
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
  const stepsSkipped = steps.filter((s) => s.status === "skipped").map((s) => s.step_id);

  const artifacts = scanArtifacts(workspace, completed);
  const complete = stepsMissing.length === 0 && artifacts.missing.length === 0;

  const cleanup = complete ? await archiveAndDeleteWorkspace(workspace) : undefined;

  return toolOk({
    artifacts_expected: artifacts.expected,
    artifacts_missing: artifacts.missing,
    artifacts_skipped_unresolved: artifacts.skipped_unresolved,
    complete,
    flow_outcome: computeFlowOutcome(steps),
    steps_completed: completed.length,
    steps_logged: steps.length,
    steps_missing: stepsMissing,
    steps_skipped: stepsSkipped,
    ...(cleanup
      ? { workspace_archived: cleanup.archived, workspace_deleted: cleanup.deleted }
      : {}),
  });
}

// Re-export for registration layer.
export const journalFilename = "journal.json";
export { journalPath as _journalPath };
