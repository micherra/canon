---
adr: "0016"
title: "finalize_workspace performs no destructive teardown; teardown is post-merge only"
status: accepted
date: "2026-06-13"
build: "fix-finalizeworkspace-so-it-does-not-delete-the-canonslug-git-branch"
---

# ADR-0016: finalize_workspace performs no destructive teardown; teardown is post-merge only

## Context

`finalize_workspace` runs in the orchestrator Completion Checklist BEFORE
context-sync and ship (sequence: finalize → context-sync → ship). When the build
journal reaches `complete === true` (no `planned`/`started` steps remain, no
skip-reason gaps, no missing expected artifacts), finalize called
`archiveAndDeleteWorkspace`, which performed `git worktree remove --force`,
`git branch -D canon/<slug>`, and `rmSync(workspace)`.

Because finalize runs pre-ship, this destroyed the branch and worktree the shipper
needs to push from — a per-build work-loss risk. It was observed live on PR #383,
where the `canon/<slug>` branch was deleted before ship and recovery required
locating the dangling merge commit by SHA and recreating the branch by hand. Work
survived only because the commit object had not yet been garbage-collected.

The orchestrator's documented contract already says the shipper "must NOT run
`git worktree remove`" and "do NOT delete build branch" — branch/worktree teardown
belongs to the post-merge path. finalize was violating that contract on every
build that reached completeness before ship.

The janitor (`pruneWorkspacesTask`) already performs the identical teardown trio
for post-ship/abandoned workspaces, gated on `.lock` absence and
`max_abandoned_workspace_age_hours`.

## Options Considered

### Option A: Stop worktree-remove + branch -D, but keep `rmSync(workspace)`

**Pros:**
- Smallest diff; preserves workspace-dir cleanup at finalize.

**Cons:**
- `rmSync(workspace)` pre-ship deletes `journal.json`, `plans/`, `reviews/`,
  `decisions/` — artifacts the scribe (context-sync) and shipper still consume
  AFTER finalize. This is the same class of pre-ship-destruction bug, merely
  narrower. A partial fix that leaves a second work-loss edge.

**Canon-principle alignment:** tensions `observable-best-effort` (silent partial
teardown) and `define-errors-out-of-existence` (the bug class persists).

### Option B: finalize performs NO destructive teardown — archive (copy) + verify + claims-release + analytics only

**Pros:**
- Structurally correct: finalize is a pre-ship verification/archival step and must
  never destroy build state.
- Closes BOTH the branch-delete and the workspace-dir-delete pre-ship hazards.
- Matches the documented Completion Checklist contract.
- Teardown already has a correct home (janitor post-ship; orchestrator
  direct-merge `git branch -d`).

**Cons:**
- On a default install (`max_abandoned_workspace_age_hours: null`), the janitor
  never prunes, so the worktree + local branch + workspace dir persist post-ship
  until manual cleanup or config opt-in — a bounded disk cost.

**Canon-principle alignment:** honors `simplicity-first`, `observable-best-effort`,
`define-errors-out-of-existence`.

## Decision

Chosen: **Option B — finalize performs no destructive teardown.**

`archiveAndDeleteWorkspace` is reduced to archive-only (copy artifacts to the
archive dir). The worktree-remove, `branch -D`, and `rmSync(workspace)` are
removed. Any teardown there is structurally wrong because finalize runs pre-ship;
removing the whole misplaced responsibility (rather than reordering it) is simpler
and eliminates the entire bug class. The deferred teardown is made observable in
the finalize response (`teardown_deferred` + `teardown_owner`) so the new behavior
is self-documenting and a future maintainer does not "fix" it by re-adding the
teardown.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | Removes a misplaced responsibility; net-negative LOC in the hub file. |
| observable-best-effort | honors | Deferred teardown reported via `teardown_deferred`/`teardown_owner`, not silently dropped. |
| define-errors-out-of-existence | honors | No teardown in finalize ⇒ pre-ship teardown bug class cannot recur. |

## Consequences

**Positive:**
- The shipper always finds the `canon/<slug>` branch and worktree intact.
- The pre-ship work-loss hazard is structurally closed, not merely reordered.
- The finalize response self-documents that teardown is deferred and who owns it.

**Negative / trade-offs:**
- The three tests in `orchestration-journal-worktree.test.ts` that asserted the
  old teardown are inverted — a reviewer reading git history needs this ADR to
  understand why the previously-"correct" assertions were flipped.
- The janitor now reads each candidate's `journal.json` to prove ship-completion
  before reclaim (see Amendment) — a small per-candidate cost on its periodic run.

## Amendment — Post-merge reclaim is gated on the ship-completed journal signal (decision finalize-04)

This ADR was amended during plan approval: the user required AC#5 to be fully
covered (no orphaned worktrees/branches/dirs after ship on a default-config
install), rather than accepting the deferral as a bounded disk cost. The teardown
finalize no longer performs is now reclaimed by the janitor automatically — but
the reclaim signal had to be chosen carefully.

The janitor's existing eligibility keyed on `.lock` absence + directory mtime age,
and `max_abandoned_workspace_age_hours` defaulted to `null` (off). An empirical
probe (PROBE-FINDINGS Finding 6) proved that simply setting a non-null default age
would REAP an in-flight-but-idle build (PR open, no commits beyond the threshold),
reintroducing the exact work-loss bug this ADR closes — because nothing writes
`.lock`, so age was the sole key.

**Chosen reclaim gate:** a workspace is reclaim-eligible only when its OWN
`journal.json` shows a `ship` step with `status: "completed"` (primary,
git-state-independent proof of post-ship), AND `.lock` is absent (unchanged), AND
it is older than `max_abandoned_workspace_age_hours` (now defaulted to `24` as a
secondary buffer, never the sole key). The probe confirmed this gate is false on an
in-flight build (never reaped) and true on a shipped build (reaped). This honors
`fail-closed-by-default` (no ship signal ⇒ no reclaim) and keeps the janitor
network-free (no `gh`/merge detection). The finalize `teardown_owner` string names
this active reclaim path.

## Revisit-If

- A workspace gains a reliable `.lock` writer — the lock could then become the
  primary liveness signal and the ship-completed gate could be reconsidered.
- The `ship` step id is renamed — the `isShipComplete` literal in the janitor must
  track it (a silent rename would disable reclaim, accumulating orphans again).
- A merge-state signal (reclaim only after PR MERGE, not PR creation) is wanted —
  that requires `gh`/git merge detection, explicitly avoided here to keep the
  janitor network-free.
- A future change needs finalize to run AFTER ship — then the teardown could
  legitimately live there again, superseding this ADR.
