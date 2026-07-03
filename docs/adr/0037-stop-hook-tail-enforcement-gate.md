---
adr: "0037"
title: "Tail enforcement is a harness-fired Stop hook triggered by ship-completed"
status: accepted
date: "2026-07-03"
build: "add-a-deterministic-stop-hook-tail-enforcement-gate-delta-d3-from-the"
---

# ADR-0037: Tail enforcement is a harness-fired Stop hook triggered by ship-completed

## Context

Canon's build tail — context-sync (scribe) and the learner — is enforced only behaviorally: the orchestrator is *supposed* to run it. There is no deterministic backstop that fails closed when a build "completes" with a silently-dropped or unaccounted-skipped tail step. This is the safety precondition for raising Canon's autonomy tiers (deltas D1/D2): higher tiers drop HITL checkpoints, so the floor must be guaranteed by construction.

`finalize_workspace` cannot be that backstop — it is itself a tail step and orchestrator-invoked, so it can be skipped along with the rest. The enforcement must fire regardless of orchestrator cooperation.

Empirically established (build PROBE-FINDINGS): the Claude Code `Stop` hook fires at **every** main-agent turn-end (there is no harness "build complete" event), carries `session_id`/`cwd`/`stop_hook_active`, and can block a stop via `{"decision":"block"}`. `journal.json` records `context-sync`, `ship`, `learn` as journaled tail steps in that order; `finalize_workspace` is **not** journaled. No machine-readable accepted-skip_reason enum exists — the set lives only in CLAUDE.md prose.

## Options Considered

### Option A: Orchestrator-invoked CLI gate at finalize/verify (like dead-wire-gate.sh)

**Pros:**
- Trivial; runs with orchestrator-supplied `base_commit`/`worktree_path`; no every-turn firing to tame.

**Cons:**
- Orchestrator-invoked ⇒ skippable along with the tail it checks; cannot backstop its own omission — the exact flaw this delta exists to close.

**Canon-principle alignment:** Tensions the deterministic-gate-invariant intent of a floor that holds without cooperation.

### Option B: Harness-fired `Stop` hook, `ship==completed` trigger, `session_id` detection, `stop_hook_active` loop-guard

**Pros:**
- Fires regardless of orchestrator behavior — the only uncheatable-by-construction option.
- Blocks the stop and surfaces the missing tail step to the orchestrator, which then runs it.

**Cons:**
- `Stop` fires every turn ⇒ needs a precise trigger to avoid blocking mid-build HITL pauses.
- "Fail closed" is bounded to block-once-per-cycle by the documented `stop_hook_active` loop-guard.

**Canon-principle alignment:** Honors `fail-closed-by-default` (enforcement) and the deterministic-gate invariant; `hooks-fail-closed` for unparseable state.

### Option C: `SubagentStop` hook

**Pros:** Also harness-fired.

**Cons:** Fires after *every* subagent (a build spawns many mid-flight) — enormous false-positive surface; wrong lifecycle scope.

## Decision

Chosen: **Option B — harness-fired `Stop` hook**.

The gate acts only when (1) a workspace `.lock.session_id` matches the Stop event's `session_id` (precise per-session active-build attribution), (2) the build's `ship` step is `completed` (the build is *ending* — `ship` completes exactly once, after context-sync — not pausing mid-flight), and (3) the diff is not doc-only. It then blocks if `context-sync` or `learn` is missing / skipped-with-empty-or-non-accepted reason, reading the accepted set from `hooks/lib/accepted-skip-reasons.txt`. It honors `stop_hook_active` to block-and-surface once rather than trap the user. Active-build *detection* is conservative (fail-open: no session match → no-op) so non-build sessions are never blocked; *enforcement* fails closed given a detected, shipped build.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | Detected tail violation on a shipped build blocks the stop. |
| hooks-fail-closed | honors | Unparseable journal / missing jq / unreadable allowlist → block. |
| source-shared-hook-helpers | honors | Sources `hooks/lib/canon-hook-lib.sh` for stdin JSON extraction. |
| hooks-observable-failures | honors | Suppression sites annotated or converted to `CANON WARNING:`. |
| fail-closed-by-default | tensions (resolved) | Active-build *detection* is intentionally fail-open to guarantee AC#3 zero-false-positives on chat sessions; the strict posture is scoped to enforcement given a detected build. |

## Consequences

**Positive:**
- The autonomy floor (context-sync + learner ran) is guaranteed by a harness event, not orchestrator good behavior — the precondition D1/D2 build on.
- No `mcp-server/` change; pure shell reading on-disk journal + a data file. Small blast radius.

**Negative / trade-offs:**
- "Fail closed" is bounded to block-once-per-stop-cycle (the documented loop-guard); a determined-to-skip orchestrator can proceed after one loud surfacing.
- Uses `ship==completed` as a proxy for "build ending" because no true completion event exists; a build abandoned before `ship` is out of scope (handled by reconcile/cliff-detection).
- Builds whose orchestrator recorded `session_id:"unknown"` are un-attributable and the gate no-ops on them (pre-existing provenance gap).

## Revisit-If

- The Claude Code harness adds a semantic "build complete" event — replace the `ship==completed` proxy.
- `finalize_workspace` becomes a journaled step — check it directly instead of relying on the gate's own Stop-time run.
- False positives are reported at mid-build stops (tighten the trigger), or determined-skip bypasses are observed (add a defense-in-depth finalize-time CLI invocation of the same core check).
