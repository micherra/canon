---
name: dag-execution-protocol
description: >-
  Full DAG execution protocol for Canon parallel builds. Covers DAG
  validation, Task Queue Setup, Worker Dispatch (task queue + named teammates),
  Merge Protocol, Post-DAG Tail, and Failure Handling. Read before any
  build where task-dag.yaml exists or before task-queue/merge/cleanup.
---

# DAG Execution Protocol

Read this file BEFORE executing any build where `${WORKSPACE}/plans/${slug}/task-dag.yaml` exists, and before any task-queue/merge/cleanup operation. See `CLAUDE.md` for the stub pointer.

## canon-waves opt-in path (Increment 1)

canon-waves (`workflows/canon-waves.js` + the `compile_waves` MCP tool, SYNTHESIS Inc-5) is an
**opt-in, single-wave-only** execution path for a DAG build's parallel-implement phase. It
replaces the hand-run git checklist below with a compiled `WavesArgs` envelope handed to ONE
generic `Workflow`-tool runner. It does **not** revive the #167-removed persistent
flow/wave engine — `compile_waves` is a pure orchestrator-side function, not a generated script
or a standing state machine, and the manual protocol below is **retained** as the documented
fallback (Q2 / ADR-0053) — used whenever the opt-in conditions below don't hold.

**Selection condition (all of the following must hold):**
1. `${WORKSPACE}/plans/${slug}/task-dag.yaml` exists.
2. The DAG is single-wave — no task has a non-empty `depends_on` (`compile_waves` errors closed
   on any `depends_on`; multi-wave dependency-ordered execution is deferred to Inc-2, which needs
   an orchestrator probe on inter-wave worktree provisioning before it can be designed).
3. The user has opted into workflow orchestration for this build.
4. The `Workflow` tool is available in the current session.

Any condition failing → fall back to the manual protocol below (or HITL if `Workflow` is
unavailable mid-build).

**Boundary sequence:**
1. `compile_waves({ workspace, slug, base_commit, build_worktree })` → returns
   `{ envelope, worktrees_to_create }`, or a fail-closed `INVALID_INPUT` error (never a partial
   envelope) when the DAG is invalid or multi-wave.
2. Orchestrator **pre-creates** each Canon-owned worktree from `worktrees_to_create`:
   `git worktree add <worktree_path> -b <branch> <base_commit>` per entry.
3. Invoke `Workflow({ scriptPath: "workflows/canon-waves.js", args: envelope })` — name-based
   resolution is not built (no `.claude/workflows/` install pipeline exists), so `scriptPath` is
   mandatory.
4. On return: **independently git-verify** the merge — N+1 parents on the merge commit, and a
   per-file `git diff {base_commit}` for every task's declared file — never trust the runner's
   self-reported `status: 'ok'` alone, matching the probe's verification discipline.
5. Journal per-task via `batch_log_steps` from the runner's structured return (boundary
   journaling — the sandboxed script body has no MCP access, so journaling happens here, not
   inside the script).
6. Run the deterministic Bash gates (`hooks/dead-wire-gate.sh`, `hooks/summary-diff-check.sh`,
   etc. — see root `CLAUDE.md` Step Enforcement Contracts) against the merged build worktree at
   this boundary.
7. On merge conflict or a `blocked`/`partial` worker → surface the existing merge-conflict HITL
   (no mid-run HITL inside the Workflow segment — this IS segment-at-gates in its minimal,
   already-validated form: gates sit at the segment's boundaries, not inside it).

**Out of increment-1 scope** (deferred, not assumed): multi-wave dependency-ordered execution
(Inc-2); full multi-segment segment-at-gates with gate-answer-parameterized `args` (Inc-3);
`ingest_workflow_run` + provenance audit + runId-aware `reconcile_workspace` (Inc-4); engine
default-on flip for the `implement-waves` step type (Inc-5).

## Manual protocol (fallback)

When `${WORKSPACE}/plans/${slug}/task-dag.yaml` exists, use parallel dispatch via agent teams. Each entry has `task_id`, `depends_on: []`, `files: []`. If absent, fall back to sequential execution.

> **Supported execution model (current).** The live, exercised path is **single-worktree sequential execution**: `init_workspace` creates one `{workspace}/worktree` and all code-writing agents share it. The worktree-per-task parallel-wave path described below (per-task `canon-task/{task_id}` worktrees + sequential merge) is documented as the intended shape but is **not currently backed by automated tooling** — the wave-lifecycle helpers (`createWaveWorktrees`/`mergeWaveResults`/`cleanupWorktrees`) were removed in PR #167. Until they are deliberately rebuilt (see `docs/explore/adaptive-queen.md` revisit trigger), run the merge steps below as explicit git operations, or prefer sequential execution. Do not reintroduce calls to the removed helpers.

**Validate DAG** (via `dag-validator.ts` in `mcp-server/src/shared/lib/`): no cycles, all `depends_on` refs resolve, no self-references. On failure: present errors, re-spawn architect.

## Task Queue Setup

1. (No team-creation step. As of harness v2.1.178 there is exactly one implicit team per
   session; `TeamCreate`/`TeamDelete` no longer exist and the `team_name` input on the
   Agent tool is accepted but ignored.)
2. For each node: `TaskCreate({ subject: task_id, description: <enrichment payload> })`. Enrichment: `resolve_agent_skills("engineer")` + `get_context(include: ["principles", "file_context"])` + task plan content + worktree/provenance instructions. For `depends_on` tasks: `TaskUpdate({ addBlockedBy: [...] })`.

## Worker Dispatch

> **Anti-pattern**: Do NOT substitute parallel Agent spawns for task-queue dispatch. Raw Agent spawns bypass dependency tracking and task queue visibility. When `task-dag.yaml` exists and the step is `implement`, always register the work in the shared task queue (TaskCreate/TaskUpdate) and spawn workers as named teammates (Agent({ name })). The `dag-dispatch-guard.sh` hook (advisory, L1) will warn on raw Agent spawns during DAG execution.

**Single-task guard**: Each worker may claim AT MOST one task per session. After marking a task completed (step 8), workers must NOT call `TaskList` again. The loop (step 2 in the worker prompt) applies only if no task was available on the first `TaskList` call (retry-until-available pattern). If a worker finds tasks remaining after completing its own task, it MUST stop and report DONE — the remaining tasks belong to peer workers.

**Task-queue invariant**: A single canon:engineer subagent MUST NOT be used as a substitute for the task queue when task-dag.yaml exists. The journal `step_id` for the implement phase of a DAG build must not appear as a single `engineer` entry — it should appear as N per-task entries or be absent from the build journal (per-task journals are separate). If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is unset, `Agent({ name })` teammates are unavailable — degrade to sequential single-worktree dispatch (the live path) or HITL. **Availability-guard design note (no runtime code today):** a future guard triggers on the real 2.1.206 signal — env-flag presence AND whether `Agent({ name })` teammate spawns succeed — not on `TeamCreate` registration (that tool is gone). Account for the documented team limitations: no session-resume of in-process teammates (`/resume`/`/rewind` do not restore them), no nested teams (teammates cannot spawn teammates), one team per session.

1. Spawn N workers (= root task count, capped at 5): `Agent({ name: "worker-{N}", subagent_type: "canon:engineer" })` (`team_name` is accepted but ignored — there is one implicit team per session).
2. Worker prompt: fill `templates/worker-prompt.md` with `${TEAM_NAME}`, `${WORKER_NAME}`, `${PROJECT_DIR}`, `${WORKSPACE}`, `${SLUG}`, `${CANON_PARENT_WORKSPACE}` (workspace path minus `{projectDir}/.canon/workspaces/` prefix — needed for L4 hook authorization), `${BUILD_BASE_COMMIT}` (= base_commit from init_workspace, the git SHA the build worktree was created from).
3. Workers create their own worktrees: path `{projectDir}/.canon/worktrees/{task_id}`, branch `canon-task/{task_id}`, branched from `${BUILD_BASE_COMMIT}` (not HEAD).
4. Complex tasks: pass `model: "opus"`.

## Merge Protocol

After `TaskList` is empty (all done):

1. In alphabetical `task_id` order, merge each completed task branch into the build worktree: `git merge --no-ff canon-task/{task_id}` (run from `buildWorktreePath`).
2. **Post-merge verification**: For each task, `git diff {base_commit} -- {file}` for every declared file. Empty diff = no committed changes = task failed → retry (one retry, then HITL).
3. Conflict: `git merge --abort` auto-runs → HITL: `"Merge conflict in task {task_id} affecting files: {files}."`.
4. Remove each task worktree (`git worktree remove {projectDir}/.canon/worktrees/{task_id}`) and delete its branch (`git branch -d canon-task/{task_id}`). Cleanup of the implicit team is automatic on session exit — there is no TeamDelete step.

**Key asymmetry**: merges target `buildWorktreePath`; cleanup uses `projectDir`.

## Post-DAG Tail

Run sequentially after all tasks: review → context-sync → ship → learn. These are NOT DAG nodes.

## Failure Handling

| Failure | Action |
|---------|--------|
| Task failure | Re-create via `TaskCreate`. One retry, then HITL. |
| Merge conflict | HITL with conflict details. |
| Team stalled | All remaining tasks blocked, none in-progress. HITL listing blocked tasks + unmet dependencies. |
| Validation failure | Present errors, re-spawn architect. |
| Race condition | Two workers claim same task. Discard later result. |
