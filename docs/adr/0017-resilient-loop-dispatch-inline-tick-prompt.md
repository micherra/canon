---
adr: "0017"
title: "Loop dispatch uses a self-contained inline tick prompt, not the /canon:loop-tick slash command"
status: accepted
date: "2026-06-12"
build: "make-the-canon-loop-framework-croncreateschedulewakeup-dispatch"
---

# ADR-0017: Loop dispatch uses a self-contained inline tick prompt, not the /canon:loop-tick slash command

## Context

Canon's loop framework dispatched a tick by having the orchestrator call `CronCreate({ command: "/canon:loop-tick <id>" })` (interval loops) or `ScheduleWakeup({ prompt: "/canon:loop-tick <id>" })` (self-paced loops). This assumed `/canon:loop-tick` was a live harness slash command in the running session — registered via the `commands` field in `.claude-plugin/plugin.json`.

On a stale plugin install — the common case, because the directory-marketplace is keyed on the `plugin.json` version string and command registration landed in a later version than what is typically installed — that command is NOT live. Every cron/wakeup tick then fired a prompt the harness parsed as an unknown slash command: `Unknown command: /canon:loop-tick` + `Args from unknown skill: <id>`, and the tick body never ran. Observed live on 2026-06-12 for PRs #387 and #393 (the loop framework's first production live-fire); both crons had to be cancelled. This is an instance of the plugin-install-staleness class.

`get_loop_definition({ id })` is an always-available registered Canon MCP tool (not a slash command) that returns the loop's parsed `{ definition, body }`. The `/canon:loop-tick` runner body itself begins by calling exactly this tool — so the slash command and an inline prompt that loads the definition do the same work; only the invocation mechanism differs.

## Options Considered

### Option A: Inline-only self-contained tick prompt

The dispatch prompt is a short self-executing instruction that calls `get_loop_definition({ id })` to load the loop body, then executes that body's observe → diff → surface → write → evaluate pipeline. No slash command involved.

**Pros:**
- Works on fresh AND stale installs — depends only on the always-available MCP tool.
- No branch, no registration probe, no fallback path, no silent-failure mode.
- DRY: loads the definition and references the `loop-tick.md` runner body as the step source rather than copying the step list.
- Applies uniformly to interval dispatch, self-paced dispatch, and the self-paced re-arm.

**Cons:**
- The dispatch prompt is a ~4-line instruction at each citation site instead of a clean one-line `/canon:loop-tick <id>` slash call — more verbose.

**Canon-principle alignment:** honors simplicity-first (no probe branch), dc-06 (loop semantics unchanged), mechanism-ships-first-instance (ship-watch's post-ship tap demonstrates it).

### Option B: Check-first — probe registration, else fall back to inline

Before scheduling, the orchestrator detects whether `/canon:loop-tick` is registered; if so it uses the slash form, else the inline form.

**Pros:**
- Preserves the clean one-line slash form where the command is registered.

**Cons:**
- No orchestrator-side command-registry probe exists; the harness exposes no such capability (grep of `references/` + `CLAUDE.md` found none).
- Adds a branch and a new failure mode (probe wrong → silent no-run) for zero benefit — the inline form already works on both install states, so there is nothing to branch on.

**Canon-principle alignment:** tensions simplicity-first (adds a branch plus a capability that does not exist).

## Decision

Chosen: **Option A — Inline-only self-contained tick prompt.**

The inline form works identically on fresh and stale installs, so a registration check branches on a distinction that does not change the outcome — pure complexity for a capability the harness does not provide. The `/canon:loop-tick` slash command is preserved as the registered-install convenience form (additive resilience, not a removal): operators on a registered install may still invoke it by hand, and it does exactly what the inline prompt does.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | One inline form; no availability-probe branch; no duplicated steps. |
| dc-06 (non-mutating loops) | honors | Changes dispatch only; loop observation/surface/terminate semantics and the schema-enforced determinism guardrail are untouched. |
| mechanism-ships-first-instance | honors | ship-watch's post-ship tap is rewritten to the resilient inline form in the same build that introduces the mechanism. |
| DRY / single-source-of-truth | honors (minor tension) | Steps live once in `loop-tick.md` + each loop body; `get_loop_definition` is the one loader. The short 4-line pointer-prompt text recurs across doc sites — irreducible doc-duplication of a pointer (not the step list), kept minimal. |

## Consequences

**Positive:**
- Loops dispatch reliably on any install — the framework's first production live-fire failure mode is closed.
- The dispatch shape is self-documenting: a reader sees the actual tick mechanism (load def → run body) rather than an opaque slash call.

**Negative / trade-offs:**
- Each dispatch citation carries a ~4-line inline prompt instead of a one-line slash call.
- The slash form is now the secondary (convenience) mechanism; a contributor must not "simplify" the inline dispatch back into a bare `/canon:loop-tick <id>` slash call — doing so re-introduces the staleness bug. This ADR is the guard against that regression.

## Revisit-If

- The harness exposes a reliable, cheap command-registration probe AND inline verbosity becomes a measured problem — a check-first form could then be reconsidered, with inline remaining the fallback.
- A future harness guarantees plugin-command freshness on every session (the install-staleness class is solved upstream), making the slash form safe as the sole dispatch mechanism.
