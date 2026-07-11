---
id: evolution-regression-watch
title: Evolution Regression Watch — observe-only regression-candidate surfacer for applied evolutions
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: session-start
  firing_posture:
    autonomous: disabled
    light-touch: disabled
    supervised: opt-in
mode: self-paced
schedule:
  cadence_hint:
    active: 30m
    idle: 2h
  max_wall: "0"
state:
  scope: workspace
  path: ${WORKSPACE}/evolution-regression-watch-state.json
  snapshot:
    - regression_candidate_ids  # sorted string[]: proposal_ids whose latest verdict is regression_candidate
    - checked_count             # int: distinct proposal_ids probed this tick
    - last_checked_at           # string|null: ISO-8601 timestamp of the most recent probe
observe:
  tools:
    - Bash
  mcp:
    - get_evolution_outcomes
  shell_commands:
    - git log
surface:
  on_transition:
    - field: regression_candidate_ids
      append: true
      message: "One or more applied evolutions crossed into regression_candidate. Surfacing revert-evolution for HUMAN review (observe-only; NO automated revert/quarantine/merge). Run get_evolution_outcomes for the named proposal_id(s) to decide."
      terminate: false
terminate:
  when:
    - at_finalize
    - max_wall_reached
guardrails:
  mutates_build: false
  forbidden_tools:
    - Edit
    - Write
    - NotebookEdit
---

## evolution-regression-watch — Per-Tick Action Body

`evolution-regression-watch` is a self-paced loop that watches every applied evolution-candidate
(Inc-1/Inc-2's `applied_evolutions` rows, now carrying a `Canon-Evolution:` trailer per Inc-3's
producer) for a `regression_candidate` verdict from `get_evolution_outcomes`, and surfaces a
manual `revert-evolution` recommendation to a human — via **message only**. It never acts: no
`orchestrator_action`, no automated revert, no quarantine, no merge, in any autonomy tier (dc-04,
dc-05).

**dc-06 note:** The orchestrator's session-start tap starts this loop by calling `ScheduleWakeup`.
Authoring this file only registers the definition. Do not call `ScheduleWakeup` from within this
body to start the loop — only to re-arm the next tick. This loop is read-only observation; it
never reverts, quarantines, or merges anything, regardless of what it finds.

### Enumeration source (Inc-3 dependency)

This loop discovers which `proposal_id`s to check from `Canon-Evolution:` trailer commits — the
same breadcrumb Inc-3's producer writes at apply time (`skills/canon/commands/review-learnings.md`
Writer arm + Arm M). It does NOT read `learning.jsonl` or call a separate list tool. An evolution
recorded without a producer commit (shouldn't happen post-Inc-3, and always possible on `main`/
`master` where the producer intentionally skips the commit) is invisible to this loop — acceptable,
since regression detection only matters for applies that actually landed on a committed branch.

### First-tick baseline

On tick 1 there is no prior snapshot, so no `on_transition` rules fire. Set:

- `regression_candidate_ids = []`
- `checked_count = 0`
- `last_checked_at = null`

Surface NOTHING. Write the baseline snapshot. Report:
`[loop: evolution-regression-watch] Tick 1 baseline captured. Watching from next tick.`

### Observe (tick 2+)

1. Run `git log --grep='^Canon-Evolution:' -E --format=%B` (the read-only `git log` carve-out;
   `git log` is on `READ_ONLY_SHELL_COMMANDS` — no allowlist change needed).
2. Parse the output for `Canon-Evolution: {id}` trailer lines. Apply the SAME charset guard as the
   Inc-3 backfill tool (dc-05): accept an id only when it matches `^[A-Za-z0-9._-]+$` — skip any
   malformed/injected value. Dedupe to a unique set of `proposal_id`s.
3. For each unique `proposal_id`, call `get_evolution_outcomes({ proposal_id, project_dir })`.
   - `PROPOSAL_NOT_RECORDED` (the trailer exists but no `applied_evolutions` row — shouldn't
     happen post-Inc-3, but fail-open) → skip this id, do not count it as checked.
   - Otherwise read `verdict`.
4. Collect every `proposal_id` whose `verdict === "regression_candidate"` into a sorted array —
   this is the new `regression_candidate_ids` value.
5. Set `checked_count` to the number of ids successfully probed (step 3, excluding
   `PROPOSAL_NOT_RECORDED` skips). Set `last_checked_at` to the current ISO-8601 timestamp.

### Diff + surface

Apply the `on_transition` rule per the runner Step 5 algorithm: `field: regression_candidate_ids`
with `append: true` fires when the new array contains an id NOT present in the previous snapshot's
array — i.e. a target crossed into `regression_candidate` since the last tick. On fire, emit the
message (runner Step 6):

```
One or more applied evolutions crossed into regression_candidate. Surfacing revert-evolution for
HUMAN review (observe-only; NO automated revert/quarantine/merge). Run get_evolution_outcomes for
the named proposal_id(s) to decide.
```

Name the specific new `proposal_id`(s) that triggered the transition when reporting this to the
user. There is NO `orchestrator_action` on this rule — the runner only prints the message; it never
spawns a revert flow or executes `revert-evolution` itself (dc-05). `revert-evolution` remains a
manual action the orchestrator/user decide to run, outside this loop's authority.

### Write snapshot

Persist the snapshot atomically to `state.path` (`${WORKSPACE}/evolution-regression-watch-state.json`):

```json
{
  "regression_candidate_ids": ["evolve-20260710-01"],
  "checked_count": 4,
  "last_checked_at": "<ISO-8601 timestamp>"
}
```

This is the runner's Step 7 snapshot write — loop-state persistence, NOT a build mutation. `Write`
stays out of `observe.tools`.

### Evaluate terminate

Check `terminate.when` conditions:

| Condition | When satisfied |
|-----------|---------------|
| `at_finalize` | The workspace is being finalized (session ending) |
| `max_wall_reached` | `max_wall` elapsed time exceeded (`max_wall: "0"` disables the wall-clock cap) |

Unlike `evolve`, this loop's transition rule does NOT self-terminate on fire (`terminate: false`) —
regression watching is an ongoing background concern, not a one-shot nudge. It keeps re-arming
until a `terminate.when` condition is met.

**If terminal:**
Report `[loop: evolution-regression-watch] Loop terminated after tick <N>. Reason: <condition>.`
OMIT the `ScheduleWakeup` call — omitting it terminates the self-paced loop.

**If NOT terminal:**
Re-arm the next wakeup:
```
ScheduleWakeup({
  delaySeconds: <cadence>,   # active (1800s) when this tick found >=1 Canon-Evolution trailer commit
                             # to probe; idle (7200s) when zero trailer commits exist yet
  reason: "[loop: evolution-regression-watch] Tick <N> complete. Re-arming at <active|idle> cadence.",
  prompt: "Run one tick of Canon loop \"evolution-regression-watch\": call get_loop_definition({ id: \"evolution-regression-watch\" }) to load its definition + body, then execute that body's observe → diff → surface → write → evaluate pipeline (the steps in skills/canon/commands/loop-tick.md), using the loop's state.path (substitute ${WORKSPACE}) for the prior snapshot. Read-only observation only (dc-06)."
})
```

Choose `active` (30m / 1800s) when this tick found one or more `Canon-Evolution:` trailer commits to
probe (there is live signal to keep watching); choose `idle` (2h / 7200s) when zero trailer commits
exist in history yet (near-term, before Inc-3's producer has landed any commits — plumbing-only, per
the parallel `evolve` loop's "no work yet" idle posture).
