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

## Schema (v1 — Phase 2)

```yaml
name:          <kebab-case>        # matches filename stem
description:   <one line>
tier:          small | medium | large
steps:                             # ordered list
  - role:              <canon agent name>   # e.g. canon-researcher
    task_type:         <tag>                # research | design | implement | review | test | fix | ...
                                            # plus Phase 2 tags: refactor | migrate |
                                            # security_audit | test_gap
    artifact:          <artifact id>        # logical name, referenced by downstream steps
    artifact_path:     <relative path>      # under .canon/workspaces/<id>/ —
                                            # flat (Phase 1) OR template
                                            # "plans/<slug>/<task_id>-<NAME>.md"
                                            # when wave: true (Phase 2)
    hitl:              false | after | after_if_verdict_not_clean
    wave:              false | true         # optional; Phase 2 addition
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
- **`wave`** — Phase 2 addition, optional, default `false`. When `true`,
  the step is wave-expanded at plan time: `planRun` produces one
  `SpawnDescriptor` per task id in the caller-supplied `wave_context`,
  each with its own per-task `artifact_path` under `plans/<slug>/`.
  Wave steps must use roles in the `WAVE_COMPATIBLE_ROLES` set (every
  Canon role except the four single-agent roles: `canon-guide`,
  `canon-chat`, `canon-writer`, `canon-learner`). Wave step
  `artifact_path` must be written as a TEMPLATE — literally
  `plans/<slug>/<task_id>-<NAME>.md` — with the role's canonical
  `<NAME>` suffix (see `mcp-server/src/features/spawn/index.ts`
  `WAVE_ARTIFACT_SUFFIXES`).

### Wave-scoped paths (Phase 2)

A wave step's declared path is a template, expanded at plan time.
Per-role suffixes come from `WAVE_ARTIFACT_SUFFIXES`:

| Role              | Wave suffix       | Example expansion (`slug=fix, task_id=t1`) |
|-------------------|-------------------|--------------------------------------------|
| canon-researcher  | `-RESEARCH.md`    | `plans/fix/t1-RESEARCH.md`                 |
| canon-architect   | `-DESIGN.md`      | `plans/fix/t1-DESIGN.md`                   |
| canon-implementor | `-SUMMARY.md`     | `plans/fix/t1-SUMMARY.md`                  |
| canon-reviewer    | `-REVIEW.md`      | `plans/fix/t1-REVIEW.md`                   |
| canon-tester      | `-TEST-REPORT.md` | `plans/fix/t1-TEST-REPORT.md`              |
| canon-fixer       | `-FIX-SUMMARY.md` | `plans/fix/t1-FIX-SUMMARY.md`              |
| canon-security    | `-SECURITY.md`    | `plans/fix/t1-SECURITY.md`                 |
| canon-scribe      | `-CONTEXT-SYNC.md`| `plans/fix/t1-CONTEXT-SYNC.md`             |
| canon-shipper     | `-SHIP.md`        | `plans/fix/t1-SHIP.md`                     |

Wave expansion changes the descriptor task id shape from Phase 1's
`<runbook>-<NN>-<role>` to `<runbook>-<slug>-<task_id>-<role>`. The
`task-artifacts.json` and `teammate-artifacts.json` files the hooks
consume key off the expanded id so `artifact-enforce.sh` finds the
per-task path and does not collide on a single flat entry.

### Upstream ref resolution for wave steps

| Upstream shape    | Consumer shape | Resolution                                         |
|-------------------|----------------|----------------------------------------------------|
| flat              | flat           | Phase 1, unchanged                                 |
| flat              | wave           | every wave teammate sees the same flat path       |
| wave              | wave           | one-to-one by task id (same-task fan-through)      |
| wave              | flat           | glob-shaped synthesis: `plans/<slug>/*-<NAME>.md`  |

The wave-to-flat glob is Phase 2's compromise for fan-in: a linear
runbook cannot enumerate N paths in a single upstream ref, so the
downstream flat teammate (tester, scribe, reviewer, shipper) receives
a concrete glob pointing at the wave output directory and is expected
to discover the matching per-task files at runtime.

### What is deliberately not in the schema

- No state names. Steps are indexed by their position in the list.
- No transitions. The lead walks steps linearly.
- No loops. If a step fails artifact enforcement, the lead re-spawns the
  same role (bounded by lead-mode policy, not the runbook).
- No injected context blocks. Context assembly is the spawn module's job and
  is driven by `task_type` + `required_artifacts`, not by runbook fields.
- No **adaptive** wave semantics. Phase 2 ships static waves where the
  caller supplies task ids up front; Phase 3 will extend the schema to
  let the architect's plan-index output drive the next wave's shape.

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

## Supported runbooks

| Runbook                      | Tier   | Waves | Notes                                             |
|------------------------------|--------|-------|---------------------------------------------------|
| `fast-path.yaml`             | small  | no    | Phase 1 — bug fix or small change, 1–3 files      |
| `feature.yaml`               | medium | yes   | Phase 2 — design, wave implement, test, review    |
| `refactor.yaml`              | medium | yes   | Phase 2 — behavior-preserving wave refactor       |
| `migrate.yaml`               | medium | yes   | Phase 2 — staged migration + security audit       |
| `test-gap.yaml`              | small  | no    | Phase 2 — coverage scan, write tests, review      |
| `review-only.yaml`           | small  | no    | Phase 2 — single-pass principle + drift review    |
| `security-audit.yaml`        | small  | no    | Phase 2 — security scan + compliance review       |

Divergences from the legacy flow runtime behavior are documented in
`docs/phase-2-conversion-notes.md`. Phase 3 (epic, adaptive waves) and
Phase 4 (deletion of the legacy flow runtime) are tracked separately in
`docs/agent-teams-migration-plan.md`.

## See also

- `docs/agent-teams-migration-plan.md` — authoritative plan and phased rollout.
- `docs/agent-teams-mode.md` — user docs for the new mode.
- `docs/phase-1-smoke-test.md` — smoke-test log and artifact listing.
- `docs/phase-2-smoke-test.md` — Phase 2 smoke-test log.
- `docs/phase-2-conversion-notes.md` — per-flow conversion notes and divergences.
- `mcp-server/src/domains/spawn/README.md` — how spawn prompts are assembled.
