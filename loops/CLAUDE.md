# loops/ — Loop Registry

## Purpose

`loops/` is Canon's loop registry. Each `loops/<id>.md` file is a loop definition — a
declarative specification of what a loop observes, when it surfaces, and when it terminates.

The directory IS the registry. `list_loops` reads it dynamically; there is no hardcoded
catalog anywhere. Dropping a file here registers the loop; removing it unregisters it.

## The Non-Declarative Constraint (dc-06, decision loops-phase-a-04)

**A plugin CANNOT auto-start a loop.** Authoring a `loops/*.md` file registers a loop
definition. It does NOT start the loop.

Loops run ONLY because the orchestrator calls `CronCreate` at a named lifecycle moment:

```
# Orchestrator at a lifecycle_hook moment:
CronCreate({
  schedule: "<interval>",
  command: "/canon:loop-tick <id>",
  max: <max_ticks>,
})
```

No manifest field, hook script, or command frontmatter can trigger this call automatically.
Only the orchestrator (CLAUDE.md behavior) initiates scheduling — and only when the loop's
`firing_posture` for the current tier is `auto` (or `opt-in` with user confirmation).

## Authoring a Loop

1. Copy `templates/loop-definition.md` → `loops/<your-id>.md`.
2. Fill in the frontmatter (see template for required fields).
3. Write the body: the per-tick observe → diff → surface → terminate algorithm.
4. Verify: `list_loops` should list it in `valid[]` with no errors.
5. To invoke: orchestrator makes the CronCreate call.

## The Determinism Guardrail (dc-05, decision loops-phase-a-05)

The schema enforces this mechanically at load time — it is not prose:

| Rule | What is enforced |
|------|-----------------|
| `mutates_build: false` + forbidden tool in `observe` | Rejected at load time |
| `mode: self-paced` + `mutates_build: true` | Rejected at load time |
| Transition rule references a field not in `state.snapshot` | Rejected at load time |
| `id` ≠ filename stem | Rejected at load time |

When a loop definition is rejected, it lands in the `invalid[]` channel returned by
`list_loops` — it is surfaced with its filename and error, never silently dropped.

## Lifecycle Hook Vocabulary

Loops may attach to these named lifecycle moments:

| Hook | When it fires |
|------|--------------|
| `post-ship` | After the shipper pushes a branch and creates a PR |
| `on-long-dispatch` | When the orchestrator dispatches a build expected to take > N minutes |
| `session-start` | At the start of a new Canon session (Phase C; not yet wired) |

## Phase Boundary

| Phase | What ships |
|-------|-----------|
| **A (current)** | Schema + registry loader + `list_loops`/`get_loop_definition` + `/canon:loop-tick` runner + `_probe` demo |
| **B** | Ship-watch definition (`loops/ship-watch.md`) |
| **C** | Self-paced mode + ScheduleWakeup + session-watch + de-dupe ledger |

In Phase A, NO loop fires in production — only `_probe` runs, invoked manually in verify.

## Relationship to Other Canon Concepts

| Concept | Relation |
|---------|---------|
| **Workflow** | Intra-turn fan-out (parallel agents in one session); loops are inter-session periodic observation |
| **Inc-6 canon-maintenance cron** | Standing/unattended/detached; loops are attended/self-terminating/session-local |
| **Principles** | Loops mirror the principle artifact class exactly (markdown + YAML frontmatter, directory-as-registry, gray-matter, register-*.ts) |
