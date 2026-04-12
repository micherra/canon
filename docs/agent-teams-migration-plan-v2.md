# Canon → Agent Teams Migration Plan v2

**Status:** proposed — supersedes v1 (`docs/agent-teams-migration-plan.md`)
**Owner:** Canon maintainers
**Last updated:** 2026-04-12
**Source material:** `docs/v2-plan-kickoff-prompt.md` on `canon/agent-teams-phase-2`; 28-gap integration audit (2026-04-11)
**Supersedes:** `docs/agent-teams-migration-plan.md` (v1, 2026-04-10)

---

## 1. Context

### What v1 got right

The v1 plan correctly identified six durable ideas:

1. **Runbooks as data-over-code.** Linear YAML for straight pipelines is simpler than a state-machine runtime. Escalation to branching only when needed.
2. **Hook-based artifact enforcement.** `TaskCompleted` + `TeammateIdle` hooks with workspace-local state files is a clean enforcement channel.
3. **Pinned task list for cross-session resume.** `CLAUDE_CODE_TASK_LIST_ID` + `~/.claude/tasks/<id>/` as the durable work-unit substrate.
4. **Feature-flag gating.** `CANON_AGENT_TEAMS_MODE=off` must remain byte-identical to the legacy `drive_flow` path throughout the migration.
5. **Phased rollout with scoped boundaries.** One migration step at a time, each independently verifiable.
6. **Principles and artifacts as the engine's product.** Canon's differentiation lives in those two layers; the coordination layer is commodity scheduling.

### What v1 got wrong

The v1 hypothesis (§2) stated:

> The coordination layer is overbuilt. Most of `drive_flow`, the flow YAML runtime, wave semantics, wave events, and `post_message` / `get_messages` exists to compensate for coordination primitives Claude Code did not previously expose.

This is true about *scheduling* but wrong about *composition*. The v1 plan scoped the migration as "replace the `drive_flow` state machine with runbooks" and treated everything else as internal plumbing that would "fall out" during Phase 4 deletion. In reality, `drive_flow` is not just a scheduler — it is the composition surface for approximately 20 cross-cutting services that produce Canon's user-visible behavior:

- **Prompt pipeline** — a 9-stage functional pipeline (`features/prompt-pipeline/`) that transforms a state definition into spawn-ready prompts, including context injection, variable substitution, template loading, wave briefing, fanout by state type, coordination injection (commit provenance, metrics, tool scope), and validation.
- **Context enrichment** — `orchestration/services/context-enrichment.ts` assembles a four-section enrichment block (Recent Changes, Drift Signals, Prior Work, Tensions) from git log, DriftStore, sibling artifacts, and cross-references.
- **Tool profile resolution** — `prompt-pipeline/model/tool-profiles.ts` maps each Canon role to allowed/disallowed tools, permission mode, and write scope (ADR-014).
- **Worktree lifecycle** — `domains/workspaces/wave-lifecycle.ts` creates per-task Git worktrees, merges wave results with configurable strategy, and cleans up on completion.
- **Auto-approve settings injection** — `prompt-pipeline/services/worktree-settings.ts` writes `.claude/settings.local.json` into each agent's worktree.
- **File claims** — `shared/lib/file-claims.ts` prevents concurrent workflows from stomping the same files.
- **Commit trailers** — `shared/lib/commit-trailers.ts` adds Canon-Workflow / Canon-Agent / Canon-State / Canon-Task provenance to every commit.
- **HITL breakpoints** — five distinct breakpoint shapes across convergence exhaustion, gate failure, merge conflicts, approval gates, and paused wave events.
- **Wave policy** — `WavePolicy { isolation, merge_strategy, on_conflict, gate, coordination }` drives merge behavior and inter-wave gates.
- **Post-state effects** — `orchestration/engine/effects.ts` runs `persist_review` and `check_postconditions` after state completion.
- **Session continuation** — `applySessionContinuation` (ADR-009a) injects `continue_from` for context continuity on resume.
- **Flow event channel** — `drainFlowEvents` reads mid-flow agent events (insert, skip, escalate) and returns override actions.
- **Learn gate** — `services/learn-gate.ts` evaluates whether `canon-learner` auto-triggers at flow completion.
- **Flow analytics** — `update_board complete_flow` aggregates metrics into `FlowRunEntry` via DriftStore.

The v1 plan's Phase 2 code (`lead-mode.ts` on `canon/agent-teams-phase-2`) produced a `SpawnDescriptor` carrying only `role`, `task_type`, `task_id`, `spawn_prompt`, `artifact`, `artifact_path`, `hitl` (a string enum), and `required_artifacts`. It carried none of: `tools`, `disallowed_tools`, `permission_mode`, `worktree_path`, `continue_from`, wave policy, enrichment, principles, or commit provenance. An integration audit found **27 real gaps plus one already-known auto-approve gap** — 11 HIGH, 11 MEDIUM, 5 LOW severity. Phases 1 and 2 collectively provided roughly 10–15% of what `drive_flow` actually does at spawn time.

**Phase 1 and Phase 2 are abandoned.** Their code lives on `canon/agent-teams-phase-2` and `claude/canon-agent-teams-migration-gICh6` as read-only reference. The only v1 artifact on main is `docs/agent-teams-migration-plan.md`.

---

## 2. Target Architecture Overview

The v2 architecture is not "lead-mode.ts as a pure planner." It is a four-layer replacement that preserves every integration `drive_flow` currently composes, on the agent-teams substrate.

### 2.1 Runbook Loader (data layer)

Reads a declarative YAML runbook from `skills/canon/runbooks/<name>.yaml`. Runbooks describe *what* to do — roles, artifacts, dependencies, HITL gates, wave policy — but contain no execution logic. This layer is unchanged from v1 and already exists on the Phase 2 branch (`parseRunbook` in `lead-mode.ts`).

### 2.2 Plan-Time Pipeline (composition layer)

This is the layer v1 missed entirely. It takes a parsed runbook + workspace state and produces **fully-hydrated spawn descriptors** — prompts that carry everything the legacy 9-stage prompt pipeline produces today. The pipeline has explicit stages, each with a named responsibility:

1. **Workspace bootstrap** — create workspace directory, seed `progress.md`, build cache prefix, run preflight checks (claim overlaps, active-workspace detection). Replaces `init_workspace`.
2. **Worktree creation** — for wave steps, create per-task Git worktrees under `.canon/worktrees/<task_id>/` with `canon-wave/{task_id}` branches. Replaces `createWaveWorktrees`.
3. **Principle resolution** — match principles to step scope by files/layers/tags/severity via `shared/matcher.ts`. Inject full principle bodies into the spawn prompt. Replaces the principle-loading path in `assemblePrompt` stage 1 → `resolveContextInjections`.
4. **Context enrichment** — assemble the four-section enrichment block (Recent Changes, Drift Signals, Prior Work, Tensions). Replaces `assembleEnrichment` in `context-enrichment.ts`.
5. **Tool profile resolution** — resolve each role's allowed/disallowed tools, permission mode, and write scope via `resolveToolProfile`. KG-informed trust computation when available. Replaces stage 8 of the prompt pipeline (`inject-coordination.ts`).
6. **Auto-approve settings injection** — write `.claude/settings.local.json` into each agent's worktree when `permission_mode === "auto"`. Replaces `injectWorktreeSettings`.
7. **Commit provenance** — format `Canon-Workflow / Canon-Agent / Canon-State / Canon-Task` trailers and inject a `## Commit Provenance` section. Replaces `buildProvenanceSection` in `commit-trailers.ts`.
8. **Session continuation** — check for a live agent session < 10 min old; if found, inject `continue_from: { agent_id, context_summary }`. Replaces `applySessionContinuation` (ADR-009a).
9. **Wave briefing** — for wave 2+ steps, inject prior-wave summaries and consultation briefing. Replaces `inject-wave-briefing.ts` stage 6.
10. **Consultation pre-briefing** — resolve `before` / `between` consultation prompts and inject advisory output. Replaces `consultation-executor.ts`.
11. **File claims registration** — register affected files in `.canon/claims.json` for this workflow. Replaces `registerClaims` in `file-claims.ts`.
12. **HITL classification** — classify each step's breakpoint config into one of five breakpoint shapes (post-verdict, approval gate, convergence exhausted, gate failure, wave pause). Replaces the distributed HITL logic across `drive-flow-helpers.ts`.
13. **Prompt validation** — scan for unresolved `${...}` references. Replaces stage 9 (`validate.ts`).

The output is an ordered list of `HydratedDescriptor` objects — the v2 replacement for `SpawnRequest`. Each descriptor carries the full spawn prompt plus all metadata the run-time coordinator and hooks need.

### 2.3 Run-Time Coordinator (execution layer)

Watches the Claude Code task list, receives hook events (`TaskCompleted`, `TeammateIdle`, `SubagentStart/Stop`), and drives the team-lead loop:

- **Spawn teammates** from hydrated descriptors in dependency order.
- **Enforce artifacts** via `TaskCompleted` hook — exit 2 with feedback if the expected artifact doesn't exist.
- **Present HITL breakpoints** to the user when a step's breakpoint config requires it (e.g., post-review verdict inspection, architect approval gate).
- **Drive wave advancement** — after all wave-N tasks complete, merge worktrees per wave policy, then plan and spawn wave N+1.
- **Execute post-state effects** — `persist_review` (write to DriftStore), `check_postconditions` (run contract-checker assertions). Replaces `executeEffects` in `engine/effects.ts`.
- **Handle inter-wave gates** — run shell gates between waves per `wave_policy.gate`. Replaces `WavePolicy.gate` evaluation.
- **Drain flow events** — read mid-flow agent events (insert, skip, escalate) and apply override actions. Replaces `drainFlowEvents`.
- **Detect stuck states** — monitor iteration count against `max_iterations` / `max_revisions` caps. Replaces legacy convergence/stuck detection.

### 2.4 Completion Phase (teardown layer)

Runs after the final step completes or the flow is aborted:

- **Learn gate evaluation** — call `evaluateLearnGate(projectDir)` to decide whether `canon-learner` auto-triggers (ADR-016). Replaces `learn-gate.ts`.
- **Flow analytics** — aggregate gate/postcondition/violation/test metrics across all steps into a `FlowRunEntry` via `DriftStore.appendFlowRun`. Replaces `update_board complete_flow`.
- **Claims release** — call `releaseClaims(projectDir, workflow)` to free all file claims. Replaces the release path in `update_board`.
- **Agent metrics persistence** — write accumulated `tool_calls`, `orientation_calls`, `turns` from all agents. Replaces `record_agent_metrics`.
- **Drift persistence** — flush any pending review entries to DriftStore. Replaces the `persist_review` effect.
- **Worktree cleanup** — remove `.canon/worktrees/<task_id>/` directories after successful merges. Replaces `cleanupWorktrees`.
- **Team teardown** — clean up Claude Code team state. Codified as "teardown on flow complete."

### Design principle: no silent losses

Every integration in the legacy pipeline maps to a named stage in 2.2, a named responsibility in 2.3, or a named step in 2.4. The integration disposition table (§9) traces each of the 28 audit gaps to its v2 home. If an integration cannot be traced, the plan is incomplete.

### 2.5 Experimental validation (2026-04-12)

Before committing to this architecture, four experiments tested the highest-risk assumptions. All passed.

**Experiment 1: HITL pause/resume between agent spawns.** Hypothesis: the lead session can spawn step 1, receive its result, present an approval gate to the user, then spawn step 2 with step 1's output — without any special lifecycle management. Result: **PASS.** The Agent tool is synchronous from the lead's perspective. The lead spawned a simulated `canon-researcher` (step 1), received `STEP_1_COMPLETE` with an artifact path, then spawned `canon-architect` (step 2) which successfully read step 1's artifact. The interleave-pause-spawn pattern works natively. No team lifecycle complications observed.

**Experiment 2: Spawn prompt size limits.** Hypothesis: a fully-hydrated spawn descriptor (~20–25k chars including principles, enrichment, wave briefing, commit provenance, and task instructions) can be delivered without truncation. Result: **PASS.** A 20,959-byte prompt containing 15 principle bodies, enrichment sections, KG context, wave briefing, and task instructions was delivered intact. The agent confirmed the last principle name (`provenance-traceability`) and last section heading (`Extended Task Context: Implementation Notes from Prior Waves`) matched expectations. No truncation detected.

**Experiment 3: Worktree lifecycle from lead session.** Hypothesis: the lead session can create, list, and remove Git worktrees for wave-task isolation. Result: **PASS.** `git worktree add`, `git worktree list`, and `git worktree remove` all succeeded from the lead session. Merge behavior is already validated in production by `wave-lifecycle.ts` (`createWaveWorktrees`, `mergeWaveResults`, `cleanupWorktrees`).

**Experiment 4: Completion signal and artifact verification.** Hypothesis: the lead session can parse structured completion data from an agent's response and verify artifact existence on disk. Result: **PASS.** The agent returned a parseable `STRUCTURED_RESULT` block with `artifact_written: true`, `artifact_path`, `agent_type`, and `exit_status`. Both artifact and metadata files were confirmed present on disk after the agent completed. This validates the post-step effect trigger: the lead parses the agent's structured response, then runs effects (persist_review, check_postconditions) before spawning the next step.
