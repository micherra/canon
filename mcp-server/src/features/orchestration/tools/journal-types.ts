/**
 * journal-types — pure type declarations for the orchestration journal.
 *
 * Extracted from orchestration-journal.ts (line-limit-split-into-siblings
 * convention, same rationale as services/finalize-helpers.ts) — no runtime
 * logic here, only the shapes logStep/finalizeWorkspace/batchLogSteps read
 * and write. Re-exported from orchestration-journal.ts so existing
 * importers of that module are unaffected.
 */

import type {
  computeGateNonEvaluations,
  computeT2NonFiring,
} from "../services/finalize-helpers.ts";

export type JournalStepStatus = "planned" | "started" | "completed" | "skipped";

export type JournalOutcome = {
  /**
   * Post-implement/fix evaluator-gate result (ADR-0062). skipped/verdict are
   * z.string(), not a literal union, so the MCP-boundary schema
   * (stepOutcomeSchema, register-journal.ts) never silently strips a future
   * value; computeGateNonEvaluations (finalize-helpers.ts) narrows via plain
   * string equality.
   */
  evaluator_gate?: {
    advisory?: number;
    skipped?: string;
    verdict?: string;
  };
  fix_iterations?: number;
  review_verdict?: string;
  t2_recorded?: boolean; // ADR-0065, advisory — see computeT2NonFiring
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
  /**
   * The session that owns this workspace, refreshed on every init_workspace
   * create/resume. Durable session-identity carrier for the stop-hook
   * tail-enforcement gate (hooks/tail-enforcement-gate.sh): journal.json
   * survives finalize_workspace (which releases the ephemeral `.lock` mutex
   * unconditionally, before the gate's ship==completed trigger can ever
   * fire), so it — not `.lock` — is the signal the gate matches a Stop
   * event's session_id against. Absent when init_workspace was called
   * without a session_id (never written as the literal "unknown").
   */
  session_id?: string;
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
  /** Project directory — threaded from resolveScope(extra) in register-journal.ts. */
  projectDir: string;
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
  /** Project directory — threaded from resolveScope(extra) in register-journal.ts. */
  projectDir: string;
  /**
   * Calling session's identity — used to release the workspace mutex.
   * Pass the same value given to init_workspace. Omitting means the lock
   * is released unconditionally (single-session flows) to preserve backward
   * compatibility.
   */
  session_id?: string;
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
  /**
   * Non-evaluations of the post-implement/fix evaluator gate (ADR-0062,
   * Layer 2): step IDs paired with the reason the gate did not render a real
   * PASS/FAIL verdict — a skip (`tool_unavailable` | `tool_error`, step 2) or
   * a parse failure that fell open (`PASS_parse_fallback`, step 7).
   * Informational only; always an array (empty when none). Does NOT add any
   * blocking and MUST NOT affect `complete` — a non-empty array still yields
   * `complete: true` when steps and artifacts are otherwise satisfied. Keys
   * on the distinct non-evaluation values, never on the mere presence of an
   * `evaluator_gate` outcome — a real `verdict: "PASS"` (or `"FAIL"`) yields
   * no entry.
   */
  gate_non_evaluations: ReturnType<typeof computeGateNonEvaluations>;
  t2_non_firing: ReturnType<typeof computeT2NonFiring>; // ADR-0065, sibling to gate_non_evaluations
  /** Present only when complete is true. True when archive succeeded. */
  workspace_archived?: boolean;
  /**
   * Present only when complete is true. True when destructive teardown (worktree
   * deregistration, branch deletion, workspace directory removal) has been deferred
   * to the post-ship janitor or a direct-merge workflow. The build branch and
   * worktree directory remain intact for the shipper to use. (finalize-02, ADR-0016)
   */
  teardown_deferred?: boolean;
  /**
   * Present only when complete is true and teardown_deferred is true.
   * Names the post-ship owner responsible for teardown.
   */
  teardown_owner?: string;
  /** Present only when complete is true. True when file claims were released successfully. */
  claims_released?: boolean;
  /** Present only when complete is true. True when flow analytics were recorded successfully. */
  analytics_recorded?: boolean;
  /** Present only when complete is true. True when build digest was written to auto-memory. */
  digest_written?: boolean;
  /** Present only when complete is true. True when build trend summary was written to workspace. */
  trend_summary_written?: boolean;
  /**
   * True when the workspace mutex (`.lock` file) was released by this finalize call.
   * False when the lock was already gone, absent, or owned by a different session.
   * Present in all finalize responses (not just complete ones) — release is
   * attempted regardless of whether the flow completed cleanly.
   */
  lock_released?: boolean;
};
