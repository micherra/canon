# features/loops/ — Loop Framework Bounded Context

## Purpose

Implements the Loop-as-Artifact framework's MCP layer. Loops are Canon's managed
periodic-observation artifact class — authored as `loops/*.md` files, registered
via `list_loops`, and dispatched by the orchestrator via CronCreate.

## Directory-as-Registry Invariant

The `loops/` directory at the repo root IS the loop registry. Every `loops/<id>.md`
file is a loop definition. There is no hardcoded catalog; the registry is queried
via `list_loops`. This mirrors how `principles/` is the principle registry.

## Contents

| File/Directory | Purpose |
|----------------|---------|
| `loop-schema.ts` | Zod schema + `LoopDefinition` type + `parseLoopDefinition`. Pure leaf module — no I/O. Enforces the mechanical determinism guardrail (dc-05). |
| `load-loops.ts` | `loadLoopsFromDir(dir)` — reads `loops/*.md`, parses frontmatter via `splitFrontmatter` from `shared/lib/frontmatter.ts` (was gray-matter; R0), calls `parseLoopDefinition`. Returns `{ valid, invalid, validBodies }`. Never silently drops invalid definitions. |
| `tools/list-loops.ts` | `listLoopsHandler` — loads all loops, filters to `status:active`, applies optional `lifecycle_hook` + `tier` filters. Always returns `invalid[]`. |
| `tools/get-loop-definition.ts` | `getLoopDefinitionHandler` — loads a single loop by id, returns definition + body. Used by the `/canon:loop-tick` runner. |
| `__tests__/` | Vitest unit tests: schema, loader, and tool integration tests. |

## Loader Contract

`loadLoopsFromDir(dir)` returns:
- `valid: LoopDefinition[]` — successfully parsed definitions
- `invalid: { file: string; error: string }[]` — failed definitions with filename, never dropped
- `validBodies: Record<string, string>` — markdown body (the action prompt) keyed by id

ENOENT → returns `{ valid: [], invalid: [] }` (mirrors matcher.ts ENOENT swallow).

## Mechanical Determinism Guardrail (dc-05)

Enforced at parse time in `parseLoopDefinition`:
1. `mode === "self-paced"` + `guardrails.mutates_build === true` → rejected
2. `guardrails.mutates_build === false` + forbidden tool in `observe.tools`/`observe.mcp` → rejected
   - **Bash read-only carve-out (decision loops-phase-b-01):** `Bash` is dual-use. When
     `mutates_build: false` and `Bash ∈ observe.tools`, it is admitted ONLY if
     `observe.shell_commands` is non-empty and every entry matches `READ_ONLY_SHELL_COMMANDS`.
     An empty `shell_commands` → rejected. A mutating subcommand (e.g. `git push`) → rejected,
     naming the offending command. `Write`, `Edit`, `NotebookEdit` remain unconditionally rejected —
     the carve-out is `Bash`-only.
3. `on_transition.field` not in `state.snapshot` → rejected (superRefine cross-field)
4. `id !== idFromFilename` → rejected

This guardrail predates the first self-paced loop (Phase C) — it's encoded in Phase A
so future authors cannot bypass it by omission.

## `orchestrator_action` on `TransitionRuleSchema` (Phase B+)

`orchestrator_action` — optional `z.enum(ORCHESTRATOR_ACTIONS)` field on a transition rule.
Derive-from-const: `ORCHESTRATOR_ACTIONS = ["auto-triage-fix", "auto-plugin-update", "run-learner", "run-evolve", "auto-enable-merge", "auto-update-branch", "auto-staleness-refresh"] as const`
(exported from `loop-schema.ts`). `OrchestratorAction` type derived from the same const.

- **Omitted** → `undefined` (backward compat; existing loops parse unchanged)
- **Unknown value** → Zod rejection, flows through `parseLoopDefinition` `{ ok: false }` path into `invalid[]` (fail-closed)
- **Orchestrator-consumed signal** — the loop/runner NEVER executes the action; the runner
  surfaces a structured `ORCHESTRATOR_ACTION: <action> field=<field> loop=<id>` line in Step 6
  when the transition fires; the orchestrator reads and acts on it
- See CLAUDE.md § Loop Framework, "Consuming `orchestrator_action`" for the seven consumption contracts

## `fire_on_baseline` on `TransitionRuleSchema` (ADR-0056)

`fire_on_baseline` — optional `z.boolean()` field on a transition rule, admissible **iff**
`to` is set AND `from` is unset AND `append` is not `true` AND `terminate` is not `true`,
enforced by a `superRefine` on `TransitionRuleSchema` itself (not the outer
`LoopDefinitionSchema` cross-field check — this constraint is intra-rule).

- **Omitted or `false`** → both mean "off" (no `.default()` — deliberately, so `undefined` and
  `false` stay distinguishable at the type level but identical in effect); existing loops parse
  unchanged
- **Inadmissible combination** (`append: true`, or no `to`, or `from` set, or `terminate: true`,
  with the flag `true`) → parse-time rejection, flows through `parseLoopDefinition`'s
  `{ ok: false }` path into `invalid[]` (fail-closed), never a runtime warning. The
  `terminate: true` bar (added post-review) closes a latent gap: without it, a baseline-fired
  rule could terminate the loop before it establishes a watch — the worst property a watchdog
  can have. No shipped rule combines them.
- **What it does**: on a tick with an absent prior (first tick, or the field missing from a
  partial prior snapshot), a rule carrying `fire_on_baseline: true` fires if the observed value
  already equals the rule's `to:` — the runner's one exception to the ADR-0002 first-tick guard
  (`skills/canon/commands/loop-tick.md` Step 5). Every rule without the flag keeps ADR-0002's
  default exactly: absent prior → never a transition.
- **What it does NOT bar**: the `superRefine` makes the flood/`append` and any-change noise
  sub-classes structurally inexpressible, but a to:-matching false-fire (e.g. a hypothetical
  `to: "failure"` rule) remains schema-admissible — see ADR-0056 § Consequences for the full,
  corrected statement.
- Shipped on 3 rules: `ship-watch.merge_state` (`to: BEHIND`, `to: DIRTY`) and
  `session-watch.kg_stale` (`to: "true"`)

## Phase Boundary

Phase A: schema + loader + tools + `_probe` demo loop; no production loop fires.
Phase B: `loops/ship-watch.md` added — first real loop, dispatched post-ship; `orchestrator_action` directive added (Phase B+) with two-member derive-from-const vocabulary (`auto-triage-fix`, `auto-plugin-update`) wired on three ship-watch transitions.
Phase C: self-paced mode + ScheduleWakeup + `loops/session-watch.md`; `BUILTIN_FORBIDDEN_MCP` denylist + `max_wall` schedule field added to schema (ADR-0002 first-tick-baseline invariant formalised).
Phase D: `loops/harness-watch.md` added — third real loop (post-ship, self-paced); `run-learner` added to `ORCHESTRATOR_ACTIONS` as the third vocabulary member.
Phase E: `loops/evolve.md` added — fourth real loop (session-start, self-paced, attribution-signal observer); `run-evolve` added to `ORCHESTRATOR_ACTIONS` as the fourth vocabulary member; `auto-enable-merge` added as the fifth vocabulary member (a second `ci_conclusion` rule on `ship-watch`, `pending → success`) — arms squash auto-merge on CI-green, no new loop.
Phase F: `auto-update-branch` added as the sixth vocabulary member (two new `merge_state` rules on `ship-watch`, `to: BEHIND` and `to: DIRTY`) — surfaces a stale/conflicting PR branch so the orchestrator can merge `origin/main` in and push; no new loop.
Phase G (current): `auto-staleness-refresh` added as the seventh vocabulary member (two new `session-watch` transition rules, `docs_stale_crossed`/`kg_age_crossed`, plus a body-emitted per-episode directive against a de-dupe ledger so an already-stale-at-session-start condition still fires on tick 1 — ADR-0045) — the orchestrator auto-dispatches a scribe context-sync (ephemeral `init_workspace` → scribe → shipper → PR, dec-03) for docs staleness and a local `codebase_graph` refresh for KG age, then notifies; both unattended in all tiers per a plan-approval user override of the ask-first-under-supervised posture that gates other tracked-write consumers; no new loop.

## Non-Declarative Constraint (dc-06)

A plugin CANNOT auto-start a loop. Loops run ONLY when the orchestrator calls
`CronCreate` at a named lifecycle moment. Authoring a `loops/*.md` registers the
loop's definition; it does NOT start it.
