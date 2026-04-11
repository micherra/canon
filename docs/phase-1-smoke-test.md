# Phase 1 Smoke Test Log

Status: passed (foundation-level) on 2026-04-10.
Branch: `claude/canon-agent-teams-migration-gICh6` (session-configured; semantically equivalent to `canon/agent-teams-phase-1` per the migration plan).
Related: `docs/agent-teams-migration-plan.md` §7 deliverables and §8 validation.

This document captures the end-to-end smoke test for Phase 1 of the Canon → agent teams migration. It validates that the foundation code paths (runbook loader, spawn-prompt assembly, workspace state file writer, and the three hook scripts) produce the expected four-artifact set for the `fast-path` runbook and that the hooks correctly block missing artifacts.

---

## 1. Scope and non-scope

### In scope for this smoke test

- Loading the real `skills/canon/runbooks/fast-path.yaml` via `loadAndPlan`.
- Walking the runbook, assembling per-step spawn prompts, and writing the workspace-local state files the hooks depend on.
- Exercising all three hooks (`artifact-enforce.sh`, `idle-backstop.sh`, `observability.sh`) against a fixture workspace, positive and negative paths.
- Verifying the four expected artifacts (research synthesis, plan index, implementation summary, review) land at their canonical paths.
- Verifying the feature-flag gate: with `CANON_AGENT_TEAMS_MODE` unset or `off`, hooks are no-ops and lead-mode code is never imported by the existing `drive_flow` path.

### Explicitly out of scope for Phase 1

- **Live Claude Code team lead execution.** Running `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` end-to-end against Claude Code v2.1.32+ is deferred to the Phase 1 handoff environment, which has the required Claude Code build. The planner is fully exercised here; the live-team portion is validated by the Phase 2 smoke-test harness.
- **Phase 2 and later flows.** Only `fast-path` is converted in Phase 1.
- **Any behavior change when `CANON_AGENT_TEAMS_MODE` is not `on`.** Verified via the baseline-diff check in section 5.

---

## 2. Fixture setup

A disposable workspace was created under `$TMPDIR` with the same subdirectory layout `init_workspace` writes today:

```
/tmp/canon-phase-1-smoke-<hash>/
├── progress.md              # header "## Progress: Phase 1 smoke test"
├── research/
├── plans/
├── reviews/
└── decisions/
```

Environment:

```bash
export CANON_AGENT_TEAMS_MODE=on
export CANON_WORKSPACE_DIR=/tmp/canon-phase-1-smoke-<hash>
```

Target files (pinned into the spawn prompts):

```
src/example.ts
src/example.test.ts
```

---

## 3. Smoke test harness

A small Node harness lives at `mcp-server/scripts/phase-1-smoke-test.mjs`. It imports `lead-mode.ts` via tsx, calls `loadAndPlan` against the real runbook, writes the state files, simulates artifact creation for each step, and prints the workspace tree. It is advisory-only and produces no persistent side effects outside `$TMPDIR`.

Run:

```bash
cd mcp-server
npx tsx scripts/phase-1-smoke-test.mjs
```

---

## 4. Run transcript

### 4.1 Planner output

```
=== Phase 1 smoke test ===
plugin_dir: /home/user/canon
workspace_dir: /tmp/canon-phase-1-smoke-<hash>
task_list_id: canon-phase-1-smoke

loaded runbook: fast-path (small)
descriptors: 4
  - fast-path-00-canon-researcher   role=canon-researcher   artifact=research_synthesis    hitl=false
  - fast-path-01-canon-architect    role=canon-architect    artifact=plan_index            hitl=after
  - fast-path-02-canon-implementor  role=canon-implementor  artifact=implementation_summary hitl=false
  - fast-path-03-canon-reviewer     role=canon-reviewer     artifact=review                hitl=after_if_verdict_not_clean
```

Observations:

- Four descriptors produced, matching the four steps of the fast-path runbook.
- Task ids follow the `<runbook>-<NN>-<role>` convention and are stable across re-runs.
- HITL policies are preserved from the runbook.
- `task_list_id` derived deterministically as `canon-<workspace_id>`.

### 4.2 State files

`writeTaskArtifactState` produced the two files the hooks consume:

```
/tmp/canon-phase-1-smoke-<hash>/agent-teams/task-artifacts.json
/tmp/canon-phase-1-smoke-<hash>/agent-teams/teammate-artifacts.json
```

`task-artifacts.json`:

```json
{
  "fast-path-00-canon-researcher":   { "role": "canon-researcher",   "artifact": "research_synthesis",     "artifact_path": "research/SYNTHESIS.md" },
  "fast-path-01-canon-architect":    { "role": "canon-architect",    "artifact": "plan_index",             "artifact_path": "plans/INDEX.md" },
  "fast-path-02-canon-implementor":  { "role": "canon-implementor",  "artifact": "implementation_summary", "artifact_path": "plans/SUMMARY.md" },
  "fast-path-03-canon-reviewer":     { "role": "canon-reviewer",     "artifact": "review",                 "artifact_path": "reviews/REVIEW.md" }
}
```

`teammate-artifacts.json` mirrors the same data keyed by teammate name (role).

### 4.3 First spawn prompt (full)

This is the prompt the lead would hand to Claude Code when spawning `canon-researcher`:

```
# Canon teammate: canon-researcher

Task type: `research` · Workspace: `phase-1-smoke`

## Role brief

Investigate the target files and surrounding code. Do NOT write code. Produce a compressed findings document under the artifact path below.

## Target files

- `src/example.ts`
- `src/example.test.ts`

## Upstream artifacts

_No upstream artifacts — this is an entry-point step._

## Canon principles

Consult the principles layer before acting. Rules are blocking; strong-opinions require justification to deviate; conventions are advisory. Cite principle ids in your artifact when they informed a decision.

## Task-completion contract

You are acting as **canon-researcher**.

## Required artifact

- **Research synthesis** (id: `research_synthesis`)
- Must exist under the workspace at: `.canon/workspaces/phase-1-smoke/research/SYNTHESIS.md`
- Follow the template: `templates/research-synthesis.md`

## Completion rules

1. Produce the artifact at the exact path above. The `TaskCompleted` hook blocks task completion if the file is missing or empty.
2. Mark your task complete (via the task list) only after the artifact is written.
3. If you cannot produce the artifact, leave the task in-progress and emit a short explanation instead of forcing completion.
```

### 4.4 Final workspace tree

After the harness simulated artifact creation for each step:

```
agent-teams/
  task-artifacts.json
  teammate-artifacts.json
decisions/
plans/
  INDEX.md
  SUMMARY.md
progress.md
research/
  SYNTHESIS.md
reviews/
  REVIEW.md
```

All four expected artifacts are present at the canonical paths declared in `ROLE_ARTIFACT_CONTRACTS`.

### 4.5 Task-list exercise

After the artifact tree is populated, the harness seeds a fake `tasks_root` inside the workspace (so the real `~/.claude/tasks/` is untouched) and walks through two task-list stages to exercise `summarizeTaskList` and `filterPendingDescriptors`:

```
--- task-list exercise ---
stage 1 (all pending):
  total: 4
  by_status: {"pending":4}
  path: /tmp/canon-phase-1-smoke-<hash>/fake-tasks-root/canon-phase-1-smoke
  filterPendingDescriptors: 4 pending

stage 2 (first two completed — simulating resume):
  total: 4
  by_status: {"completed":2,"pending":2}
  filterPendingDescriptors: 2 pending — canon-implementor, canon-reviewer
```

Stage 1 stages a "fresh run" — every descriptor maps to a `pending` task file. `summarizeTaskList` counts them per status and `filterPendingDescriptors` returns all four (nothing completed yet).

Stage 2 rewrites the researcher and architect task files to `completed` — simulating what a mid-run resume would see on disk after a prior session finished the first two steps. `summarizeTaskList` now reports the mixed state, and `filterPendingDescriptors` returns only the implementor and reviewer descriptors, which is exactly the subset a resuming team lead must re-spawn.

This gives the `task-list` domain module its first end-to-end smoke coverage outside of unit tests, and proves that the cross-session resume story described in `docs/agent-teams-mode.md §"Cross-session resume"` has a working server-side implementation point.

---

## 5. Hook execution traces

Each hook was exercised against the fixture workspace above.

### 5.1 `artifact-enforce.sh` — positive (artifact present)

Input (stdin): `{"task_id":"fast-path-00-canon-researcher","session_id":"test"}`

Result: exit 0, no output. Allows the `TaskCompleted` event to proceed.

### 5.2 `artifact-enforce.sh` — negative (artifact deleted)

Input: same as above, but `research/SYNTHESIS.md` was removed first.

Output:
```
CANON_AGENT_TEAMS: TaskCompleted blocked.
Expected artifact is missing or empty:
  research/SYNTHESIS.md
Workspace: /tmp/canon-phase-1-smoke-<hash>
Task: fast-path-00-canon-researcher (session test)
Produce the artifact before marking the task complete.
```

Exit: 2. Claude Code sees the feedback on stderr and re-prompts the teammate.

### 5.3 `idle-backstop.sh` — negative (idle teammate with no artifact)

Input: `{"teammate_name":"canon-researcher","team_name":"t1"}`

Output:
```
CANON_AGENT_TEAMS: TeammateIdle backstop tripped.
Teammate canon-researcher (team t1) went idle without producing:
  research/SYNTHESIS.md
Workspace: /tmp/canon-phase-1-smoke-<hash>
Re-prompt the teammate with a pointer to the expected artifact path.
```

Exit: 2. Lead receives the feedback and re-prompts rather than letting the teammate go dark.

### 5.4 `observability.sh` — SubagentStart

Input: `{"hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"canon-researcher"}`

Exit: 0, no stdout. One JSONL line appended to `events.jsonl`:

```
{"ts":"2026-04-10T05:15:25Z","event":"SubagentStart","payload":"{\"hook_event_name\":\"SubagentStart\",\"agent_id\":\"a1\",\"agent_type\":\"canon-researcher\"}"}
```

The event type is inferred from the `hook_event_name` field when present, with fallbacks for `SubagentStop`, `TeammateIdle`, and `SubagentStart` based on payload shape.

### 5.5 Feature-flag off (no-op)

Input: same as 5.2 (missing artifact), but with `CANON_AGENT_TEAMS_MODE=off`.

Exit: 0, no output. Confirms the gate at the top of each hook short-circuits before any workspace lookup.

---

## 6. Unit test validation

Run from `mcp-server/`:

```
./node_modules/.bin/vitest run \
  src/domains/spawn/ \
  src/domains/task-list/ \
  src/features/orchestration/__tests__/lead-mode.test.ts
```

Result: 3 test files, 72 cases, 0 failures, 0 warnings.

---

## 7. Regression check (CANON_AGENT_TEAMS_MODE off)

Per `docs/agent-teams-migration-plan.md` §8.3: "running the existing Canon test suite with `CANON_AGENT_TEAMS_MODE` unset produces a diff of zero bytes from baseline behavior."

### 7.1 Method

The new Phase 1 code is not imported from any existing module:

- `mcp-server/src/domains/spawn/` — no imports of it from outside Phase 1 code.
- `mcp-server/src/domains/task-list/` — no imports of it from outside Phase 1 code.
- `mcp-server/src/features/orchestration/lead-mode.ts` — not imported by `register-orchestration.ts` or any runtime path. Confirmed by greping the source tree for `lead-mode` before committing.

Because the existing `drive_flow` path does not reference any Phase 1 module, the runtime behavior with the flag unset is structurally identical to HEAD before the Phase 1 commits.

### 7.2 Test suite comparison

`./node_modules/.bin/vitest run` was executed twice: once on `HEAD~3` (pre-Phase-1) and once on `HEAD` (with all Phase 1 commits applied, but with `CANON_AGENT_TEAMS_MODE` unset). Both runs produced the same set of failing tests, meaning Phase 1 introduces zero regressions:

| Pre-existing failing test file | Cause (observed in both baseline and HEAD) |
|--------------------------------|---------------------------------------------|
| `src/domains/workspaces/__tests__/wave-lifecycle.test.ts` | Environmental: tests create temp git repos; subprocess `git init` / `git commit` cannot run cleanly in the CI-like sandbox. Error surface: `fatal: invalid reference: HEAD`. |
| `src/features/knowledge-graph/__tests__/codebase-graph-integration.test.ts` | Environmental: same root cause — `execSync('git commit ...')` fails because no author identity / no commits possible in the harness. |
| `src/features/orchestration/__tests__/consultation-pipeline-debate.test.ts` | Pre-existing TS type drift: the test still passes `summaries` to `WaveBriefingInput`, which was removed from the type at an earlier refactor. Surfaces as a `tsc` error, not a runtime failure; vitest still runs via the bundler path. |
| `src/platform/storage/drift/__tests__/drift-db-analytics.test.ts` | Pre-existing TS type error: `Cannot find namespace 'Database'`. Unrelated to Phase 1. |

These issues existed on `HEAD~3` (before the Phase 1 commits landed) and continue to exist on `HEAD`. They are called out in each of the Phase 1 commit messages so the human reviewer can decide whether to triage them separately. Phase 1 has **not** attempted to fix them because doing so would modify existing files, which is out of scope per `docs/agent-teams-migration-plan.md` §11.

### 7.3 Build check

```
npm run build
```

Produces the same 5 pre-existing TypeScript errors on both baseline and HEAD:

```
src/features/orchestration/__tests__/consultation-pipeline-debate.test.ts(279,7): error TS2353: ... 'summaries' does not exist in type 'WaveBriefingInput'.
src/features/orchestration/__tests__/consultation-pipeline-debate.test.ts(300,7): error TS2353: (same)
src/features/orchestration/__tests__/consultation-pipeline-debate.test.ts(318,7): error TS2353: (same)
src/features/orchestration/__tests__/consultation-pipeline-debate.test.ts(341,7): error TS2353: (same)
src/platform/storage/drift/__tests__/drift-db-analytics.test.ts(47,26): error TS2503: Cannot find namespace 'Database'.
```

No errors point at Phase 1 files. Confirmed by grep:

```
npm run build 2>&1 | grep -E "spawn|task-list|lead-mode"
(no output)
```

---

## 8. Summary

- All four fast-path artifacts land at their canonical paths under `.canon/workspaces/<id>/`.
- `task-artifacts.json` and `teammate-artifacts.json` carry the data the hooks need.
- `artifact-enforce.sh` allows completion when the artifact is present and blocks with exit 2 when it is missing.
- `idle-backstop.sh` blocks an idle teammate when its artifact is missing.
- `observability.sh` writes one JSONL event per call with no blocking behavior.
- The feature flag is honored: hooks no-op and the lead-mode module is unreachable when `CANON_AGENT_TEAMS_MODE` is not `on`.
- 72 new unit tests pass. No Phase 1 code appears in any pre-existing failing test.
- `npm run build` and `npm test` produce the same failures on HEAD as on the baseline; zero regressions attributable to Phase 1.

The live team-lead end-to-end test (spawning actual teammates via Claude Code v2.1.32+) is left for the Phase 1 → Phase 2 handoff environment, which is the first place a capable Claude Code build is available.
