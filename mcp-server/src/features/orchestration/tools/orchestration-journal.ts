/**
 * orchestration-journal — MCP tools for the agent-teams orchestration journal.
 *
 * Two tools:
 *   - log_step: record a step's status (planned/started/completed/skipped)
 *     and associated metadata (agent, expected artifacts, MCP tools called,
 *     domain skills loaded, outcome signals).
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

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

export type JournalStepStatus = "planned" | "started" | "completed" | "skipped";

export interface JournalOutcome {
  review_verdict?: string;
  test_pass_rate?: number;
  fix_iterations?: number;
}

export interface JournalStep {
  step_id: string;
  agent_type: string | null;
  artifacts_expected: string[];
  status: JournalStepStatus;
  started_at?: string;
  completed_at?: string;
  mcp_tools_called?: string[];
  domain_skills_loaded?: string[];
  outcome?: JournalOutcome;
}

export interface Journal {
  version: 1;
  workspace: string;
  steps: JournalStep[];
}

export interface LogStepInput {
  workspace: string;
  step_id: string;
  agent_type?: string | null;
  artifacts_expected?: string[];
  status: JournalStepStatus;
  mcp_tools_called?: string[];
  domain_skills_loaded?: string[];
  outcome?: JournalOutcome;
}

export interface LogStepResult {
  step_id: string;
  status: JournalStepStatus;
}

export interface VerifyCompletionInput {
  workspace: string;
}

export interface VerifyCompletionResult {
  steps_logged: number;
  steps_completed: number;
  /**
   * Steps that are logged but not yet in a terminal state (completed or
   * skipped). Includes both "planned" entries (registered but never
   * executed) and "started" entries (execution began but did not
   * complete). A non-empty array blocks `complete: true`.
   */
  steps_missing: Array<{ step_id: string; status: JournalStepStatus }>;
  steps_skipped: string[];
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
}

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

export async function logStep(input: LogStepInput): Promise<ToolResult<LogStepResult>> {
  const {
    workspace,
    step_id,
    agent_type,
    artifacts_expected,
    status,
    mcp_tools_called,
    domain_skills_loaded,
    outcome,
  } = input;

  if (!step_id || !step_id.trim()) {
    return toolError("INVALID_INPUT", "step_id must be a non-empty string", false);
  }
  if (!workspace || !existsSync(workspace)) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace does not exist: ${workspace}`, false, {
      workspace,
    });
  }

  const journal = await readJournal(workspace);
  let step = journal.steps.find((s) => s.step_id === step_id);
  if (!step) {
    step = {
      agent_type: agent_type ?? null,
      artifacts_expected: artifacts_expected ?? [],
      status,
      step_id,
    };
    journal.steps.push(step);
  } else {
    step.status = status;
    if (agent_type !== undefined) step.agent_type = agent_type;
    if (artifacts_expected !== undefined) step.artifacts_expected = artifacts_expected;
  }

  const now = new Date().toISOString();
  if (status === "started" && !step.started_at) {
    step.started_at = now;
  }
  if (status === "completed") {
    if (!step.started_at) step.started_at = now;
    step.completed_at = now;
  }

  if (mcp_tools_called !== undefined) step.mcp_tools_called = mcp_tools_called;
  if (domain_skills_loaded !== undefined) step.domain_skills_loaded = domain_skills_loaded;
  if (outcome !== undefined) step.outcome = outcome;

  await writeJournal(workspace, journal);

  return toolOk({ status, step_id });
}

/**
 * Resolve an artifact path (possibly with a glob) against the workspace.
 * Returns true when the path exists or when at least one glob match exists.
 * Unresolved template variables (`${...}`) short-circuit to true — the
 * caller has no workspace variables at verify time, and treating them as
 * missing would produce false negatives.
 */
function artifactExists(workspace: string, artifact: string): boolean {
  if (artifact.includes("${")) return true;

  const full = isAbsolute(artifact) ? artifact : resolve(workspace, artifact);

  // Simple case: no glob characters.
  if (!/[*?[]/.test(artifact)) {
    return existsSync(full);
  }

  // Glob resolution: walk from the longest path prefix that does not contain
  // a glob character, then match the remainder as a pattern against the
  // directory contents. Supports the common `plans/${slug}/*.md` shape after
  // variable substitution fails — we already handled `${...}` above, so any
  // remaining glob is literal.
  const segments = full.split(/[\\/]/);
  let prefixIdx = 0;
  while (prefixIdx < segments.length && !/[*?[]/.test(segments[prefixIdx] ?? "")) {
    prefixIdx += 1;
  }
  const prefix = segments.slice(0, prefixIdx).join("/") || "/";
  const patternSegments = segments.slice(prefixIdx);
  if (patternSegments.length === 0) return existsSync(prefix);

  return globMatch(prefix, patternSegments);
}

function globMatch(base: string, segments: string[]): boolean {
  if (!existsSync(base) || !statSync(base).isDirectory()) return false;
  const [head, ...rest] = segments;
  if (!head) return true;
  const regex = globSegmentRegex(head);
  const entries = readdirSync(base);
  for (const entry of entries) {
    if (!regex.test(entry)) continue;
    const next = join(base, entry);
    if (rest.length === 0) {
      return true;
    }
    if (statSync(next).isDirectory() && globMatch(next, rest)) {
      return true;
    }
  }
  return false;
}

function globSegmentRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`);
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

  const journal = await readJournal(workspace);
  const steps = journal.steps;

  const completed = steps.filter((s) => s.status === "completed");
  // A step is "missing" whenever it has not reached a terminal state —
  // terminal means completed or skipped. planned + started both count.
  // The previous narrower filter (`started` only) let planned steps slip
  // past the gate; see PR #119 review.
  const stepsMissing = steps
    .filter((s) => s.status === "planned" || s.status === "started")
    .map((s) => ({ status: s.status, step_id: s.step_id }));
  const stepsSkipped = steps.filter((s) => s.status === "skipped").map((s) => s.step_id);

  const artifactsExpected: string[] = [];
  const artifactsMissing: string[] = [];
  const artifactsSkippedUnresolved: string[] = [];
  for (const step of completed) {
    for (const art of step.artifacts_expected ?? []) {
      artifactsExpected.push(art);
      if (art.includes("${")) {
        artifactsSkippedUnresolved.push(art);
        continue;
      }
      if (!artifactExists(workspace, art)) {
        artifactsMissing.push(art);
      }
    }
  }

  const domainSkillsUsed = Array.from(
    new Set(steps.flatMap((s) => s.domain_skills_loaded ?? [])),
  ).sort();
  // Last verdict wins: for review→fix→re-review flows the re-review is
  // the one that answers "did this flow end approved?"
  let reviewVerdict: string | null = null;
  for (const s of steps) {
    if (s.outcome?.review_verdict) reviewVerdict = s.outcome.review_verdict;
  }
  const fixIterations = steps.reduce(
    (sum, s) => sum + (s.outcome?.fix_iterations ?? 0),
    0,
  );

  let totalDurationMs: number | null = null;
  const starts = steps
    .map((s) => s.started_at)
    .filter((t): t is string => typeof t === "string");
  const ends = steps
    .map((s) => s.completed_at)
    .filter((t): t is string => typeof t === "string");
  if (starts.length > 0 && ends.length > 0) {
    const minStart = Math.min(...starts.map((s) => Date.parse(s)));
    const maxEnd = Math.max(...ends.map((s) => Date.parse(s)));
    if (Number.isFinite(minStart) && Number.isFinite(maxEnd)) {
      totalDurationMs = maxEnd - minStart;
    }
  }

  const complete = stepsMissing.length === 0 && artifactsMissing.length === 0;

  return toolOk({
    artifacts_expected: artifactsExpected,
    artifacts_missing: artifactsMissing,
    artifacts_skipped_unresolved: artifactsSkippedUnresolved,
    complete,
    flow_outcome: {
      domain_skills_used: domainSkillsUsed,
      fix_iterations: fixIterations,
      review_verdict: reviewVerdict,
      total_duration_ms: totalDurationMs,
      total_steps: steps.length,
    },
    steps_completed: completed.length,
    steps_logged: steps.length,
    steps_missing: stepsMissing,
    steps_skipped: stepsSkipped,
  });
}

// Re-export for registration layer.
export const journalFilename = "journal.json";
export { journalPath as _journalPath };
