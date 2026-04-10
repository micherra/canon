# Canon Runbooks

Phase 1 of the Canon → agent teams migration. Runbooks are short, declarative
YAML files that describe the sequence of teammates a team lead spawns to
execute a Canon flow. They replace the `drive_flow` state machine for the
agent-teams execution path.

**This directory is additive and only consumed when `CANON_AGENT_TEAMS_MODE=on`.**
When the flag is unset or `off`, Canon executes the existing flow YAML under
`flows/*.md` via `drive_flow` exactly as before. Phase 1 does not modify any
existing file.

---

## Why a new format?

Existing flow definitions under `flows/*.md` are state machines: states,
transitions, loops, guards, and fragment includes. They express arbitrary
control flow because the old runtime — `drive_flow` — needed to execute them
turn by turn.

Agent teams give us something simpler: a lead session can directly decide
"spawn teammate X, wait for artifact Y, then spawn teammate Z." Most Canon
flows are straight pipelines with a handful of HITL gates. For those, a
linear list of steps is enough. Runbooks express that list.

Complex flows with branching (e.g., `epic` with adaptive waves) will need an
extended runbook schema in Phase 3. Phase 1 only defines the minimum required
for `fast-path`.

---

## Schema (v0)

```yaml
name:          <kebab-case>        # matches filename stem
description:   <one line>
tier:          small | medium | large
steps:                             # ordered list
  - role:              <canon agent name>   # e.g. canon-researcher
    task_type:         <tag>                # research | design | implement | review | test | fix | ...
    artifact:          <artifact id>        # logical name, referenced by downstream steps
    artifact_path:     <relative path>      # under .canon/workspaces/<id>/
    hitl:              false | after | after_if_verdict_not_clean
    required_artifacts:                     # upstream artifact ids consumed by this step
      - <artifact id>
      - ...
```

### Field semantics

- **`role`** — the Canon agent definition to spawn. Must match a file in
  `agents/` (without the `.md` extension). Phase 1 uses the same 13 agent
  definitions unchanged.
- **`task_type`** — a short tag passed to `assembleSpawnPrompt` so it can
  select context shaping (e.g., more graph context for `research`, more
  principle injection for `review`).
- **`artifact`** — a logical artifact identifier. Downstream steps reference
  this id in their `required_artifacts` list; the spawn prompt assembler
  resolves the id to an on-disk path.
- **`artifact_path`** — the concrete path, relative to the workspace root
  (`.canon/workspaces/<id>/`), where the artifact must exist after the step
  completes. The `artifact-enforce.sh` TaskCompleted hook verifies this file
  before allowing the team lead to move on.
- **`hitl`** — when the lead pauses for human input:
  - `false`: never pause automatically.
  - `after`: always pause after this step; present artifact summary to the
    user.
  - `after_if_verdict_not_clean`: pause only when the step's output contains
    a non-clean verdict (used by reviewer / security steps).
- **`required_artifacts`** — the logical ids this step's spawn prompt must
  reference in its upstream context block. The lead-mode orchestrator passes
  this list to `assembleSpawnPrompt({ upstream_artifact_refs })`.

### What is deliberately not in the schema

- No state names. Steps are indexed by their position in the list.
- No transitions. The lead walks steps linearly.
- No loops. If a step fails artifact enforcement, the lead re-spawns the
  same role (bounded by lead-mode policy, not the runbook).
- No injected context blocks. Context assembly is the spawn module's job and
  is driven by `task_type` + `required_artifacts`, not by runbook fields.
- No wave semantics. Phase 3 will extend the schema for adaptive waves.

---

## Authoring a new runbook

1. Pick a kebab-case name matching the flow it replaces (e.g., `feature`,
   `refactor`).
2. Create `skills/canon/runbooks/<name>.yaml` with the schema above.
3. List the agents you need in order. Prefer reusing the 13 existing
   Canon agent defs over writing new ones.
4. For each step, choose the artifact id by matching the logical artifact
   the corresponding flow state produces today. Keep ids stable across
   runbooks so `assembleSpawnPrompt` can reuse fixtures.
5. Run the Phase 1 smoke test path (`docs/phase-1-smoke-test.md`) with
   `CANON_AGENT_TEAMS_MODE=on` and your new runbook.

### Contributor guide

- Runbooks are **data**, not code. Keep them under 60 lines. If a runbook
  needs branching, stop and open a design issue for the Phase 3 schema
  extension instead of hacking branching into Phase 1.
- Do not duplicate content that belongs in the spawn module or in agent
  defs. If every runbook repeats the same instruction, move it to the
  spawn module.
- Do not reference principles by id in runbook files. Principle selection
  is the spawn module's responsibility.
- Do not add secrets, paths outside `.canon/workspaces/<id>/`, or
  absolute paths.

---

## Relationship to existing flows

| flows/ (old, `drive_flow`) | runbooks/ (new, `lead-mode`) |
|-----------------------------|------------------------------|
| YAML frontmatter + markdown body | Pure YAML |
| State machine: states, transitions, fragments | Linear step list |
| Consumed by `drive_flow` | Consumed by `lead-mode.ts` |
| Always active | Active only when `CANON_AGENT_TEAMS_MODE=on` |
| 10 flow files + 14 fragments | 1 runbook in Phase 1 (`fast-path`) |

Phase 2 adds the remaining core flows as runbooks. Phase 4 deletes the
old flow runtime. Until then, both formats coexist and the feature flag
decides which path runs.

---

## See also

- `docs/agent-teams-migration-plan.md` — authoritative plan and phased rollout.
- `docs/agent-teams-mode.md` — user docs for the new mode.
- `docs/phase-1-smoke-test.md` — smoke-test log and artifact listing.
- `mcp-server/src/features/spawn/README.md` — how spawn prompts are assembled.
