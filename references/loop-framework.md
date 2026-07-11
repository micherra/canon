---
name: loop-framework
description: >-
  Full Canon loop dispatch framework. Covers command registration, resilient
  dispatch, lifecycle-hook vocabulary and code, phase history, post-ship tap,
  session-start tap, non-declarative invariant, orchestrator_action consumption,
  and the seven named consumers (auto-triage-fix, auto-plugin-update, run-learner, run-evolve, auto-enable-merge, auto-update-branch, auto-staleness-refresh).
---

# Loop Framework <!-- last-updated: 2026-07-11 -->

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
# → CronList() first — skip CronCreate for any loop id already scheduled (resume de-dupe, see below)
# → for each interval loop with firing_posture[tier] === "auto" AND no existing CronList job for its id:
CronCreate({ cron: "<5-field cron expr — translate schedule.interval, e.g. 5m → */5 * * * *>", prompt: "<inline tick prompt — see Resilient dispatch above>", recurring: true })
# → for each self-paced loop with firing_posture[tier] === "auto":
ScheduleWakeup({ delaySeconds: <initial_delay>, reason: "Starting <id>", prompt: "<inline tick prompt — see Resilient dispatch above>" })
# → for each loop with firing_posture[tier] === "opt-in": ask user, then dispatch
```

**The non-declarative constraint (dc-06):** Nothing auto-starts. Only the orchestrator
initiates the scheduling call (`CronCreate` or `ScheduleWakeup`) at a named lifecycle moment.
No manifest, hook, or command frontmatter starts a loop — the capability ground truth is that
a plugin cannot do this.

**Cron job lifecycle (session-scoped; decision `cron-durability`).** `CronCreate` jobs are
**session-only and in-memory** — gone when a session truly ends, auto-expiring after 7 days; the
`durable` param has no effect (durable persistence is not available on 2.1.206). This is not a
gap: dc-06 already makes **per-session re-dispatch at named lifecycle hooks the persistence
mechanism**. `ScheduleWakeup` is also the `/loop` dynamic-mode tool (it carries a `stop` field +
autonomous-loop sentinels); the raw `CronCreate`/`ScheduleWakeup` tools and the `/loop` +
`/schedule` skills front the same capability — no migration is forced.

**Resume restores unexpired jobs — de-dupe before re-issuing (Codex P2 on PR #482).**
Per the Claude Code scheduled-tasks docs (`https://code.claude.com/docs/en/scheduled-tasks`,
Limitations section), `claude --resume`/`--continue` **does** restore unexpired recurring
`CronCreate` jobs — "recurring tasks within seven days of creation" — this is the same
`/loop` mechanism Canon's taps use, not a different surface (confirmed: `PROBE-FINDINGS.md`
for this fix). So blindly re-issuing `CronCreate`/`ScheduleWakeup` for every `auto` loop at
`session-start`/`post-ship` on a **resumed** session can create a duplicate job alongside one
`--resume` already restored. Before dispatching, call `CronList()` and skip creating a
loop whose id is already present in an existing job's prompt — de-dupe by loop id. This
applies with confidence to `CronCreate`-issued interval loops (`CronList` explicitly
enumerates them); treat it as a defensive best-effort check for `ScheduleWakeup`-issued
self-paced loops too, since `CronList`'s coverage of self-paced wakeups is unconfirmed.

`max_ticks` is RETAINED and bounds interval-loop ticks via loop **self-termination** (the
`max_ticks_reached` terminate condition), NOT via the now-removed cron `max` param.

**Stopping an interval loop:** the recurring cron does not self-cap — at a terminal condition
(e.g. `max_ticks_reached`) the orchestrator stops it via `CronDelete({ id })` (`id` from the
initial `CronCreate`). dc-06: orchestrator-initiated only. (`CronList()` lists active jobs.)

**Phase history:** Phase A shipped the framework spine — schema, registry, MCP tools, `_probe`
demo; no production loop ran. Phase B ships `loops/ship-watch.md` — the first real loop,
dispatched via the post-ship tap. Phase C ships session-watch + self-paced mode.
Phase D ships harness-watch — the accumulated-build-signal observer, fired post-ship, surfaces `run-learner`.
Phase E ships evolve — the session-start attribution-signal observer, surfaces `run-evolve`.
Discovery: `list_loops`.

**Post-ship tap (Phase B+):** After the shipper creates the PR, the orchestrator calls
`list_loops({ lifecycle_hook: "post-ship", tier })`, then `CronList()` to de-dupe against jobs
a `--resume`/`--continue` may have already restored (see Resume restores unexpired jobs above).
For each returned loop, branch on `loop.mode`:
- `firing_posture[tier] === "auto"`:
  - `mode: "interval"` → call `CronCreate({ cron: <5-field cron expr translated from loop.schedule.interval>, prompt: "<inline tick prompt for <id> — see Resilient dispatch above>", recurring: true })` immediately — translate `schedule.interval` to a 5-field cron expression; do NOT pass the raw interval string.
  - `mode: "self-paced"` → call `ScheduleWakeup({ delaySeconds: <loop initial cadence>, reason: "Starting <id> at post-ship", prompt: "<inline tick prompt for <id> — see Resilient dispatch above>" })` immediately.
- `firing_posture[tier] === "opt-in"` → offer the watch to the user first; dispatch by mode on confirmation (CronCreate for interval, ScheduleWakeup for self-paced).
- `firing_posture[tier] === "disabled"` → skip silently.

`ship-watch` is the first loop this tap fires (autonomous/light-touch → auto, supervised → opt-in). It demonstrates the resilient inline dispatch form (mechanism-ships-first-instance, dc-06). `harness-watch` is a self-paced post-ship loop and is dispatched via `ScheduleWakeup`.

**Session-start tap (Phase C+):** At session start, the orchestrator calls
`list_loops({ lifecycle_hook: "session-start", tier })`, then `CronList()` to de-dupe against
jobs a `--resume`/`--continue` may have already restored (see Resume restores unexpired jobs
above) — session-start is the most likely tap to run on a resumed session. For each returned loop:
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

For the `external_review_comment_ids` transition, unchanged:
1. Reads the new PR comment(s).
2. If a CLEAR actionable defect → dispatches a fix flow (engineer → re-run verify gates → push
   to the build branch) WITHOUT asking first.
3. If AMBIGUOUS / a question / design-level pushback → surfaces with a proposed approach and
   ASKS first.
4. NEVER auto-merges the PR (arming auto-merge is the separate, CI-green-gated
   `auto-enable-merge` consumer's job, not auto-triage-fix's).

For the `ci_conclusion: pending → failure` transition, a flaky-vs-legit **classification
sub-protocol** runs FIRST, before any fix-flow dispatch decision — a build-introduced failure
and a flaky one look identical in `ci_conclusion` alone, and dispatching a fix flow against a
flaky failure wastes an engineer cycle chasing a phantom bug:

1. Read the failing job's logs — `gh pr checks` for the summary, `gh run view <run-id> --log`
   (or `--log-failed`) for the detail — both READ-only, orchestrator-side (not on the runner's
   `observe.shell_commands` allowlist; see the dc-06 note below).
2. Classify in TWO ordered steps — a diff-intersection check FIRST, which OVERRIDES the
   marker-based check that follows. Marker-based flaky classification never wins against a
   diff-intersection hit; it only ever applies in the diff-orthogonal remainder.
   a. **Diff-intersection check (overrides marker-based classification):** does the failing
      job/test exercise a file the PR diff touched (`git diff {base}..HEAD --name-only`
      intersected against the failing file/test path)? If YES → **Legit**, unconditionally —
      even if the failure log ALSO carries an infra-looking marker (timeout, OOM, `ETIMEDOUT`,
      network 5xx). A build-introduced regression (a resource leak, an infinite loop, a
      genuinely slow query the diff added) can produce the exact same surface signature as
      flaky infra; a marker match is not license to skip the diff check. Diff-touched territory
      always wins over marker appearance — this is what makes the classifier safe-by-design
      against a build-caused failure disguising itself as "just flaky."
   b. **Marker-family check (reached only when diff-orthogonal — 2a did not match):** diff-
      orthogonality is the PRECONDITION for reaching this step, NOT itself a flaky signal — a
      markerless orthogonal failure can be a legitimate indirect regression (the PR broke a
      file it didn't touch) just as easily as an intermittent, so orthogonality alone never
      classifies flaky. Classify **Flaky (known-intermittent/environmental)** ONLY on an actual
      infra/env/setup marker in the log: network timeout, `ETIMEDOUT`/`ECONNRESET`, runner OOM,
      registry/`npm ci` 5xx, model-download (HuggingFace/ONNX) failure, `"Test timed out in
      Nms"`, git-subprocess timeout, tmpdir `ENOTEMPTY`/`EEXIST` races, or an exit-before-tests
      toolchain/setup failure not attributable to the diff. Cite known families descriptively
      (init-workspace concurrency-race, embedding/ONNX cold-start, subprocess PATH/CWD
      non-determinism, tmpdir races — see `project_flaky_integration_tests_hardening`) — never a
      maintained test-name list or a hardcoded count (`no-literal-repo-state-counts`). A
      diff-orthogonal failure that matches NONE of these marker families is **Legit** by default
      (unclassified diff-orthogonal failures are not assumed flaky).
3. Decision procedure, **retry bound = 1**:
   a. **Legit via diff-intersection (2a)** → dispatch the fix flow directly (clear → without
      asking, ambiguous → ask; same tier rule as the comment-transition path above). No re-run —
      the diff-intersection hit is decisive on its own.
   b. **Flaky via marker-family (2b)** → the orchestrator runs **exactly one** bounded re-run of
      the failed job: `gh run rerun --failed <run-id>` (orchestrator-side, CI-only mutation —
      reversible, source-untouched).
      - Re-run **green** → flaky confirmed. **Unconditionally surface a note to the human**
        (the failure was flaky, not fixed — a possibly-real regression must never be silently
        dropped just because a re-run happened to pass). Take NO fix action. Under
        **supervised** tier, ASK the user to confirm treating this as resolved before moving
        on; under autonomous/light-touch, proceed on the note alone (no ask). Critically,
        **`ship-watch` has already terminated** by this point — the `ci_conclusion: pending →
        failure` transition that triggered `auto-triage-fix` carries `terminate: true` (see
        `loops/ship-watch.md`'s `surface.on_transition` and `terminate.when:
        [..., ci_failure_surfaced, ...]`), so monitoring does NOT resume on its own; do not
        claim it "continues watching." To resume progression toward merge, the orchestrator
        must explicitly **re-dispatch `ship-watch` via the post-ship lifecycle tap**
        (`list_loops({ lifecycle_hook: "post-ship", tier })` → `CronList()` de-dupe → dispatch
        per `firing_posture[tier]`) — the same per-session re-dispatch mechanism the original
        post-ship tap used (dc-06; see "Cron job lifecycle" above).
      - Re-run **red** → reclassify as legit → dispatch the fix flow (clear → without asking,
        ambiguous → ask).
   c. No unbounded retry — one re-run, then treat as legit. This bound exists precisely so a
      genuine regression can't hide behind repeated "maybe it's flaky" re-runs.

**dc-06 preservation**: `loops/ship-watch.md` is untouched by this classification — its
`observe.shell_commands` allowlist (`gh pr view`, `gh pr checks`, `gh release list`, `gh api`,
`gh repo view`, all read-only GETs) gains nothing, and `guardrails.mutates_build` stays
`false`. `gh run view` (read) and `gh run rerun` (the one bounded mutation) are both run by the
orchestrator consumer, never by the runner — the runner still only ever surfaces
`ORCHESTRATOR_ACTION: auto-triage-fix field=ci_conclusion loop=ship-watch`. All classification
+ re-run/fix logic above is prose in this consumer contract, executed by the orchestrator
(which is allowed to mutate), mirroring how `auto-update-branch` runs `git fetch`/merge/push
itself without adding those commands to the runner's allowlist.

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

**`auto-staleness-refresh`** (fires on the `session-watch` body emitting
`ORCHESTRATOR_ACTION: auto-staleness-refresh field=<docs_stale|kg_age> loop=session-watch`,
per-episode de-duped against `.staleness-refreshed.json` so an already-stale-at-session-start
condition still fires on tick 1 — see ADR-0045. Thresholds — commits-since-scribe: 15, KG age:
24h honoring `CANON_KG_STALE_SECONDS` — are declared in `loops/session-watch.md`'s body
(dec-05), not hardcoded here):

**`field=kg_age`** — regenerates the gitignored `.canon/knowledge-graph.db`; no tracked write,
trivially reversible:
1. Call `codebase_graph` to refresh the local knowledge graph.
2. No worktree, no PR — a plain local mutation.
Tier gate: **unattended in ALL tiers** (autonomous, light-touch, AND supervised) — a local,
reversible, gitignored-DB refresh carries none of the tracked-write risk that gates
`auto-enable-merge`/`auto-update-branch`'s SOURCE-conflict path.

**`field=docs_stale`** — writes tracked `CLAUDE.md` via an ephemeral scribe→PR flow (dec-03):
a session-start refresh has no build worktree, and direct-push-to-main is forbidden.
1. Idempotency precheck: `gh pr list` for an already-open `staleness-refresh` PR/branch —
   no-op if one exists (avoids one PR per session for the same episode).
2. `init_workspace({ flow_name: "staleness-refresh", base_commit: HEAD, tier: "small",
   preflight: true, session_id, job_id })`.
3. Compute `before` = the git-derived last-scribe SHA (same `git log --grep` computation
   `session-start-doc-check.sh` uses); `after` = `HEAD`.
4. `resolve_agent_skills({ agent_name: "scribe" })` → spawn `canon:scribe` with
   `worktree_path` + `before`/`after` — "standalone session-start sync, no build summaries,
   git-diff-only."
5. Post-scribe: verify the `docs(context-sync):` commit landed, run
   `hooks/scribe-scope-guard.sh`, and run the doc-only verify subset (context-manifest-gate +
   boilerplate/principle-id/rule-scope gates; skip build/lint/test — this is a
   documentation-only diff).
6. Spawn `canon:shipper` → PR to main. `finalize_workspace`.
Tier gate: **unattended in ALL tiers** (autonomous, light-touch, AND supervised) — no
ask-first, no HITL prompt, in any tier. This intentionally departs from the
tracked-write-gates-supervised posture every other tracked-file-mutating consumer
(`auto-enable-merge`, `auto-update-branch`'s SOURCE-conflict path) follows: it reflects an
explicit user override at this build's plan-approval gate, superseding the architect's
original ask-first-under-supervised recommendation (dec-04). The delivered PR itself remains
a full human review gate regardless of tier — unattended dispatch only skips the
*pre-dispatch* ask, never the merge decision.

**Notify (both fields, AC4):** after the action(s) complete, fire a `PushNotification` naming
what was refreshed — "KG refreshed (was Nh old)" for `kg_age`, "Docs context-sync PR #NNN
created (N commits since last scribe)" for `docs_stale`.

dc-06 holds: `session-watch` only surfaces the directive; `guardrails.mutates_build` stays
`false` and no mutating command is on the loop's `observe.shell_commands` allowlist — the
orchestrator does the `init_workspace`/scribe/`codebase_graph`/shipper work, not the runner.
