# Orchestrator-scoped principle measurement gap

**Status: Open** — decision recorded in [ADR-0034](../adr/0034-orchestrator-scoped-principles-are-a-distinct-measurement-surface.md); this document parks the deferred long-term fix (Option B) so it is not lost.

## Finding

A full-history learner run (2026-07-02) found that 23 of 46 never-cited principles are
orchestrator-/architect-scoped (e.g. `agent-design-before-code`, `agent-plans-are-prompts`,
`agent-document-decisions`) and carry **zero `honored` citations across 94 reviews**. The
learner correctly classified this as a reviewer *measurement* gap, not principle deadness.

## Mechanism (file/function evidence)

The code-review flow surfaces principles scope-filtered to the diff:

- `review-code.ts:211-214` calls `matchPrinciples(allPrinciples, { file_path })` (`matcher.ts:134`).
- `matchesFilePattern` (`matcher.ts:55-58`) admits a principle only when a diff file
  glob-matches one of its `scope.file_patterns`.

Orchestrator-scoped principles are file-pattern-scoped to non-code, gitignored paths
(e.g. `.canon/plans/*/DESIGN.md`, `.canon/plans/**/*-PLAN.md`). A code diff never
glob-matches those patterns, and those paths never appear in a PR diff — these
principles are structurally unreachable by code review. Universal-scope agent rules
(`layers:[]`, no `file_patterns`) ARE surfaced against every code file, but they are
semantically about architect/orchestrator behavior, so reviewers never mark them
honored. Either way, the `honored[]` set — chosen by the reviewer from the surfaced
principles, persisted by `store_pr_review`, counted by `get-compliance.ts:49` — never
contains them.

The matcher is behaving correctly. The gap is structural: **the only measurement
surface Canon runs is code review over the worktree diff.** There is no review pass
over the orchestration trace/artifacts (DESIGN.md, plans, orchestrator decisions) that
these principles actually govern.

## Decision (see ADR-0034)

Documented as by-design (Option C): the zero-citation signal is recorded as a known,
intentional measurement-surface gap — not principle deadness. The 23 affected
principles are **not** retired; they remain live governance for architect/orchestrator
behavior, just uncited by the current review pipeline.

## The correct future fix — Option B: an orchestration-trace self-review surface

The semantically correct long-term home for this measurement is a **dedicated
orchestration-trace self-review surface**: a review pass that evaluates a *completed
flow's* trace and artifacts (DESIGN.md, plans, orchestrator decisions, runbook
execution) against the orchestrator-scoped principles, and records `honored`/`violated`
citations through the existing `store_pr_review` / compliance write path — the same
persistence and `get-compliance.ts` counting logic used for code review today, just
fed a different (non-diff) input.

Sketch of what Option B would need:

1. A collector that assembles the "orchestration trace" for a completed build:
   DESIGN.md, the runbook/task plans, `journal.json`, and the durable decisions ledger.
2. A principle-matching pass scoped to orchestrator-scoped principles (the same 23),
   evaluated against that trace instead of a code diff.
3. A reviewer (agent or deterministic checks, or both) that produces `honored[]` /
   `violated[]` for that trace, written via `store_pr_review` so `get-compliance.ts`
   picks it up like any other review.
4. A trigger point — most naturally a post-ship or context-sync step — that invokes
   this pass once per build.

This is deliberately **not** built in this pass. It is net-new machinery (a new review
pass, a new input shape, a new trigger point) that is out of proportion to the fix this
build addresses (the drift.db fixture-leak + a documented decision for the blindspot).
Forcing it into the current build would also risk rushing the design of a new
measurement surface without the scrutiny it deserves.

## Revisit-If

- A learner run or contributor needs compliance/drift signal for orchestrator-scoped
  principles for a concrete decision (e.g. "should we retire principle X because it's
  never honored?") — that is exactly the situation this gap could cause a wrong call,
  and is the trigger to scope Option B into its own build.
- The matcher's scope semantics change such that orchestration artifacts start
  entering the review diff (unlikely, since `.canon/plans/**` is gitignored by design).

## See also

- [ADR-0034](../adr/0034-orchestrator-scoped-principles-are-a-distinct-measurement-surface.md) — the durable decision record for this finding.
