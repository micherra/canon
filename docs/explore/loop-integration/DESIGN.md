## Status: Complete

# Loop-as-Artifact Framework — Committed-Grade Design

> Supersedes the prior two-bespoke-command design in this directory (`#1`/`#2` are
> now the first two *definitions* on a managed framework, not hardcoded watchers).
> Authority per `docs/explore/CLAUDE.md`: **Open** until the phased runbook is
> approved at the HITL gate; this doc is committed-grade (definition schema,
> registry shape, runtime wiring, phased runbook, decision records, coverage).
>
> Author: canon-architect, 2026-06-08. Pre-build — design + runbook for approval,
> no code.

## North Star

**Vision:** Loops become a **managed Canon artifact class** — authored, registered,
versioned, and instantiated the same way principles / agents / commands are.
`ship-watch` and `session-watch` are the first two definitions; the learner can
later propose new ones and a writer-style path can author them. The framework's
single job: turn an **authored declarative loop definition** into the **right
scheduling-primitive call** (`CronCreate` for interval, `ScheduleWakeup` for
self-paced) at the **right orchestrator-lifecycle moment**.

### Done criteria

```yaml
done_criteria:
  - id: DC1
    description: A declarative loop-definition format exists (markdown + YAML frontmatter, mirroring principle/agent authoring) and is documented with a template.
    testable: true
  - id: DC2
    description: A registry loads all loop definitions from a known repo location and validates them against a schema at load time.
    testable: true
  - id: DC3
    description: An orchestrator runtime layer instantiates a registered interval loop via CronCreate end-to-end (Phase A), and a self-paced loop via ScheduleWakeup (Phase C).
    testable: true
  - id: DC4
    description: ship-watch is authored AS a definition (not hardcoded) and runs the post-ship CI/release watch, tier-gated, transition-only, self-terminating.
    testable: true
  - id: DC5
    description: session-watch is authored AS a definition, self-paced, observe+surface only (no build-mutating writes), consolidating cliff-detection (#2) and staleness (#3), reusing reconcile_workspace.
    testable: true
  - id: DC6
    description: Each phase (A/B/C) ships something runnable; framework-first is not a big-bang.
    testable: true
```

### Constraints (locked by prior decisions — NOT re-litigated here)

- **Sequencing:** framework-first, phased A→B→C; each phase ships runnable. (User
  overrode harvest-after; premature-abstraction risk flagged and accepted.)
- **Firing posture:** ship-watch fires automatically in autonomous/light-touch,
  opt-in in supervised (tier-gated). (Locked.)
- **Poller scope:** session-watch's cliff concern watches **only long/backgrounded**
  dispatched steps. (Locked.)
- **Consolidation:** #2 + #3 are ONE `session-watch` definition. (Locked.)
- **Determinism:** self-paced loops are **observe+surface only** — the safe slice of
  the parked Adaptive Queen; no build-mutating writes. (Locked.)
- **Capability ground truth:** a plugin CANNOT auto-start a loop declaratively (no
  manifest field / hook / frontmatter does it). Loops run because the **orchestrator**
  (shipped CLAUDE.md behavior) calls `CronCreate` / `ScheduleWakeup` directly. The
  framework turns a definition into that call — it does not invent a new auto-start
  mechanism.

---

## ASSUMPTIONS

1. `CronCreate` (interval) and `ScheduleWakeup` (self-paced) are available to the
   orchestrator session as harness primitives (per `workflow-tool-spec.md:238` and the
   task brief). The runtime is a thin adapter over them, not a reimplementation.
2. Loop definitions are **plugin-shipped** artifacts (in the repo tree, installed with
   the plugin), like principles/agents/commands — not per-workspace runtime data.
3. The orchestrator reads loop definitions via an MCP tool (mirroring how agents read
   principles), not by raw file globbing in CLAUDE.md prose. (DR-002.)
4. `gh` is authenticated in the orchestrator's Bash context for ship-watch (carried
   over from prior Q4; still the one feasibility item to confirm — see §11 Q-A).

---

## 1. Research (ground truth — verified, not guessed)

| Finding | Source | Design consequence |
|---|---|---|
| Canon authors **every** artifact class as **markdown + YAML frontmatter** loaded from a directory: principles (`principles/**/*.md`, frontmatter `id/title/severity/scope/tags`), agents (`agents/*.md`, frontmatter `name/model/rules/references`), commands (`skills/canon/commands/*.md`, frontmatter `description/allowed-tools/model`). | `principles/conventions/*.md`, `agents/shipper.md`, `skills/canon/commands/check.md` | The loop-definition format MUST be markdown + YAML frontmatter in a `loops/` directory. No novel format. Lowest-surprise, reuses existing authoring muscle + the writer/learner paths. (DR-001) |
| MCP tools register via `mcp-server/src/app/register-*.ts`, one per feature group; tool impls live in `features/<group>/tools/*.ts`. | `mcp-server/src/app/`, `features/orchestration/tools/` | The registry-reading tool (`list_loops` / `get_loop_definition`) is a new `register-loops.ts` + `features/loops/tools/*.ts`. Follows the established seam exactly. |
| `reconcile_workspace` is read-only w.r.t. the journal, takes `source?: "resume" \| "post_subagent"`, emits fail-open `cliff_detected` only. | `features/orchestration/tools/reconcile-workspace.ts:29-33` | session-watch's cliff concern reuses it verbatim; Phase C adds `"loop"` to the enum (one-line widening) + the de-dupe ledger. |
| The shipper **stops at "PR created"** and never polls CI/release. | `agents/shipper.md` (default path step 4) | ship-watch fills a real, currently-empty gap; fired by the orchestrator post-ship, not by the (context-isolated) shipper. |
| The SessionStart staleness pulse (`session-start-kg-check.sh`) is a **one-shot**, advisory, exit-0. | `hooks/canon-agent-teams/session-start-kg-check.sh` | session-watch promotes it to a periodic concern, folded in alongside cliff-detection. |
| Inc-6 `canon-maintenance` cron is **unattended/remote/standing**, guardrailed draft-PR+notify. | `workflow-integration/SYNTHESIS.md` §4d | The framework's interval loops are **attended/session-local/self-terminating** — a different lane (DR-005, §6). The framework does NOT subsume canon-maintenance; the schema may later *also* express it, but that's out of scope (§11 Q-B). |
| The Adaptive Queen is parked because a monitor that **reconfigures a running swarm** breaks determinism; PR #309 already ratified `reconcile_workspace` as **observe+surface, auto-re-spawn stripped**. | `adaptive-queen.md` §2; project memory `graceful-handoff-phase2-cancelled` | The determinism guardrail (DR-005) is the framework rule: self-paced loops may observe+surface, never mutate the build. session-watch is the already-ratified posture, now proactively triggered. |

---

## 2. The loop-definition format (DC1)

A loop definition is a markdown file with YAML frontmatter, mirroring a principle.
It lives at `loops/<id>.md`. The frontmatter is the machine-readable contract; the
markdown body is the **action prompt** the loop re-fires each tick (the same way a
command file's body is its prompt).

### 2.1 Frontmatter schema

```yaml
---
id: ship-watch                      # kebab, unique; matches filename
title: Post-ship CI/release watcher
mode: interval                      # interval → CronCreate | self-paced → ScheduleWakeup
status: active                      # active | shadow | disabled

trigger:
  fired_by: orchestrator            # always orchestrator (capability ground truth)
  lifecycle_hook: post-ship         # named orchestrator-lifecycle moment (§4.2 table)
  firing_posture:                   # tier-gated, per locked decision
    autonomous: auto
    light-touch: auto
    supervised: opt-in

schedule:
  # interval mode:
  interval: 5m                      # CronCreate cadence; cache-window note in body
  max_ticks: 24                     # hard iteration cap (2h @ 5m)
  # self-paced mode uses these instead:
  # cadence_hint: { active: 4m, idle: 30m }   # model picks wakeup within these
  # max_wall: 0                     # 0 = bounded by termination conditions only

state:
  scope: workspace                  # workspace | session
  path: ${WORKSPACE}/ship-watch-state.json   # where the last-seen snapshot persists
  snapshot:                         # the shape it diffs against (transition detection)
    - pr_state
    - ci_conclusion
    - release_tag
    - external_review_comment_ids

observe:                            # what the action reads each tick (no mutation)
  tools: [Bash]                     # ship-watch: gh CLI; session-watch: reconcile_workspace
  mcp: []                           # session-watch: [reconcile_workspace]

surface:                            # transition-only rules: snapshot field → message
  on_transition:
    - { field: pr_state, from: open, to: merged, message: "PR #{pr} merged." }
    - { field: ci_conclusion, to: failure, message: "CI failed: {run_url}", terminate: true }
    - { field: release_tag, from: null, message: "Release {release_tag} cut — plugin-update reminder." }
    - { field: external_review_comment_ids, append: true, message: "{n} new review comments." }

terminate:
  when:
    - resolved              # named terminal state (mode-specific, defined in body)
    - max_ticks_reached
    - pr_closed_unmerged
  # self-paced adds: at_hitl_gate, at_finalize, on_cliff_surfaced

guardrails:
  mutates_build: false      # MUST be false for self-paced/observe loops (DR-005 enforced)
  forbidden_tools: [Edit, Write, get_next_escalation_strategy]   # determinism guard
---
```

### 2.2 Body

The markdown body is the **re-fired action prompt**: read the state snapshot, run
the `observe` action, diff against the snapshot, apply `surface.on_transition`
rules, write the new snapshot, then decide schedule-next-or-terminate. It also
documents the cache-window rationale and the mode-specific "resolved" definition.
Identical authoring ergonomics to a command file's prompt body.

### 2.3 Validation

A schema (Zod, in `features/loops/`) validates every definition at registry load:
`mode ∈ {interval,self-paced}`; interval requires `interval`+`max_ticks`; self-paced
requires `cadence_hint`; `guardrails.mutates_build` MUST be `false` when
`mode: self-paced` OR `observe.mcp` includes build-state tools (DR-005 mechanical
enforcement); `surface.on_transition` fields ⊆ `state.snapshot`. Invalid definitions
are dropped + logged (like an invalid principle scope), never silently half-loaded.

---

## 3. The registry (DC2) — `loops/` + `list_loops` tool

**Location:** `loops/*.md` in the repo (installed to the plugin dir), beside
`principles/`, `agents/`, `skills/`. One file per loop. This is the registry —
the filesystem directory IS the registry, exactly as `principles/` is the principle
registry. No separate catalog file to drift (DR-002).

**Reader:** a new MCP tool `list_loops` (+ `get_loop_definition({ id })`) in
`mcp-server/src/app/register-loops.ts` / `features/loops/tools/`. Returns parsed +
validated definitions. The orchestrator calls `list_loops` to discover what can be
fired at each lifecycle hook — mirroring how agents call `get_principles`. This
keeps CLAUDE.md prose free of hardcoded loop knowledge: CLAUDE.md says "at the
post-ship moment, fire any active loop whose `lifecycle_hook` is `post-ship`," and
the registry supplies the list.

**Why a tool, not CLAUDE.md prose enumerating loops:** prose enumeration is the
hardcoded-catalog anti-pattern the framework exists to kill. The tool makes adding a
loop a pure authoring act (drop a `loops/*.md`) with zero CLAUDE.md edit — which is
the precondition for the learner/writer to later propose loops (DR-002, forward-looking).

---

## 4. The runtime layer (DC3) — orchestrator wiring

The runtime is the orchestrator behavior (shipped CLAUDE.md) that, at a named
lifecycle moment, queries the registry and fires matching loops via the right
primitive. It is **not** a daemon and **not** plugin-auto-started (capability ground
truth) — it is orchestrator code-paths added to CLAUDE.md + the `list_loops` tool.

### 4.1 The instantiation step (the framework's core job)

At a lifecycle hook, the orchestrator:
1. `list_loops({ lifecycle_hook: <hook>, tier: <current> })` → active matching loops.
2. For each, resolve `firing_posture[tier]`: `auto` → fire now; `opt-in` → offer to
   the user (one line), fire on yes; `disabled`/no-match → skip.
3. **Translate definition → primitive call:**
   - `mode: interval` → `CronCreate({ schedule: <interval>, command: "/canon:loop-tick <id>", max: <max_ticks> })`
   - `mode: self-paced` → seed a `ScheduleWakeup` with the action prompt; the tick
     itself picks the next wakeup within `cadence_hint`.
4. The fired loop runs a **generic tick command** `/canon:loop-tick <id>` (one
   command for ALL loops) that: loads the definition via `get_loop_definition`, reads
   state, runs `observe`, diffs, surfaces transitions, writes state, evaluates
   `terminate`, and either reschedules or stops. **One generic runner, N definitions**
   — this is what makes loops an artifact class rather than N bespoke commands.

### 4.2 Lifecycle hooks (where the runtime taps the orchestrator)

| `lifecycle_hook` | Orchestrator moment | Loops that use it |
|---|---|---|
| `post-ship` | After ship step reports PR URL / merge (Completion Checklist §3) | ship-watch |
| `on-long-dispatch` | When orchestrator dispatches a step it expects to run long or backgrounds | session-watch (cliff concern) |
| `session-start` | Session start (could later replace the one-shot pulse) | session-watch (staleness concern) — see §7 |

Hooks are a closed vocabulary in the schema; adding a hook is a framework change, but
adding a *loop* at an existing hook is pure authoring. (DR-004 fixes where these taps
live.)

### 4.3 Generic tick runner — `skills/canon/commands/loop-tick.md`

The single re-fired command. Argument: the loop `id`. Pure framework code: it never
contains loop-specific logic — all of that comes from the definition's body + schema.
This is the artifact-class payoff: ship-watch and session-watch differ only by their
`loops/*.md` file, not by any command/runtime code.

---

## 5. ship-watch AS a definition (DC4) — proves the format (Phase B)

`loops/ship-watch.md` — the §2.1 frontmatter filled in exactly as shown above
(interval, 5m, 24-tick cap, post-ship hook, tier-gated auto/auto/opt-in, snapshot of
4 fields, the 4 transition rules incl. CI-failure-terminates). Body: gh-probe
sequence (`gh run list`, `gh pr view --json state,mergedAt,statusCheckRollup`,
`gh release list`, `gh pr view --json comments`), the "resolved" definition
(merged + CI success + release tag cut), the gh-auth degradation note, the
cache-window rationale.

**This is the framework's proving ground.** If authoring ship-watch as a definition
is awkward — if any of its behavior can't be expressed in frontmatter+body and leaks
back into the runner — the format is wrong and gets fixed *here, in Phase B*, before
session-watch is built on it. (DR-001 explicitly makes Phase B the format's
validation gate.)

---

## 6. session-watch AS a definition (DC5) — Phase C

`loops/session-watch.md` — `mode: self-paced`, `state.scope: session`, two concerns:

- **Cliff concern (primary, `lifecycle_hook: on-long-dispatch`):** `observe.mcp:
  [reconcile_workspace]` called with `source: "loop"`; snapshot is the
  `.cliff-surfaced.json` de-dupe ledger keyed `(step_id, cliff_signature)`; surfaces a
  NEW cliff once via the existing cliff→HITL pattern, then terminates; suppresses
  cliffs already in the ledger (owned by the resume/post-subagent passes) → no double
  HITL. Fires only for long/backgrounded steps (locked scope).
- **Staleness concern (secondary, lower cadence):** re-checks KG mtime / open drift /
  scribe-doc staleness on a ~30-min gate, surfacing on threshold crossing — the
  one-shot pulse, promoted. (Consolidation, locked.)

`guardrails.mutates_build: false`; `forbidden_tools: [Edit, Write,
get_next_escalation_strategy, …]` — mechanically enforced by §2.3 validation. This is
the **observe+surface safe slice** of the Adaptive Queen; the determinism line it
must not cross is *acting on* what it observes (DR-005, §8).

Phase C also adds the one-line `reconcile_workspace` `source: "loop"` enum widening +
the ledger.

---

## 7. Consolidation resolution (locked → realized)

#2 + #3 are one `session-watch` definition with two concerns, **session-scoped**
(lives the whole session; cliff concern self-disables when no long/backgrounded step
is active; staleness concern runs whenever, gated to ~30m). One wakeup budget, one
cache lane, one nag budget, one ledger. The `session-start` staleness check can later
*replace* the one-shot `session-start-kg-check.sh` pulse (the pulse becomes the
loop's first tick) — but that replacement is out of Phase C scope (flagged §11 Q-C).

---

## 8. Decision records (load-bearing choices)

Full records written to `${WORKSPACE}/decisions/`. Summarized here:

| ID | Decision | Why | Rejected alternative |
|---|---|---|---|
| **DR-001** | Loop-definition format = markdown + YAML frontmatter in `loops/`, body = re-fired action prompt. | Mirrors every existing Canon artifact class (principle/agent/command); reuses authoring + writer/learner paths; lowest surprise. Phase B validates the format with a real loop before more are built. | A bespoke JSON/TS config (novel shape, no authoring path, can't be writer-authored). |
| **DR-002** | Registry = the `loops/` directory itself, read via a `list_loops` MCP tool; NO hardcoded catalog in CLAUDE.md. | Adding a loop = dropping a file (zero CLAUDE.md edit) — the precondition for learner/writer-proposed loops. Avoids the hardcoded-catalog anti-pattern the framework exists to kill. | Enumerating loops in CLAUDE.md prose (the anti-pattern). |
| **DR-003** | Interval-first phasing: Phase A runtime supports ONLY CronCreate; self-paced/ScheduleWakeup deferred to Phase C. | Interval is the simpler primitive (fixed cadence, no model self-pacing, no determinism subtlety). Smallest slice that runs a real loop end-to-end; de-risks the framework before the determinism-sensitive self-paced mode. | Both modes in the MVP (bigger, couples the determinism-hard mode into the foundational build). |
| **DR-004** | Runtime taps the orchestrator at named `lifecycle_hook` points (closed vocabulary), via a single generic tick runner `/canon:loop-tick <id>`. | One runner + N definitions = true artifact class. Closed hook vocabulary keeps instantiation auditable; adding a loop at an existing hook is pure authoring. | N bespoke commands (the prior superseded design); or open-ended hook strings (unauditable). |
| **DR-005** | Self-paced loops are observe+surface ONLY; `guardrails.mutates_build: false` is schema-enforced; build-mutating tools are in a `forbidden_tools` list checked at load. | The safe slice of the parked Adaptive Queen; matches the already-ratified PR #309 observe→surface posture. Mechanical enforcement (not just prose) prevents a future definition from quietly crossing the determinism line. | Prose-only guardrail (drifts; a future author re-introduces auto-re-spawn). |

---

## 9. Phased runbook + task decomposition

Each phase ships something runnable (DC6). Sizes are rough; waves within a phase.

### Phase A — framework MVP (interval only) — **MEDIUM**

| Task | Files | Size | Wave |
|---|---|---|---|
| A1 Loop-definition schema + validator (Zod) | `mcp-server/src/features/loops/schema.ts` (+ test) | S | 1 |
| A2 Registry reader + `list_loops`/`get_loop_definition` tools + `register-loops.ts` | `features/loops/tools/*.ts`, `app/register-loops.ts` (+ tests) | M | 1 |
| A3 Generic tick runner command | `skills/canon/commands/loop-tick.md` | S | 2 |
| A4 Runtime wiring in CLAUDE.md: `post-ship` + `on-long-dispatch` hook taps; instantiation step (list_loops → CronCreate); template + `loops/CLAUDE.md`+`README.md` | `CLAUDE.md`, `templates/loop-definition.md`, `loops/{CLAUDE,README}.md` | M | 2 |

**Runnable at end of A:** a trivial demo interval loop (`loops/_probe.md`) fires via
CronCreate, ticks, surfaces on a fake transition, and self-terminates at max_ticks —
proving the whole interval path end-to-end.

### Phase B — ship-watch definition — **SMALL**

| Task | Files | Size | Wave |
|---|---|---|---|
| B1 Author `loops/ship-watch.md` (frontmatter + gh-probe body + state shape) | `loops/ship-watch.md` | S | 1 |
| B2 Validate format ergonomics; fix schema/runner gaps surfaced by B1 | `features/loops/*`, `loop-tick.md` (as needed) | S | 1 |
| B3 Post-ship firing in Completion Checklist (tier-gated per locked posture) | `CLAUDE.md` Completion §3 | S | 2 |

**Runnable at end of B:** ship a build, ship-watch auto-fires (autonomous/light-touch),
polls a real PR, surfaces merge/CI/release/review transitions once each, terminates.
**Gate:** if authoring ship-watch needed runner changes that leaked loop-specific
logic, the format is wrong — fix before Phase C (DR-001).

### Phase C — self-paced mode + session-watch — **SMALL-MEDIUM**

| Task | Files | Size | Wave |
|---|---|---|---|
| C1 Runtime: ScheduleWakeup support in the tick runner + schema (cadence_hint) | `loop-tick.md`, `features/loops/schema.ts` | M | 1 |
| C2 `reconcile_workspace` `source: "loop"` enum widening + telemetry thread | `features/orchestration/tools/reconcile-workspace.ts` (+ test) | XS | 1 |
| C3 De-dupe ledger `.cliff-surfaced.json` (read/check/append + finalize cleanup) | `features/orchestration/...` (+ test) | S | 1 |
| C4 Author `loops/session-watch.md` (self-paced, 2 concerns, guardrails) | `loops/session-watch.md` | S | 2 |
| C5 `on-long-dispatch` firing wiring + determinism guard doc inline | `CLAUDE.md` | S | 2 |

**Runnable at end of C:** during a build with a long/backgrounded step, session-watch
self-paces, proactively detects a mid-flight cliff, surfaces once via the existing
HITL pattern, never double-fires with resume/post-subagent, and mutates nothing.

**Total:** ~12 tasks across 3 phases; A is the heaviest (new feature group + runtime),
B is the cheapest (pure authoring + a wiring line, the framework's payoff), C carries
the one MCP enum change + ledger + the determinism-guarded self-paced mode.

---

## 10. Requirements Coverage

| Requirement (from new direction) | Disposition | Owner |
|---|---|---|
| Declarative loop-definition format (authored artifact) | covered | §2, Phase A1/A4, DR-001 |
| Registry of loop definitions | covered | §3, Phase A2, DR-002 |
| Orchestrator runtime instantiates ANY registered loop via primitives | covered | §4, Phase A2/A3/A4 + C1, DR-004 |
| Capability ground truth folded in (orchestrator calls primitives; no plugin auto-start) | covered | §0 Constraints, §4, ASSUMPTION 1 |
| Definition fields: trigger/posture, mode, cadence+caps, observe action, snapshot shape, transition rules, termination | covered | §2.1 schema |
| Forward-looking: learner proposes / writer authors loops (design for, don't build) | covered (designed, not built) | §3 (file-drop = authoring act), DR-002 |
| Framework-first, PHASED A/B/C, each phase runnable | covered | §9, DC6, DR-003 |
| Phase A = interval/CronCreate minimal slice | covered | §9 Phase A, DR-003 |
| Phase B = ship-watch as a definition, validates format | covered | §5, §9 Phase B, DR-001 |
| Phase C = self-paced + session-watch, determinism-safe, reuse reconcile_workspace | covered | §6, §9 Phase C, DR-005 |
| ship-watch tier-gated firing posture (auto/auto/opt-in) | covered (locked) | §5 frontmatter |
| session-watch watches only long/backgrounded steps | covered (locked) | §6 |
| #2+#3 consolidated into session-watch | covered (locked) | §6, §7 |
| Determinism guardrails for self-paced loops (observe+surface only) | covered | §6, §8 DR-005 |
| Two definitions specified AS definitions (prove the format) | covered | §5, §6 |
| Decision records for load-bearing choices | covered | §8 (DR-001..005) |
| Phased runbook + task decomposition with sizes | covered | §9 |
| ship-watch distinct from Inc-6 canon-maintenance cron | covered | §1 (Inc-6 row), DR-005 lane note |
| Replacing the one-shot SessionStart pulse | descoped (flagged) | §7, §11 Q-C — out of Phase C |

No requirement is dropped silently. The one descope (pulse replacement) is flagged
as an open question, not assumed.

---

## 11. Open questions (HAS_QUESTIONS)

Scope, sequencing, firing posture, poller scope, and consolidation are **already
settled** and are not re-asked. The genuinely open items:

**Q-A (feasibility, low risk):** Confirm `gh auth status` is green in the
orchestrator's Bash context. ship-watch degrades gracefully if not (surfaces
"unavailable" once, ends), so this is non-blocking — but if `gh` is interactive-only
/ SSO-expiring here, ship-watch's value is reduced and we'd weight Phase B
accordingly. **Lean:** assume green; verify at Phase B start.

**Q-B (framework scope boundary):** Should the framework's schema be designed now to
*also* be able to express the Inc-6 `canon-maintenance` cron later (unattended,
draft-PR+notify)? It's a *different lane* (attended/self-terminating vs
unattended/standing), but the definition format could express it. **Lean:** design
the schema so it *could* host it (don't special-case against it), but explicitly **do
not** build or wire canon-maintenance here — keep the two roadmaps separate per
SYNTHESIS. Confirm you want the schema left open to it vs. deliberately scoped to
attended/self-terminating loops only.

**Q-C (pulse replacement):** Should Phase C's session-watch staleness concern
**replace** the one-shot `session-start-kg-check.sh` pulse (pulse becomes the loop's
first tick), or run **alongside** it for now? Replacing removes a duplicate signal but
couples a hook deletion into Phase C. **Lean:** run alongside in Phase C (additive,
lower risk); schedule pulse retirement as a small follow-on once session-watch is
proven. Confirm.

---

### Status

DONE (committed-grade design + phased runbook; pre-build, no code).

**Artifact:** `docs/explore/loop-integration/DESIGN.md`

**Summary:** Reframed loops as a managed Canon artifact class. **Format (DR-001):**
markdown + YAML frontmatter in `loops/`, body = the re-fired action prompt — mirrors
principle/agent/command authoring exactly, so the writer/learner paths apply.
**Registry (DR-002):** the `loops/` directory itself, read via a new `list_loops` MCP
tool; no hardcoded catalog in CLAUDE.md, so adding a loop is pure authoring (the
precondition for learner-proposed loops). **Runtime (DR-004):** named orchestrator
`lifecycle_hook` taps + ONE generic tick runner `/canon:loop-tick <id>` that
translates a definition into a `CronCreate` (interval) or `ScheduleWakeup`
(self-paced) call — folding in the capability ground truth that only the orchestrator
(not a plugin manifest) can start a loop. **Phasing (DR-003, interval-first):**
A = framework MVP (schema + registry + CronCreate runtime + a probe loop),
B = ship-watch authored as a definition (the format's validation gate — fix the format
here if it's awkward), C = self-paced mode + the consolidated observe+surface
session-watch (cliff + staleness), with the `reconcile_workspace` `source: "loop"`
widening + `(step_id, cliff_signature)` de-dupe ledger. **Determinism (DR-005):**
self-paced loops are schema-enforced observe+surface only — the safe slice of the
parked Adaptive Queen, matching the ratified PR #309 posture. ~12 tasks, each phase
runnable. Three open questions (gh feasibility; whether to leave the schema open to
hosting canon-maintenance later; pulse-replace-vs-alongside) — all with leans; all
prior-locked decisions left untouched.
