# ADR-0047 — Learning-resolution reconcile is an MCP tool invoked reconcile-on-read, not a hook

**Status:** Accepted
**Date:** 2026-07-10
**Context slug:** improve-canons-learning-resolution-flow-so-proposals-dont-orphan-in

## Context

Proposals under `.canon/proposed-learnings/{timestamp}/` orphan in "pending" state
when their learning ships out-of-band (batch-promotion PRs, direct writer
`apply-proposal`, manual build-flow edits). `/canon:review-learnings` computes
"pending" purely from the absence of an `applied/`/`rejected/`/`dismissed/` subdir,
so already-shipped learnings masquerade as a live backlog indefinitely (verified:
44-item false backlog this session).

We need a mechanism that detects proposals whose target learning already exists on
disk and resolves them to `applied/` with an append-only `learning.jsonl` entry.
The trigger for this mechanism was an open question (PRD Open Q2): a **hook**
(session-start / post-ship), an **MCP tool** invoked by the command, a **loop
tick**, or a combination.

## Decision

The reconcile detector is a **fail-open MCP tool** (`reconcile_learnings`) that the
`/canon:review-learnings` command invokes in **Step 1, before computing pending**
("reconcile-on-read"). The tool is the primitive; the command is the first (and, in
Increment 1, only) caller. Proactive invocation from the existing `session-watch`
loop tick is left as an additive future caller — the tool is designed to support it
but it is not wired in this increment.

The tool scans **only** the timestamped-dir review surface (not the 471 loose
CONSOLIDATE-tracked files), matches each **actionable-typed** proposal against a
resolvable on-disk target (re-contained under `project_dir`), and — only when a
conservative evidence predicate holds — moves the proposal to `applied/` and appends
an `accepted` entry citing the evidence path + commit. The predicate has two paths: a
dedicated `--diff-filter=A` **creation probe** runs first and is sufficient evidence
on its own (a commit that CREATED the target recovers even after a later, unrelated
commit churns the same file — the plain most-recent-commit view alone would
wrongly conclude the target was never created); only when no creation commit is
found does evaluation fall back to most-recent-commit, which for a modify-only
pre-existing target additionally requires the commit message to reference the
proposal or target's principle id (an unrelated churn commit to the same file is not
evidence). It is **idempotent** (re-runs are no-ops) and **fail-open** (any error
surfaces a warning and leaves state untouched; it never blocks a build or the
command).

## Alternatives considered

- **Session-start / post-ship hook.** Would touch `hooks/**`, engaging the
  sensitive-path deny-list floor for *every* future edit to the mechanism, and runs
  the reconcile even when nobody is looking at the backlog — spending work off the
  critical path and coupling reconcile timing to session lifecycle rather than to
  the moment the data is consumed. Rejected: higher blast radius, worse timing fit.
- **Loop tick only (no command wiring).** Proactive but the backlog would still be
  stale at the exact moment a user opens `/canon:review-learnings` if a tick hadn't
  fired since the last out-of-band promotion. Rejected as the *sole* trigger;
  retained as an additive future caller.
- **Inline bash in the command markdown (no MCP tool).** Not unit-testable, cannot
  emit a durable drift.db audit event, and duplicates conservative-matching logic
  the writer loop-closure path (Increment 2) also needs. Rejected: a shared,
  testable primitive is required.

## Consequences

- **Positive:** reconcile runs exactly when the data is consumed; `hooks/**` is not
  touched; the matching + move + append logic is a single tested primitive reused by
  the Increment 2 writer loop-closure path; fail-open posture matches the
  advisory-quality-gate rule (never a safety gate).
- **Negative / trade-off:** reconcile does not run proactively in Increment 1 — a
  user who never opens the command sees no auto-resolution until the future
  loop-tick caller lands. Accepted: the command *is* the backlog's consumer, so
  reconcile-on-read covers the load-bearing case.
- **Reversibility cost:** removing the mechanism means deleting the tool, its
  drift.db audit rows semantics, and the command Step-1 wiring — non-trivial but
  bounded. This cost, combined with the non-obvious "why reconcile-on-read not a
  hook" rationale and the genuine hook-vs-tool-vs-loop trade-off, is why this is a
  durable ADR rather than an ephemeral decision record.
