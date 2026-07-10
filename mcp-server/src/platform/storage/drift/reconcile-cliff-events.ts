/**
 * reconcile-cliff-events — one-shot audited cleanup of historical false-positive
 * context-sync cliff_events rows (watch_GGGGGG1's data-side counterpart).
 *
 * Provides:
 * - `reconcileFalseCliffEvents`: thin wrapper over CliffEventsDao.deleteByExactIdentity.
 *   Idempotent (second call returns { deleted: 0, not_found: N }).
 * - `AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07`: the audited seed set of 14 exact
 *   (workspace_slug, step_id, detected_at) tuples from the false-positive audit
 *   described below.
 *
 * Mirrors reconcileStaleViolations (closure-04 Option A): no durable caller,
 * applied once via a throwaway runner.
 *
 * Canon principles applied:
 * - simplicity-first: thin wrapper over the DAO primitive; no new SQL here.
 * - define-errors-out-of-existence: empty specs → zero counts, no error.
 * - aggregates-reference-by-id: the seed references rows by their identity
 *   tuple, not embedded state.
 */

import type { CliffEventDeleteSpec } from "./cliff-events-dao.ts";
import { getDriftDb } from "./drift-db-cache.ts";

/**
 * Delete cliff_events rows matching a set of audited (workspace_slug, step_id,
 * detected_at) specs.
 *
 * Idempotent: runs a straight identity-match DELETE; a second call with the
 * same specs matches 0 rows.
 *
 * @param projectDir - Repo root (`.canon/drift.db` resolved from here).
 * @param specs      - Exact tuples to delete. Pass `AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07`
 *                     for the one-time cleanup.
 * @returns Counts of deleted and not-found rows.
 */
export function reconcileFalseCliffEvents(
  projectDir: string,
  specs: ReadonlyArray<CliffEventDeleteSpec>,
): { deleted: number; not_found: number } {
  return getDriftDb(projectDir).getCliffEvents().deleteByExactIdentity(specs);
}

/**
 * Audited never-dispatched-planned false-positive context-sync cliff_events.
 * Source: build fix-reconcileworkspace-so-a-never-dispatched-planned-step-startedat.
 * Audit method: drift.db cliff_events ⋈ archived journal.json — each row's
 * detected_at precedes its step's own started_at (or the step never started);
 * all 14 later reached a clean terminal state (13 completed, 1 skipped). Human
 * join-audit, NOT a programmatic re-check. See PROBE-FINDINGS.md.
 * EXCLUDED (preserved): workflow-integration-epic-increment-0-... (no archive to
 * audit) and all non-context-sync rows (unaudited).
 * canon:allow-unwired: one-shot audited-false-positive cleanup seed; consumed by a
 * throwaway runner (closure-04 Option A) — no durable caller by design (mirrors
 * AUDITED_STALE_2026_06).
 */
export const AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07: ReadonlyArray<CliffEventDeleteSpec> = [
  {
    detected_at: "2026-06-07T18:13:51.696Z",
    step_id: "context-sync",
    workspace_slug: "implement-cliff-detected-learner-dimension-consumer-watch-bbbbb1",
  },
  {
    detected_at: "2026-06-14T23:45:38.802Z",
    step_id: "context-sync",
    workspace_slug: "fix-finalizeworkspace-so-it-does-not-delete-the-canonslug-git-branch",
  },
  {
    detected_at: "2026-06-25T17:59:56.297Z",
    step_id: "context-sync",
    workspace_slug: "build-the-attribution-consumer-attribute-step-for-trace-driven",
  },
  {
    detected_at: "2026-06-26T03:32:30.848Z",
    step_id: "context-sync",
    workspace_slug: "build-the-mutator-candidate-generation-for-trace-driven-evolution-phase",
  },
  {
    detected_at: "2026-06-30T02:22:39.918Z",
    step_id: "context-sync",
    workspace_slug: "address-all-11-open-github-code-scanning-alerts-3-actionsmissing",
  },
  {
    detected_at: "2026-07-01T06:45:54.639Z",
    step_id: "context-sync",
    workspace_slug: "design-m1-success-pattern-learner-agentkb-r4-architect-design-runbook",
  },
  {
    detected_at: "2026-07-03T01:28:31.152Z",
    step_id: "context-sync",
    workspace_slug: "explore-promoting-canons-execution-store-event-log-to-the-primary-state",
  },
  {
    detected_at: "2026-07-03T17:23:52.191Z",
    step_id: "context-sync",
    workspace_slug: "add-a-deterministic-stop-hook-tail-enforcement-gate-delta-d3-from-the",
  },
  {
    detected_at: "2026-07-05T17:36:39.465Z",
    step_id: "context-sync-codex-fix",
    workspace_slug: "add-a-deterministic-stop-hook-tail-enforcement-gate-delta-d3-from-the",
  },
  {
    detected_at: "2026-07-05T19:03:39.764Z",
    step_id: "context-sync",
    workspace_slug: "constrain-syncindexes-projectdir-override-to-the-resolved-session-scope",
  },
  {
    detected_at: "2026-07-05T20:04:37.186Z",
    step_id: "context-sync",
    workspace_slug: "scope-an-increment-to-adopt-claude-codes-artifact-tool-as-the",
  },
  {
    detected_at: "2026-07-07T01:19:36.853Z",
    step_id: "context-sync",
    workspace_slug: "resolve-the-5-open-follow-ups-from-pr-462-corpus-optimization-5",
  },
  {
    detected_at: "2026-07-07T01:53:13.812Z",
    step_id: "context-sync",
    workspace_slug: "implement-the-eve-derived-measured-step-reviewer-runtime-per",
  },
  {
    detected_at: "2026-07-07T03:11:58.699Z",
    step_id: "context-sync",
    workspace_slug: "design-spike-fail-closed-logstepcompleted-write-receipt-gate-so-an",
  },
];
