---
adr: "0065"
title: "The T2 live-forward recorder fires as a server-side write_review side-effect, structurally fire-and-forget"
status: accepted
date: "2026-07-21"
build: "fix-t2-live-forward-checker-recorder-under-firing-backfill-lost-records"
---

# ADR-0065: The T2 live-forward recorder fires as a server-side write_review side-effect, structurally fire-and-forget

## Context

The T2 live-forward checker records advisory measurement data
(`.canon/t2-probe/checker-runs.jsonl`) comparing what a reviewer saw against what a
forward-looking checker finds. Its invocation was specified only as a prose behavioral
obligation in a single root `CLAUDE.md` bullet ("Post-Step Effects → After reviewer"),
invoked by the orchestrator as a background `npx tsx record.ts ... --root {main_repo_root}`
command. Nothing mechanically enforced it, nothing observed whether it happened, and a
read-only investigation (2026-07-21) measured a **50% firing rate** (4 records against 8
in-scope reviews). Three concurrent orchestrator sessions diverged on the same day with the
same corpus — the signature of an unenforced behavioral obligation. Every missed record is
permanently unrecoverable once its worktree is pruned.

The invocation also carried a proven-live `--root` misroute hazard: omitting `--root` (which
the `record.ts` header showed as optional) routes the record into the CWD worktree's
`.canon/` instead of the main checkout, where it is destroyed at worktree teardown.

The fix must make invocation a mechanical consequence of the review completing, resolve the
persistence root server-side, and make firing observable — under one hard constraint: **the
recorder must never be able to break a build.** The natural host, `write_review`, sits on the
ADR-0043 fail-closed write-receipt gate path, so an advisory instrument acquiring the power to
fail a mandatory artifact gate would be a strictly worse defect than the one being fixed.

## Options Considered

### Option A: write_review app-handler side-effect (server-side)

The `handleWriteReviewCall` app handler, after `writeReview(...)` returns ok and only when
`input.step_id === undefined` (the canonical review write — jurors pass `step_id` and are
excluded), resolves `projectDir = resolveScope(extra)` (the main checkout),
`worktree = {workspace}/worktree`, and `base = store.getBoard()?.base_commit`, then
fire-and-forget-spawns the recorder with `--root {projectDir}`. Isolation is structural:
`spawn(..,{detached:true,stdio:'ignore'})` + `child.on('error', noop)` + `child.unref()`,
the whole call wrapped in `try/catch`.

**Pros:**
- Fires on the canonical review write with no orchestrator call — closes the 50%-firing
  omission mode at its root.
- `--root` = server-resolved main checkout ⇒ the misroute is impossible by construction, not
  by documentation.
- The app handler already holds `extra`/`getDriftDb` and already runs a post-write
  side-effect (`reconcilePredictions`); the pure `write-review.ts` tool body stays a pure
  writer.
- Isolation is unit-provable by injecting a failing recorder seam (byte-identical ToolResult).

**Cons:**
- Couples the review artifact path to the T2 measurement program (mitigated by hosting the
  trigger in the composition/app layer, not the pure tool).

**Canon-principle alignment:** honors deep-modules (tiny `triggerT2Recorder` interface hides
all spawn detail), validate-at-trust-boundaries (server-side existence-checked inputs),
compute-effect-separation; a DELIBERATE documented fail-open exception to
fail-closed-by-default (the recorder is an observation instrument, never a gate).

### Option B: PostToolUse hook keyed on write_review

**Pros:**
- Loose coupling; a hook's failure cannot fail the MCP tool.

**Cons:**
- Fires in the orchestrator process with an unpredictable CWD → the `--root` misroute
  RETURNS unless the hook re-derives root in bash (re-opens the very hazard being fixed).
- Fires on every `write_review` including juror step-scoped calls → N records per jury review
  unless gated in bash.
- Cannot see `base_commit`/`worktree_path` (absent from the tool input) without reading the
  journal/store in bash — fragile.

**Canon-principle alignment:** tensions validate-at-trust-boundaries and simplicity.

### Option C: New orchestrator-called MCP tool

**Pros:** explicit contract.

**Cons:** re-encodes today's prose obligation as "call this tool" — still orchestrator-
remembered, so it fails the "no prose bullet" requirement by construction.

## Decision

Chosen: **Option A — write_review app-handler side-effect, structurally fire-and-forget.**

Only Option A satisfies all three requirements together (mechanical firing, server-side root
resolution, never-break-a-build). Server-side root resolution is the structural cure for the
misroute; hosting the trigger in the app handler reuses existing infrastructure while keeping
the pure tool pure; and the detached-child boundary keeps the fail-open instrument
structurally separable from the fail-closed gate it hangs off. A probe reproduced both the
hazard (omitting the child `'error'` listener escalates an async ENOENT to `uncaughtException`
and exits the host non-zero) and the fix (the no-op listener + unref makes the host exit 0 and
the child survive host exit), so AC-5's guarantee is proven, not asserted.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | deliberate exception | The recorder is an observation instrument, never a gate — intentionally fail-open, same class as the evaluator gate; the write-receipt gate it hangs off stays fail-closed, kept separable by the detached-child boundary. |
| deep-modules | honors | `triggerT2Recorder(opts): boolean` — small interface, hides all spawn/isolation detail. |
| validate-at-trust-boundaries | honors | `base_commit`/`worktree` resolved and existence-checked server-side; unresolvable ⇒ skip (no worse than status quo), never throw. |
| grey-box-module | honors | Failure-injection byte-identity test is the trust contract, specified before the body. |
| probe-before-build-invoke-not-infer | honors | Isolation and misroute cure verified by probe (PROBE-FINDINGS Probe 3), not inferred. |

## Consequences

**Positive:**
- Firing becomes a mechanical consequence of the canonical review write — the 50%-firing
  omission mode is closed at its root.
- The `--root` misroute is eliminated by construction.
- A recorder crash/timeout/missing-binary/unwritable-path can never change the host
  ToolResult or the host process exit code (proven by test).
- Per-build observability via `write_review`'s `t2_recorder_triggered` result +
  `finalize_workspace`'s `t2_non_firing[]` advisory (gate_non_evaluations style).

**Negative / trade-offs:**
- The review artifact handler now carries a T2-specific side-effect branch — a coupling a
  future contributor would not expect without this record.
- The observability annotation (`t2_recorded` in the review-step outcome) still depends on the
  orchestrator threading `t2_recorder_triggered`; if it forgets, the record is still written —
  only the advisory is lost. Firing is never gated on the annotation.

## Revisit-If

- `write_review` is ever moved off the ADR-0043 fail-closed path (the coupling rationale
  weakens).
- A second measurement instrument needs the same post-review hook — extract a general
  post-review side-effect registry rather than growing bespoke branches.
- Node changes detached-child error semantics such that the `on('error', noop)` + unref
  isolation no longer holds (the failure-injection test would catch this).
- The T2 live-forward program is retired.
