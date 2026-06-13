# loops/ — Loop Registry

This directory is Canon's loop registry. Each `<id>.md` file is a **loop definition** —
a managed, declarative artifact that describes periodic observation behavior. Loop definitions
are authored like principles and agents: markdown with YAML frontmatter, one file per loop.

## What is a loop?

A loop is a Canon artifact that periodically observes some signal (a build state, a PR status,
an environment condition), surfaces meaningful transitions, and self-terminates when its goal
is achieved or its tick budget is exhausted.

Loops are **not** background daemons. They are:
- **Attended** — triggered by the orchestrator at a named lifecycle moment
- **Self-terminating** — they stop when `terminate.when` conditions hold
- **Session-local** — state is scoped to a workspace or session

## How to add a loop

1. Copy `templates/loop-definition.md` to `loops/<your-id>.md`.
2. Fill in the frontmatter. Required fields: `id`, `title`, `trigger.lifecycle_hook`, `mode`,
   `schedule` (fields depend on mode), `state`, `surface.on_transition`, `terminate.when`,
   `guardrails`.
3. Set `status: shadow` during development.
4. Verify: the orchestrator will call `list_loops` — your loop should appear in `valid[]`.
5. Promote to `status: active` when ready.

**The orchestrator starts loops — the definition does not.** See below.

## How loops start (non-declarative constraint)

A plugin cannot auto-start a loop. Authoring a `loops/*.md` registers the loop's
definition; it does not schedule it. The orchestrator initiates scheduling:

```
# Orchestrator, at a lifecycle_hook moment:
list_loops({ lifecycle_hook: "post-ship", tier: "supervised" })
# → for each loop with firing_posture[tier] === "auto":
CronCreate({ schedule: "<interval>", command: "<inline tick prompt for <id>>", max: <max_ticks> })
# → for each loop with firing_posture[tier] === "opt-in":
# → ask user for confirmation, then CronCreate
```

The `command` / `prompt` value is the **self-contained inline tick prompt** (see CLAUDE.md
§Loop Framework "Resilient dispatch" and ADR-0007). This form depends only on
`get_loop_definition` — an always-available MCP tool — and therefore works on both fresh and
stale plugin installs. `/canon:loop-tick <id>` is the registered-install convenience form
(available when the slash command is live), but the inline prompt is the default dispatch.

## Two modes

| Mode | Phase | Scheduler | Description |
|------|-------|-----------|-------------|
| `interval` | A/B (current) | `CronCreate` | Fixed-cadence ticks; `schedule.interval` + `schedule.max_ticks` |
| `self-paced` | C (planned) | `ScheduleWakeup` | Variable cadence; `schedule.cadence_hint.active` + `.idle` |

Phase C is not yet implemented. Self-paced definitions are accepted by the schema but
rejected by the runner with a clear "deferred to Phase C" message.

## Determinism guardrail

The schema enforces this mechanically at load time (not prose):
- Loops with `guardrails.mutates_build: false` cannot declare tools from
  `guardrails.forbidden_tools` in their `observe` section.
- Self-paced loops cannot have `mutates_build: true`.
- Transition rules must reference fields that exist in `state.snapshot`.

Invalid definitions land in the `invalid[]` channel returned by `list_loops` —
they are surfaced with their filename and error message, never silently dropped.

## Distinction from similar concepts

| Concept | Relation |
|---------|---------|
| **Workflow** | Intra-turn fan-out within a single session (parallel agents). Loops span multiple sessions. |
| **Inc-6 canon-maintenance cron** | Standing/unattended/detached cron job. Loops are attended/self-terminating/session-local. |

## Current loops

| Loop | Mode | Hook | Status | Description |
|------|------|------|--------|-------------|
| `_probe` | interval | post-ship | active | Framework runnable proof — proves schema→registry→runtime path. Invoked manually in verify; never fired in production. |

Ship-watch (Phase B) and session-watch (Phase C) will be added here when implemented.
