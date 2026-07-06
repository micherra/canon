---
name: loop-framework
description: >-
  Full Canon loop dispatch framework. Covers command registration, resilient
  dispatch, lifecycle-hook vocabulary and code, phase history, post-ship tap,
  session-start tap, non-declarative invariant, orchestrator_action consumption,
  and the six named consumers (auto-triage-fix, auto-plugin-update, run-learner, run-evolve, auto-enable-merge, auto-update-branch).
---

# Loop Framework <!-- last-updated: 2026-07-06 -->

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Full loop dispatch protocol — read BEFORE dispatching any loop or consuming an `ORCHESTRATOR_ACTION` line. See `CLAUDE.md` § Loop Framework for the inline residue (tick prompt, dc-06 invariant, lifecycle-hook vocab, named-consumer one-liners).

**Command registration:** `/canon:loop-tick` (and all `/canon:*` slash commands under `skills/canon/commands/`) are registered as harness plugin commands via the `commands` field in `.claude-plugin/plugin.json` (`"commands": ["./skills/canon/commands/"]`). `/canon:loop-tick` is the **registered-install convenience form** of the tick — it works when the command is live in the running session. The default documented dispatch is the self-contained inline prompt (see Resilient dispatch below), which works on both fresh and stale installs. Registration (via the manifest) is distinct from scheduling (via `CronCreate`); dc-06 is preserved.

**Resilient dispatch (ADR-0017):** The canonical tick prompt for loop `<id>` is:
```
Run one tick of Canon loop "<id>": call get_loop_definition({ id: "<id>" }) to load its
definition + body, then execute that body's observe → diff → surface → write → evaluate
pipeline (the steps in skills/canon/commands/loop-tick.md), using the loop's state.path
(substitute ${WORKSPACE}) for the prior snapshot. Read-only observation only (dc-06).
```
This inline prompt depends only on `get_loop_definition` — an always-available registered MCP
tool — and therefore works on both fresh and stale plugin installs. There is no
orchestrator-side probe for command registration, and no check-first branch is used; the
inline form works uniformly, so no fallback logic is needed (Q1 inline-only decision, ADR-0017).
`/canon:loop-tick <id>` (the slash command) is the registered-install convenience form;
contributors must not "simplify" the inline dispatch back to a bare slash call.

**Lifecycle-hook vocabulary:** `post-ship` | `on-long-dispatch` | `session-start`.
At such a moment, the orchestrator calls:
```
list_loops({ lifecycle_hook, tier })
# → for each interval loop with firing_posture[tier] === "auto":
CronCreate({ schedule: "<interval>", command: "<inline tick prompt — see Resilient dispatch above>", max: <max_ticks> })
# → for each self-paced loop with firing_posture[tier] === "auto":
ScheduleWakeup({ delaySeconds: <initial_delay>, reason: "Starting <id>", prompt: "<inline tick prompt — see Resilient dispatch above>" })
# → for each loop with firing_posture[tier] === "opt-in": ask user, then dispatch
```

**The non-declarative constraint (dc-06):** Nothing auto-starts. Only the orchestrator
initiates the scheduling call (`CronCreate` or `ScheduleWakeup`) at a named lifecycle moment.
No manifest, hook, or command frontmatter starts a loop — the capability ground truth is that
a plugin cannot do this.

**Phase history:** Phase A shipped the framework spine — schema, registry, MCP tools, `_probe`
demo; no production loop ran. Phase B ships `loops/ship-watch.md` — the first real loop,
dispatched via the post-ship tap. Phase C ships session-watch + self-paced mode.
Phase D ships harness-watch — the accumulated-build-signal observer, fired post-ship, surfaces `run-learner`.
Phase E ships evolve — the session-start attribution-signal observer, surfaces `run-evolve`.
Discovery: `list_loops`.

**Post-ship tap (Phase B+):** After the shipper creates the PR, the orchestrator calls
`list_loops({ lifecycle_hook: "post-ship", tier })`. For each returned loop, branch on `loop.mode`:
- `firing_posture[tier] === "auto"`:
  - `mode: "interval"` → call `CronCreate({ schedule: loop.schedule.interval, command: "<inline tick prompt for <id> — see Resilient dispatch above>", max: loop.schedule.max_ticks })` immediately.
  - `mode: "self-paced"` → call `ScheduleWakeup({ delaySeconds: <loop initial cadence>, reason: "Starting <id> at post-ship", prompt: "<inline tick prompt for <id> — see Resilient dispatch above>" })` immediately.
- `firing_posture[tier] === "opt-in"` → offer the watch to the user first; dispatch by mode on confirmation (CronCreate for interval, ScheduleWakeup for self-paced).
- `firing_posture[tier] === "disabled"` → skip silently.

`ship-watch` is the first loop this tap fires (autonomous/light-touch → auto, supervised → opt-in). It demonstrates the resilient inline dispatch form (mechanism-ships-first-instance, dc-06). `harness-watch` is a self-paced post-ship loop and is dispatched via `ScheduleWakeup`.

**Session-start tap (Phase C+):** At session start, the orchestrator calls
`list_loops({ lifecycle_hook: "session-start", tier })`. For each returned loop:
- `firing_posture[tier] === "auto"` → start it now via `ScheduleWakeup` (self-paced mode):
  ```
  ScheduleWakeup({ delaySeconds: <initial_active_delay>, reason: "Starting <id> at session-start", prompt: "<inline tick prompt for <id> — see Resilient dispatch above>" })
  ```
- `firing_posture[tier] === "opt-in"` → offer the watch to the user first; call `ScheduleWakeup` only on confirmation.
- `firing_posture[tier] === "disabled"` → skip silently.

`session-watch` is the first loop this tap fires (autonomous/light-touch → auto, supervised → opt-in).
`evolve` is also a session-start loop (autonomous/light-touch → auto, supervised → opt-in); it observes
accumulated attribution signal and surfaces `run-evolve` when gate-eligible targets exist.

**Non-declarative invariant (dc-06):** Only the orchestrator initiates `CronCreate` or
`ScheduleWakeup`. Authoring `loops/session-watch.md` only registers the definition — it does
NOT start the loop. No manifest field, hook script, or command frontmatter can trigger
scheduling automatically.

**Consuming `orchestrator_action` (Phase B+):** When a `/canon:loop-tick` run surfaces a line
`ORCHESTRATOR_ACTION: <action> field=<field> loop=<id>`, the orchestrator (which is allowed to
mutate — the loop is not) consumes it. The loop/runner only declared and surfaced the signal;
acting is the orchestrator's job. dc-06 holds: `orchestrator_action` is a declarative signal the
orchestrator consumes, NOT something the loop or the loop-tick runner executes. The loop's
`guardrails.mutates_build` stays `false`.

**`auto-triage-fix`** (fires on the `external_review_comment_ids` transition and the CI
`pending → failure` transition):
1. Reads the trigger source — the new PR comment(s) for the comment transition, or the failing
   CI job logs (`gh pr checks` / run logs) for the CI transition.
2. If a CLEAR actionable defect → dispatches a fix flow (engineer → re-run verify gates → push
   to the build branch) WITHOUT asking first.
3. If AMBIGUOUS / a question / design-level pushback → surfaces with a proposed approach and
   ASKS first.
4. NEVER auto-merges the PR (arming auto-merge is the separate, CI-green-gated
   `auto-enable-merge` consumer's job, not auto-triage-fix's).

**`auto-plugin-update`** (fires on the `release_tag` transition): **ASK-FIRST, never unattended.**
On a release tag being cut:
1. Fire a `PushNotification` that a release tag was cut.
2. ASK the user to confirm before running `plugin-update` (this is a mutating local action that
   must not happen unattended — it swaps the installed plugin version mid-session).
3. Run `plugin-update` + confirm the new version is active ONLY after explicit user confirmation.
NEVER silently run plugin-update; the ask-first/confirm requirement is non-optional.

**`run-learner`** (fires on the `harness-watch` `learner_due` false→true transition): The
orchestrator spawns `canon:learner` per the learn-step protocol. Under the `supervised` tier,
ASK the user first before spawning; under `autonomous` and `light-touch`, spawn the learner
automatically. The learner pass NEVER mutates the build — it only analyzes patterns and writes
to `.canon/`. dc-06 holds: the `harness-watch` loop only surfaces the signal via
`ORCHESTRATOR_ACTION: run-learner field=learner_due loop=harness-watch`; the orchestrator
spawns the learner.

**`run-evolve`** (fires on the `evolve` loop's `evolve_due` false→true transition): The
orchestrator spawns the learner's `canon:evolve-candidate` pass (`select_mutation_targets →
inline Sonnet rewrite → evaluate_candidate holdout → shape → write accepted proposals to
`.canon/proposed-learnings/`). Under the `supervised` tier, ASK the user first before
spawning; under `autonomous` and `light-touch`, auto-spawn but fire a `PushNotification`
first (the pass is multi-minute and runs many `claude -p` eval calls — cost visibility is
mandatory before an automatic long-running dispatch). Proposals are HITL-gated regardless of
tier. The spawned pass emits ONLY `accepted===true` candidates (evolution-hard-gate preserved);
candidate generation stays in the learner skill (model-step-in-agent-layer — the loop, the
runner, and the dispatch never invoke a model). dc-06 holds: the `evolve` loop only surfaces
`ORCHESTRATOR_ACTION: run-evolve field=evolve_due loop=evolve`; the orchestrator spawns the
learner. NO contract change to `select_mutation_targets`, `evaluate_candidate`,
`attribute_failure`, or `context_provenance` — consumed as-is.

**`auto-enable-merge`** (fires on the `ship-watch` `ci_conclusion` `pending → success`
transition, while the PR is OPEN and auto-merge is not already enabled):
1. Read-only precheck: `gh pr view <pr> --json state,autoMergeRequest`.
2. Guard (idempotent + scoped): proceed only if `state === "OPEN"` AND `autoMergeRequest` is
   null (not already armed). Else no-op — do not retry the same tick.
3. Tier gate: under `autonomous`/`light-touch`, run `gh pr merge <pr> --auto --squash`
   unattended. Under `supervised`, ASK the user first (AskUserQuestion); run only on
   confirmation.
4. Squash only — no merge-commit or rebase mode. GitHub branch protection still gates the
   actual merge; arming is safe even under contention.
This consumer does NOT merge on CI red, does NOT fire on the loop's first tick (ADR-0002
baseline-only), and does NOT retroactively arm prior PRs. dc-06 holds: `ship-watch` only
surfaces `ORCHESTRATOR_ACTION: auto-enable-merge field=ci_conclusion loop=ship-watch`;
`guardrails.mutates_build` stays `false` and no mutating `gh` is on the loop's
`observe.shell_commands` allowlist — the orchestrator does the mutation, not the runner.

**`auto-update-branch`** (fires on the `ship-watch` `merge_state` transitioning to `BEHIND`
or `DIRTY`, while the PR is OPEN): motivated by a real incident (PR #462) where `main`
advanced mid-watch, the PR went `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING`, and an
already-armed auto-merge silently stalled until a human noticed.
1. Read-only precheck: `gh pr view <pr> --json state,mergeStateStatus`. Proceed only if the
   PR is still `OPEN` and `mergeStateStatus` is still `BEHIND` or `DIRTY` (idempotent — a tick
   that races a concurrent fix is a no-op, not a retry).
2. `git fetch origin` in the build worktree, fail-open (`git fetch origin || true`) like the
   plan-time base-advance advisory's fetch — a fetch failure surfaces (the merge proceeds
   against a possibly-stale `origin/main`) rather than silently blocking the consumer. Without
   this, a stale local `origin/main` remote-tracking ref makes the next step a no-op merge that
   never clears the `BEHIND`/`DIRTY` state the loop surfaced.
3. The orchestrator merges `origin/main` into the PR branch in the build worktree.
4. Conflict triage: conflicts confined ONLY to generated artifacts (`context-manifest.json`,
   generated `**/.claude/CLAUDE.md` index blocks) are auto-resolved by regenerating them
   (`npm run regen:context-manifest` / `sync_indexes`) and committing the result. Any conflict
   touching a SOURCE file is never auto-resolved — surface via the merge-conflict HITL pattern
   (`references/hitl-patterns.md`) instead.
5. Re-run `hooks/context-manifest-gate.sh` before pushing (a regenerated manifest must still
   pass the freshness gate).
6. Push to the PR branch. If auto-merge was already armed (`auto-enable-merge`), it proceeds
   on green once GitHub re-evaluates mergeability — this consumer does not re-arm it.
Tier gate: unattended in all tiers (autonomous, light-touch, AND supervised) for the
clean/generated-only-conflict path — the merge is reversible and branch-scoped, unlike arming
a real merge (`auto-enable-merge`), which still ASKs under supervised. A SOURCE-file conflict
always routes to HITL regardless of tier. dc-06 holds: `ship-watch` only surfaces
`ORCHESTRATOR_ACTION: auto-update-branch field=merge_state loop=ship-watch`;
`guardrails.mutates_build` stays `false` and no mutating `git`/`gh` command is on the loop's
`observe.shell_commands` allowlist — the orchestrator does the merge and push, not the runner.
