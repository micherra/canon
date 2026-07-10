---
adr: "0045"
title: "Session-start staleness auto-refresh: ledger-emitted directive + ephemeral-workspace scribe→PR dispatch"
status: accepted
date: "2026-07-10"
build: "extend-session-watch-loop-to-observe-doc-staleness-and-kg-age-at"
---

# ADR-0045: Session-start staleness auto-refresh mechanism

## Context

At session start Canon's SessionStart hooks surface two standing staleness conditions and ask the
human to act: docs stale (N commits since the last scribe context-sync) and KG stale (knowledge
graph older than 24h). Today they are observed-and-surfaced but never acted on. The user asked for
this to be handled automatically: observe → auto-dispatch a scribe context-sync + a `codebase_graph`
refresh unattended → notify, triggered by the session-start loop (not a cron routine), under the
read-only-runner constraint (dc-06).

Two hard problems shape the design:

1. **The already-stale-at-arm-time case is the primary case.** Docs/KG are typically already stale
   when a session opens (commits accumulated while away). ADR-0002's first-tick-baseline guard makes
   an already-true condition NOT a transition, so a pure `on_transition` directive is missed on tick 1
   and may never fire in-session. The loop-definition template flags this explicitly as "not available
   in Phase C."
2. **Unattended means unattended writes to tracked `CLAUDE.md`, with no build worktree.** A normal
   scribe runs inside a build worktree and commits `docs(context-sync):`; a session-start refresh is
   not a build. Memory invariant: NEVER direct-push to main.

## Options Considered

### Option A: Pure `on_transition` directive + direct-on-main scribe

**Pros:** Fully declarative; no ledger; no workspace machinery.

**Cons:** Misses the already-stale-at-start case (ADR-0002) — fails the primary requirement.
Direct-on-main scribe violates no-direct-push-to-main.

**Canon-principle alignment:** Tensions `fail-safe-defaults` and the no-direct-push-to-main memory.

### Option B: Framework seed-baseline extension + ephemeral-workspace scribe→PR

**Pros:** Declarative tick-1 firing via a per-field `initial:` seed on the snapshot schema.

**Cons:** Changes the generic loop runner + loop schema that every loop shares — large blast radius
for a single feature; a shared-runtime change to satisfy one loop.

**Canon-principle alignment:** Tensions `simplicity-first` (broad change for narrow need).

### Option C: Ledger-emitted directive (mirrors cliff) + ephemeral-workspace scribe→PR + local KG refresh

**Pros:** Tick-1 already-stale detection via a persisted de-dupe ledger, reusing the exact pattern the
same loop already uses for cliffs (`.cliff-surfaced.json`) — no framework/runner/schema change for the
tick-1 semantics. Doc-sync reuses existing build-tail machinery (`init_workspace` → scribe → shipper →
PR), respecting no-direct-push-to-main; KG refresh is a plain local `codebase_graph` call. Runner stays
read-only (dc-06); orchestrator is the sole mutator, mirroring `auto-enable-merge`/`auto-update-branch`.

**Cons:** The directive is body-emitted against the ledger rather than a pure declarative rule (slightly
less declarative); adds one `ORCHESTRATOR_ACTIONS` member and three read-only allowlist entries.

**Canon-principle alignment:** Honors `simplicity-first`, `reuse-existing-patterns`, dc-06, and the
no-direct-push-to-main invariant.

## Decision

Chosen: **Option C.**

Extend `session-watch` (not a new loop). Observe doc-staleness (commits-since-scribe via allowlisted
`git log`/`git rev-list`) and KG-age (mtime via `stat`, hook-aligned 24h / `CANON_KG_STALE_SECONDS`).
Emit `ORCHESTRATOR_ACTION: auto-staleness-refresh field=<docs_stale|kg_age> loop=session-watch` from
the body against a persisted de-dupe ledger (`.staleness-refreshed.json`) so an already-stale session
start fires on tick 1, once per staleness episode. The orchestrator consumes the directive:
`field=kg_age` → local `codebase_graph` refresh (unattended all tiers); `field=docs_stale` → ephemeral
`init_workspace` → scribe (`before=<last-scribe sha>`, `after=HEAD`, git-diff-only) → shipper → PR to
main (unattended in autonomous/light-touch; ask-first under supervised). Notify after actions complete.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | No shared-runner/schema change for tick-1; reuses cliff ledger + build-tail machinery |
| reuse-existing-patterns | honors | Directive/consume split mirrors `auto-enable-merge`/`auto-update-branch`; dispatch mirrors `auto-triage-fix` |
| dc-06 (read-only runner) | honors | `guardrails.mutates_build: false`; no mutating command in `observe.shell_commands`; orchestrator is sole mutator |
| least-privilege | honors | Only three genuinely read-only commands added to the allowlist |
| fail-safe-defaults | honors | Tracked-write (doc-sync) path keeps ask-first under supervised; PR is a review gate |
| no-direct-push-to-main (memory) | honors | Doc-sync delivered as a PR, never a direct main commit |

## Consequences

**Positive:**
- Already-accumulated staleness is caught at session start (tick 1), not just on later edges.
- No change to the generic loop runner or loop schema's structural contract (only const/allowlist additions).
- The refresh is a normal PR — reviewable, `auto-enable-merge`-armable, revertable.

**Negative / trade-offs:**
- Body-emitted directive is slightly less declarative than a pure `on_transition` rule.
- A session-start doc-sync spins a full mini-flow (init→scribe→ship); mitigated by an idempotency guard
  (skip if an open `staleness-refresh` PR already exists for the episode) and once-per-episode ledger de-dup.
- `loop-schema.ts` is sensitive-path (mcp-tool-contract) → build is supervised + adversarially re-reviewed.

## Amendment — Doc-sync unattended in all tiers, not ask-first under supervised (decision dec-04 override)

This ADR was amended during plan approval: the user explicitly overrode dec-04's original tier-posture
split (KG unattended all tiers; doc-sync ask-first under supervised) so that **both** fields are
unattended in ALL tiers — autonomous, light-touch, AND supervised. Stated reasoning: the delivered PR
itself remains a full human review gate regardless of tier, so unattended dispatch only skips the
pre-dispatch ask, never the merge decision.

This supersedes, for `field=docs_stale`:
- The Decision section's tier clause ("unattended in autonomous/light-touch; ask-first under
  supervised") — now unattended in all tiers.
- The `fail-safe-defaults` row in Canon-Principle Alignment — the ask-first-under-supervised safety
  net no longer applies to the tracked-write path; the PR review gate is the sole remaining safety
  net for that path in every tier.

`references/loop-framework.md` and `CLAUDE.md`'s `auto-staleness-refresh` consumer contract document
the amended (all-tiers-unattended) posture, not the original dec-04 split recorded above.

## Revisit-If

- The generic loop runner gains a first-class "surface-already-true-at-arm-time" (seed-baseline) capability
  — then the body ledger for staleness can collapse into a declarative rule (Option B becomes cheap).
- The session-start doc-sync PRs prove noisy in practice (a PR per session despite de-dup) — tighten the
  episode signature or raise the commits threshold.
- A read-only KG-age MCP tool appears — then `stat`/`date` can be dropped from the shell allowlist.
