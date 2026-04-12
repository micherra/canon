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
