---
adr: "0005"
title: "orchestrator_action is a declarative signal the orchestrator consumes; the loop stays non-mutating"
status: accepted
date: "2026-06-12"
build: "add-a-first-class-orchestratoraction-directive-to-the-canon-loop"
---

# ADR-0005: orchestrator_action is a declarative signal the orchestrator consumes; the loop stays non-mutating

## Context

`ship-watch` (Canon's first real loop) surfaces new external PR review comments but is, by design, read-only — it cannot act on them. Loops are deliberately non-mutating (`guardrails.mutates_build: false`, `forbidden_tools: [Write, Edit, NotebookEdit]`, the dc-06 invariant) so they can run unattended on a cron. The user wants new review comments **auto-triaged** (read + a fix dispatched), but a fix cannot run *inside* the loop without breaking the very invariant that makes unattended scheduling safe.

The framework needs a way for a loop to express "after this transition, someone should do X" without the loop itself doing X.

## Options Considered

### Option A: Relax the non-mutating invariant so the loop dispatches the fix itself

**Pros:**
- The loop acts on its own observation in one place; no round-trip.

**Cons:**
- Breaks dc-06 / `mutates_build: false` — the safety property that lets a loop run unattended on a cron. An unattended cron that can mutate the repo is the exact risk the invariant exists to prevent.

**Canon-principle alignment:** Tensions the loop-determinism guardrail (dc-05) and the dc-06 non-mutating invariant — unacceptable.

### Option B: Document the handoff in ship-watch.md prose only

**Pros:**
- No schema change.

**Cons:**
- A one-off note specific to ship-watch; nothing validates it; no other loop can declare a follow-on action; not a reusable capability.

**Canon-principle alignment:** Weak on mechanism-ships-first-instance — it is an instance with no mechanism.

### Option C: Add an optional, schema-validated `orchestrator_action` directive that the loop DECLARES, the runner SURFACES, and the orchestrator CONSUMES

**Pros:**
- The loop and runner stay strictly read-only — the directive is a signal, not an executed action.
- Reusable and validated: any loop can declare a follow-on action from a closed (derive-from-const) vocabulary.
- Backward compatible (optional field); fail-closed on unknown values.

**Cons:**
- Indirection: the loop cannot act on its own observation — it must round-trip through the orchestrator and a cron interval.

**Canon-principle alignment:** Honors dc-06 non-mutating invariant, simplicity-first, errors-as-values, derive-from-const, mechanism-ships-first-instance.

## Decision

Chosen: **Option C — declarative `orchestrator_action` directive consumed by the orchestrator.**

Add an optional `orchestrator_action` field (closed vocabulary, derive-from-const `z.enum`) to a `surface.on_transition` rule. The non-mutating loop DECLARES the action; the read-only loop-tick runner SURFACES it as a structured `ORCHESTRATOR_ACTION:` line; the orchestrator (which is allowed to mutate) CONSUMES the signal and acts. The vocabulary is **extensible**, shipping with two initial members and three live ship-watch consumers:
- `auto-triage-fix` — on the `external_review_comment_ids` transition (new PR comments) AND the `ci_conclusion: pending → failure` transition (which keeps `terminate: true`).
- `auto-plugin-update` — on the `release_tag` transition (a tag was cut).

Adding a future member is a one-line const append plus a documented consumption contract — no validator, type, or runner changes (the runner echo is value-agnostic).

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| dc-06 non-mutating invariant | honors | Loop + runner stay read-only; `guardrails`/`forbidden_tools` unchanged; directive is signal-only. |
| simplicity-first | honors | One optional schema field + one const; no executor, no loader change, no new MCP tool. |
| errors-as-values | honors | Unknown action flows through `parseLoopDefinition`'s `{ ok:false, error }` into `list_loops` `invalid[]`; never throws. |
| derive-from-const | honors | `z.enum(ORCHESTRATOR_ACTIONS)` is the single source for the two-member vocabulary (watch_BBBBBB1 lesson). |
| mechanism-ships-first-instance | honors | Schema field + both vocabulary members + all three ship-watch consumers land in one diff. |

## Consequences

**Positive:**
- A reusable, validated, extensible capability: future loops can declare follow-on actions (and new action types) without weakening the safety invariant. Adding a member is a one-line const append + a contract paragraph; the runner needs no change (value-agnostic echo).
- The sensor/actuator split is explicit in both code (schema comment) and docs (CLAUDE.md consumption contracts).
- Two documented consumption contracts ship: `auto-triage-fix` (read trigger source → clear defect → auto-fix on the build branch; ambiguous/question/design → ask-first; never auto-merge) and `auto-plugin-update` (ASK-FIRST, never unattended: fire a PushNotification that a release tag was cut, ask user to confirm, then run plugin-update + confirm the new version is active ONLY after explicit user confirmation — running plugin-update swaps the installed plugin version mid-session, a mutating local action that must not happen unattended).

**Negative / trade-offs:**
- Indirection — the loop cannot act on its own observation; the action is bounded by the cron interval and the orchestrator's next consumption.
- Each new vocabulary entry must ship with its own documented orchestrator-consumption contract, or the directive is inert.

## Revisit-If

- The loop-tick runner is reimplemented as TypeScript returning a typed object (the action could then ride a typed field instead of a surfaced text line).
- Multiple action types accumulate such that a generic action-consumption protocol (or a `references/` fragment) is warranted over the inline CLAUDE.md contract.
- A future requirement genuinely needs a loop to act unattended — that would force a re-examination of dc-06 itself, not just this directive.
