---
template: loop-definition
description: >
  Authoring template for Loop-as-Artifact definitions. Drop a filled copy at
  loops/<id>.md to register a loop. The loops/ directory IS the registry —
  dropping a file registers the loop; it does NOT start it. Only the orchestrator
  starts loops by calling CronCreate at a named lifecycle moment.
usage: |
  1. Copy this file to loops/<your-id>.md
  2. Fill in all required fields (marked with a comment)
  3. Replace [REQUIRED] with your values; remove [PHASE C] lines unless building Phase C
  4. Verify: run `list_loops` — your loop should appear in the valid[] channel
  5. To invoke: orchestrator calls CronCreate({ cron: "<5-field cron expr translated from schedule.interval>", prompt: "<inline tick prompt for <id> — see CLAUDE.md §Loop Framework 'Resilient dispatch'>", recurring: true })
---

```yaml
# ── Loop frontmatter (copy from here) ─────────────────────────────────────────
id: <your-id>              # [REQUIRED] kebab-case; must match the filename stem (loops/<id>.md)
title: <Human-readable name>   # [REQUIRED]
status: active             # active | shadow | disabled (default: active)

trigger:
  fired_by: orchestrator   # Always "orchestrator" — loops are never self-started
  lifecycle_hook: post-ship  # [REQUIRED] post-ship | on-long-dispatch | session-start
  firing_posture:
    autonomous: disabled   # auto | opt-in | disabled per tier
    light-touch: disabled
    supervised: opt-in

# ── Mode: choose interval (Phase A/B) or self-paced (Phase C) ─────────────────
mode: interval             # interval (Phase A/B) | self-paced [PHASE C]

schedule:
  # Interval mode (Phase A/B):
  interval: 5m             # [REQUIRED for interval] e.g. 1m, 5m, 30m, 1h
  max_ticks: 10            # [REQUIRED for interval] int ≥ 1; loop terminates after this many ticks

  # Self-paced mode (Phase C — remove these lines for Phase A/B):
  # cadence_hint:
  #   active: 5m           # [PHASE C] cadence when active; maps 1:1 to ScheduleWakeup delaySeconds
  #   idle: 30m            # [PHASE C] cadence when idle; prefer active ≤ 270s (cache warm), idle ≥ 1200s
  # max_wall: "2h"         # [PHASE C] optional; "0" or absent = bounded only by terminate conditions
  #                        # max_wall is enforced in the tick body (no primitive argument) — the tick
  #                        # tracks elapsed time/tick count and stops re-arming when max_wall exceeded

state:
  scope: workspace         # workspace | session
  path: ${WORKSPACE}/<your-id>-state.json   # [REQUIRED] resolved at runtime
  snapshot:                # [REQUIRED] list of field names this loop observes
    - field_one
    - field_two

observe:
  tools: []                # Bash/Read/Write etc. — empty for read-only loops
  mcp: []                  # MCP tool names — empty for read-only loops
  shell_commands: []        # read-only gh/git subcommand prefixes; REQUIRED if Bash is in tools and mutates_build:false

surface:
  on_transition:           # [REQUIRED] at least one rule
    - field: field_one     # [REQUIRED] must be in state.snapshot
      from: null           # optional: last value that triggers (null = any)
      to: "expected"       # optional: new value that triggers (exact match)
      message: "Field changed to expected value."   # [REQUIRED]
      terminate: false     # true → loop ends when this rule fires
      append: false        # true → append to log instead of replacing
      # fire_on_baseline: true   # [ADR-0056] opt-in; admissible ONLY when to is set, from is
                                  # unset, and append is not true — this example rule has a
                                  # `from:` above, so uncommenting as-is would be rejected at
                                  # parse time. See "First-tick semantics" below before using.

terminate:
  when:                    # [REQUIRED] at least one condition
    - max_ticks_reached    # fires when tick count reaches schedule.max_ticks (interval mode)
    # Self-paced terminate vocabulary (Phase C):
    # - at_hitl_gate       # loop terminates when a HITL gate is opened (supervised mode)
    # - at_finalize        # loop terminates when the workspace is finalized
    # - on_cliff_surfaced  # loop terminates after surfacing a cliff (cliff concern self-terminates)
    # - max_wall_reached   # loop terminates when max_wall elapsed time is exceeded (body-enforced)

guardrails:
  mutates_build: false     # [REQUIRED] false = observe+surface only (STRONGLY recommended)
  forbidden_tools:         # enforced at load time: any tool listed here must NOT appear in observe
    - Edit
    - Write
    - Bash
```

## Body (the re-fired action prompt)

The loop body is the per-tick action script. The `/canon:loop-tick` runner executes it on
each tick. Write it declaratively — the runner drives all loops from their definitions;
no per-loop branching should exist in the runner.

### Observe

1. Read the current state from `state.path` (`${WORKSPACE}/<your-id>-state.json`).
2. If the state file is absent (first tick), initialize snapshot fields to their defaults.
3. Run the observe action using only tools listed in `observe.tools` + `observe.mcp`.
4. Record the updated values for each field in `state.snapshot`.

### Diff against snapshot

**First-tick semantics (ADR-0002, amended by ADR-0056):** The first tick establishes a
baseline and surfaces nothing by default. A field with no prior value is never treated as a
transition. Author transition rules assuming they fire only on a *change from a known prior*
(tick 2+) — unless the rule opts in.

If a loop must surface an already-true condition at arm time, declare `fire_on_baseline: true`
on the rule. Admissible **iff** `to` is set, `from` is unset, and `append` is not `true` — any
other combination is a **parse-time rejection** (fail-closed; the flag can't be added to an
any-change, `append`/flood, or `from:`-bearing edge rule even by mistake). A rule that opts in
fires on the baseline tick when the observed value already equals its `to:`; a healthy baseline
still surfaces nothing. Fires once — tick 2's ordinary diff sees no change and does not re-fire.

```yaml
    - field: merge_state       # [PHASE C] example: surface an already-BEHIND PR at arm time
      to: BEHIND
      fire_on_baseline: true   # valid here: to is set, from is unset, append is not true
      message: "PR branch is behind main."
```

Compare observed values against the last-seen snapshot (from the state file).

### Surface on transition

For each `surface.on_transition` rule whose condition fires:
- Emit the `message`.
- If `terminate: true`, mark the loop for termination.

### Write snapshot

Write the updated snapshot back to `state.path` (JSON). Include `last_tick: <ISO-8601>`.

### Evaluate termination

If any `terminate.when` condition holds (or a transition rule with `terminate: true` fired):
- Report termination reason and stop. Do NOT reschedule.

Otherwise: the loop continues under its CronCreate cadence.

---

## Authoring checklist

- [ ] `id` matches the filename stem (`loops/<id>.md`)
- [ ] `state.snapshot` lists every field referenced in `surface.on_transition[].field`
- [ ] `guardrails.forbidden_tools` lists any build-mutating tools NOT in `observe.tools`
- [ ] `mutates_build: false` unless the loop explicitly needs to write (rare; requires explicit justification)
- [ ] Body describes the observe → diff → surface → terminate algorithm with zero runner-specific logic
- [ ] If `observe.tools` includes `Bash`, `observe.shell_commands` lists only read-only gh/git subcommands (e.g. `"gh pr view"`, `"git log"`)
- [ ] `status: shadow` during development; promote to `active` after verification
