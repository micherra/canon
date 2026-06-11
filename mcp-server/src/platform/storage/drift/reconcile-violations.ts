/**
 * reconcile-violations — idempotent backfill entrypoint for audited stale violations.
 *
 * Provides:
 * - `reconcileStaleViolations`: thin async wrapper over ViolationClosureDao.resolveViolationsByPairs.
 *   Only transitions open → resolved; idempotent (second call returns resolved_count: 0).
 * - `AUDITED_STALE_2026_06`: the audited stale-(file_path, principle_id) seed set from the
 *   verification sweep build `verify-all-21-recorded-drift-violations-at-head-fix-confirmed-live-ones`
 *   (verification commit 46cc346e). Human-audited liveness — NOT a programmatic re-check.
 *
 * Canon principles applied:
 * - simplicity-first: thin wrapper over the DAO primitive; no new SQL here.
 * - define-errors-out-of-existence: empty specs → zero counts, no error.
 * - no-silent-failures: every closure carries resolution_reason; counts returned.
 */

import { getDriftDb } from "./drift-db-cache.ts";
import type { ResolutionCounts, StaleViolationSpec } from "./violation-closure-dao.ts";

/**
 * Resolve OPEN violations matching a set of (file_path, principle_id) specs.
 *
 * Idempotent: runs against `status='open'` rows only; a second call with the
 * same specs returns `{ resolved_count: 0, already_resolved_count: N }`.
 *
 * @param projectDir - Repo root (`.canon/drift.db` resolved from here).
 * @param specs      - Pairs to close. Pass `AUDITED_STALE_2026_06` for the one-time backfill.
 * @param reason     - Resolution provenance string stored on each closed row.
 * @returns Counts of newly resolved and already-resolved violations.
 */
export async function reconcileStaleViolations(
  projectDir: string,
  specs: ReadonlyArray<StaleViolationSpec>,
  reason: string,
): Promise<ResolutionCounts> {
  const ts = new Date().toISOString();
  return getDriftDb(projectDir).getClosures().resolveViolationsByPairs(specs, reason, ts);
}

/**
 * Audited stale (file_path, principle_id) pairs from the verification sweep.
 *
 * Source: build `verify-all-21-recorded-drift-violations-at-head-fix-confirmed-live-ones`
 * Verification commit: 46cc346e
 * Liveness method: human file inspection — NOT a programmatic re-check (see decision closure-03).
 *
 * Reconciled against live stored rows in `.canon/drift.db` (schema v10) on 2026-06-08.
 * Entries in the original sweep SUMMARY that could NOT be matched to actual stored rows
 * are omitted (harmless no-op if included, but we keep the seed tight).
 *
 * Notes on specific entries:
 * - Entry 15 (templates/review-checklist.md): file was deleted but row still exists as open —
 *   stored principle_id is `consistent-abstraction-levels`.
 * - Entry 17 (doc-trim-fact-preservation.md): stored principle_id is `scope-tags-zero-match`
 *   (not the doc's own name).
 * - Entry 18 (enrichment-pipeline-convention.md): stored principle_id is
 *   `enrichment-pipeline-convention` (wiki-lint matched the principle to itself).
 * - Entry 21 (pr-review-data-worktree-path.test.ts): stored principle_id is
 *   `agent-integration-boundary-check` (plan listed `counterexample-obligation` — actual
 *   stored string confirmed by DB query on 2026-06-08).
 * - Entries 9–11 (hooks/destructive-guard.sh): 3 open rows exist for `hooks-fail-closed`;
 *   all 3 must be closed. The DAO resolves all matching open rows per spec so a single
 *   spec entry covers all 3.
 */
export const AUDITED_STALE_2026_06: ReadonlyArray<StaleViolationSpec> = [
  // 1. resolve-project-dir.ts — observable-best-effort
  {
    file_path: "mcp-server/src/app/resolve-project-dir.ts",
    principle_id: "observable-best-effort",
  },
  // 2. wiki-lint.ts — observable-best-effort
  {
    file_path: "mcp-server/src/features/diagnostics/tools/wiki-lint.ts",
    principle_id: "observable-best-effort",
  },
  // 3. write-implementation-summary.ts — observable-best-effort
  {
    file_path: "mcp-server/src/features/orchestration/tools/write-implementation-summary.ts",
    principle_id: "observable-best-effort",
  },
  // 4. write-review.ts — observable-best-effort
  {
    file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
    principle_id: "observable-best-effort",
  },
  // 5. history-types.ts — leave-touched-files-better
  {
    file_path: "mcp-server/src/features/history/history-types.ts",
    principle_id: "leave-touched-files-better",
  },
  // 6. docs/supervised-build-quality.md — leave-touched-files-better
  {
    file_path: "docs/supervised-build-quality.md",
    principle_id: "leave-touched-files-better",
  },
  // 7. janitor.ts — leave-touched-files-better
  {
    file_path: "mcp-server/src/features/orchestration/services/janitor.ts",
    principle_id: "leave-touched-files-better",
  },
  // 8. janitor.ts — fail-closed-by-default
  {
    file_path: "mcp-server/src/features/orchestration/services/janitor.ts",
    principle_id: "fail-closed-by-default",
  },
  // 9–11. hooks/destructive-guard.sh — hooks-fail-closed (3 open rows; one spec closes all)
  {
    file_path: "hooks/destructive-guard.sh",
    principle_id: "hooks-fail-closed",
  },
  // 12. escalation-cascade.test.ts — lint:useSortedKeys
  {
    file_path:
      "mcp-server/src/features/orchestration/services/__tests__/escalation-cascade.test.ts",
    principle_id: "lint:useSortedKeys",
  },
  // 13. finalize-workspace.test.ts — lint:useSortedKeys
  {
    file_path: "mcp-server/src/features/orchestration/tools/__tests__/finalize-workspace.test.ts",
    principle_id: "lint:useSortedKeys",
  },
  // 14. agents/reviewer.md — consistent-abstraction-levels
  {
    file_path: "agents/reviewer.md",
    principle_id: "consistent-abstraction-levels",
  },
  // 15. templates/review-checklist.md — consistent-abstraction-levels (file deleted, row retained)
  {
    file_path: "templates/review-checklist.md",
    principle_id: "consistent-abstraction-levels",
  },
  // 16. kg-embedding.ts — no-hidden-side-effects
  {
    file_path: "mcp-server/src/graph/kg-embedding.ts",
    principle_id: "no-hidden-side-effects",
  },
  // 17. doc-trim-fact-preservation.md — stored as scope-tags-zero-match
  {
    file_path: "principles/conventions/doc-trim-fact-preservation.md",
    principle_id: "scope-tags-zero-match",
  },
  // 18. enrichment-pipeline-convention.md — stored principle_id matches file name
  {
    file_path: "principles/conventions/enrichment-pipeline-convention.md",
    principle_id: "enrichment-pipeline-convention",
  },
  // 19. templates/renderer-review.md — cross-requirement-consistency
  {
    file_path: "templates/renderer-review.md",
    principle_id: "cross-requirement-consistency",
  },
  // 20. janitor-prune-workspaces.test.ts — agent-tdd-required
  {
    file_path:
      "mcp-server/src/features/orchestration/services/__tests__/janitor-prune-workspaces.test.ts",
    principle_id: "agent-tdd-required",
  },
  // 21. pr-review-data-worktree-path.test.ts — agent-integration-boundary-check
  //     (plan listed counterexample-obligation; actual stored string per DB query 2026-06-08)
  {
    file_path: "mcp-server/src/features/pr-review/__tests__/pr-review-data-worktree-path.test.ts",
    principle_id: "agent-integration-boundary-check",
  },
];
