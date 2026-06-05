---
name: dag-execution-protocol
description: >-
  Full DAG execution protocol for Canon parallel builds. Covers DAG
  validation, Task Queue Setup, Worker Dispatch (TeamCreate/TaskCreate),
  Merge Protocol, Post-DAG Tail, and Failure Handling. Read before any
  build where task-dag.yaml exists or before TeamCreate/merge/cleanup.
model: sonnet
color: white
---

# DAG Execution Protocol

Read this file BEFORE executing any build where `${WORKSPACE}/plans/${slug}/task-dag.yaml` exists, and before any TeamCreate/merge/cleanup operation. See `CLAUDE.md` for the stub pointer.

When `${WORKSPACE}/plans/${slug}/task-dag.yaml` exists, use parallel dispatch via agent teams. Each entry has `task_id`, `depends_on: []`, `files: []`. If absent, fall back to sequential execution.

> **Supported execution model (current).** The live, exercised path is **single-worktree sequential execution**: `init_workspace` creates one `{workspace}/worktree` and all code-writing agents share it. The worktree-per-task parallel-wave path described below (per-task `canon-task/{task_id}` worktrees + sequential merge) is documented as the intended shape but is **not currently backed by automated tooling** — the wave-lifecycle helpers (`createWaveWorktrees`/`mergeWaveResults`/`cleanupWorktrees`) were removed in PR #167. Until they are deliberately rebuilt (see `docs/explore/adaptive-queen.md` revisit trigger), run the merge steps below as explicit git operations, or prefer sequential execution. Do not reintroduce calls to the removed helpers.

**Validate DAG** (via `dag-validator.ts` in `mcp-server/src/shared/lib/`): no cycles, all `depends_on` refs resolve, no self-references. On failure: present errors, re-spawn architect.

## Task Queue Setup

1. `TeamCreate({ team_name: "canon-{slug}" })`
2. For each node: `TaskCreate({ title: task_id, description: <enrichment payload> })`. Enrichment: `resolve_agent_skills("engineer")` + `get_context(include: ["principles", "file_context"])` + task plan content + worktree/provenance instructions. For `depends_on` tasks: `TaskUpdate({ addBlockedBy: [...] })`.

## Worker Dispatch

> **Anti-pattern**: Do NOT substitute parallel Agent spawns for team dispatch. Raw Agent spawns bypass dependency tracking and task queue visibility. When `task-dag.yaml` exists and the step is `implement`, always use `TeamCreate`/`TaskCreate` for worker dispatch. The `dag-dispatch-guard.sh` hook (advisory, L1) will warn on raw Agent spawns during DAG execution.

**Single-task guard**: Each worker may claim AT MOST one task per session. After marking a task completed (step 8), workers must NOT call `TaskList` again. The loop (step 2 in the worker prompt) applies only if no task was available on the first `TaskList` call (retry-until-available pattern). If a worker finds tasks remaining after completing its own task, it MUST stop and report DONE — the remaining tasks belong to peer workers.

**TeamCreate invariant**: A single canon:engineer subagent MUST NOT be used as a substitute for TeamCreate when task-dag.yaml exists. The journal `step_id` for the implement phase of a DAG build must not appear as a single `engineer` entry — it should appear as N per-task entries or be absent from the build journal (per-task journals are separate). If the orchestrator cannot call TeamCreate, it must HITL before proceeding.

1. Spawn N workers (= root task count, capped at 5): `Agent({ team_name: "canon-{slug}", name: "worker-{N}", subagent_type: "canon:engineer" })`.
2. Worker prompt: fill `templates/worker-prompt.md` with `${TEAM_NAME}`, `${WORKER_NAME}`, `${PROJECT_DIR}`, `${WORKSPACE}`, `${SLUG}`, `${CANON_PARENT_WORKSPACE}` (workspace path minus `{projectDir}/.canon/workspaces/` prefix — needed for L4 hook authorization), `${BUILD_BASE_COMMIT}` (= base_commit from init_workspace, the git SHA the build worktree was created from).
3. Workers create their own worktrees: path `{projectDir}/.canon/worktrees/{task_id}`, branch `canon-task/{task_id}`, branched from `${BUILD_BASE_COMMIT}` (not HEAD).
4. Complex tasks: pass `model: "opus"`.

## Merge Protocol

After `TaskList` is empty (all done):

1. In alphabetical `task_id` order, merge each completed task branch into the build worktree: `git merge --no-ff canon-task/{task_id}` (run from `buildWorktreePath`).
2. **Post-merge verification**: For each task, `git diff {base_commit} -- {file}` for every declared file. Empty diff = no committed changes = task failed → retry (one retry, then HITL).
3. Conflict: `git merge --abort` auto-runs → HITL: `"Merge conflict in task {task_id} affecting files: {files}."`.
4. Remove each task worktree (`git worktree remove {projectDir}/.canon/worktrees/{task_id}`) and delete its branch (`git branch -d canon-task/{task_id}`), then `TeamDelete({ team_name: "canon-{slug}" })`.

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
