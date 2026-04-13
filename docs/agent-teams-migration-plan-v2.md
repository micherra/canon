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

**Experiment 5: Structured flow event channel (teammate → lead).** Hypothesis: an agent can emit structured flow event commands (insert/skip/escalate) that the lead can parse deterministically. Result: **PASS.** The agent emitted three `FLOW_EVENT:TYPE:TARGET:reason=...` lines in its response. The lead parsed all three via simple line-by-line grep. Additionally, the agent wrote a JSON events array to disk. Both channels — inline structured text and artifact files — work for flow event delivery. The inline channel is preferable for latency (available immediately in the agent's response); the file channel is preferable for reliability (survives response truncation). The v2 coordinator should use both: parse inline events first, fall back to the events file.

**Experiment 6: Session continuation across agent spawns.** Hypothesis: agent context persists across sessions for continuation. Result: **CONFIRMED CONSTRAINT — no cross-session memory.** A new agent spawn has zero recall of a prior agent's conversational state. The experiment stored a secret phrase in conversational memory and persisted structured state to disk. On resume (new agent spawn), the secret phrase was lost but disk-persisted state was recoverable. This confirms that the legacy `applySessionContinuation` pattern — passing `continue_from: { agent_id, context_summary }` into the new agent's spawn prompt — is the correct design. Context summaries must be explicit text in the prompt, not implicit memory. The v2 plan-time pipeline stage 8 (session continuation) should inject the prior agent's summary into the new prompt, not attempt to resume the same agent session.

**Experiment 7: Hook timing for artifact enforcement.** Hypothesis: artifact checks can run after agent completion but before the next step spawns, without race conditions. Result: **PASS BY DESIGN.** The Agent tool is synchronous from the lead's perspective: spawn → agent runs → lead receives result. There is no concurrent step overlap. The lead explicitly sequences: (1) receive agent result, (2) verify artifact on disk, (3) run post-state effects, (4) spawn next step. This is deterministic — no timing-dependent hooks needed. In the legacy system, `TaskCompleted` hooks serve this role; in v2, the lead's own control flow between spawns replaces hook-based enforcement. Hook scripts (`artifact-enforce.sh`, `idle-backstop.sh`) remain as a defense-in-depth backstop but are not the primary enforcement channel.

**Experiment 8: Worktree settings injection timing.** Hypothesis: `.claude/settings.local.json` can be written at plan time and read by the agent at spawn time. Result: **CONFIRMED CONSTRAINT — orchestrator must inject before spawn.** An agent spawned into a worktree without pre-written settings could not write its own settings (Write/Bash denied). This proves settings injection is a strict prerequisite: the orchestrator must call `injectWorktreeSettings` and confirm the file exists before dispatching the agent. The legacy pattern (`injectSettingsIntoRequests` runs in `drive_flow` after `buildSpawnRequests` but before returning the spawn action) is exactly right. The v2 plan-time pipeline stage 6 (auto-approve settings injection) must complete before any agent is spawned from the resulting descriptors.

**Experiment 9: Concurrent file claims.** Hypothesis: multiple workflows can register and detect overlapping file claims. Result: **PASS with caveat.** Sequential claim registration works correctly: two workflows claiming overlapping files produced the expected claims map, and overlap detection correctly identified `src/shared/utils.ts` as claimed by both `feature-auth` and `feature-api`. **Caveat:** concurrent read-modify-write has a lost-update risk. If two workflows read `claims.json` simultaneously before either writes back, the last writer silently drops the first writer's claims. The existing `file-claims.ts` uses atomic writes (temp + rename) which prevents corruption but not lost updates. Mitigation: the v2 plan should add optimistic concurrency via the existing `version` field — increment on write, retry on conflict. This is a minor enhancement to `file-claims.ts`, not an architectural change.

#### Roadmap compatibility experiments (10–17)

Eight additional experiments tested whether roadmap items that predate the agent-teams decision can capture their intended behavior on the new substrate.

**Experiment 10: Tool-level loop detection (roadmap item 2).** Hypothesis: the lead can detect per-tool-call loops in a teammate's execution. Result: **POST-HOC ONLY.** The lead has no per-tool-call visibility during agent execution. However, two post-hoc detection channels exist: (a) the Agent tool returns `tool_uses` count in metadata, and (b) the agent can self-report its tool call sequence in its structured response. Additionally, Claude Code's Read tool has built-in deduplication ("File unchanged since last read") which is a weak in-agent signal. Real-time mid-execution loop detection is not possible — the lead must wait for the agent to finish or stall (stream idle timeout ~100s). The v2 plan should implement loop detection as a post-completion check on the agent's self-reported metrics, not as a mid-execution interrupt.

**Experiment 11/14: Timeout, abort, and effort budgets (roadmap items 3 and 16).** Hypothesis: the lead can enforce wall-clock timeouts and tool-call budgets on agents. Result: **CONFIRMED GAP — no enforcement mechanism.** The Agent tool has no `timeout` parameter and no abort/cancel API. The only automatic timeout is the stream idle timeout (~100s), which fires when the agent stalls but not when it's actively working. The Agent tool DOES return `duration_ms` and `tool_uses` in its metadata, enabling post-hoc analysis. Wall-clock durations observed across 11 experiments ranged from 14s to 145s. Mitigation: (a) inject budget instructions into the spawn prompt ("complete within N tool calls; if approaching the limit, summarize and stop"), relying on agent compliance; (b) use `run_in_background` and implement a lead-side polling watchdog that detects long-running agents by elapsed time; (c) advocate for a `timeout` parameter in the Agent tool upstream. Option (a) is available today; option (b) is buildable; option (c) depends on Claude Code roadmap.

**Experiment 12: Agent self-reported metrics (roadmap item 10).** Hypothesis: agents can accurately self-report their tool call counts without an external metrics recording tool. Result: **PASS.** The agent reported `tool_calls: 8` in its structured response; the Agent tool metadata confirmed `tool_uses: 8` — exact match. The agent also correctly categorized calls into orientation (Read/Glob/Grep: 8) vs. write (0). This validates that `record_agent_metrics` can be replaced by a structured response contract: agents include an `AGENT_METRICS:` block in their response, and the lead parses and persists it. No MCP tool access required by the teammate.

**Experiment 13: Mid-execution signaling (roadmap item 15).** Hypothesis: a teammate can signal the lead during execution, not just at completion. Result: **PASS via filesystem polling.** The agent wrote signal files at three distinct timestamps (8-second gaps between them). A lead using `run_in_background` could poll the signal directory and discover urgent signals (e.g., "insert a security review") while the agent is still working. The filesystem is the shared communication channel — both lead and teammate have read/write access. This is event-driven enough for flow adaptation: the lead polls a well-known signal directory, parses JSON signal files, and can decide to spawn additional agents or prepare HITL breakpoints before the signaling agent finishes. Not as clean as a native event channel, but workable.

**Experiment 15: Compaction preservation (roadmap item 1).** Result: **CONFIRMED GAP — reasoning only (not experimentally testable).** Context compaction happens inside an agent's conversation when its context window fills up. There is no compaction hook event for teammates — the lead has zero visibility into whether a teammate's context was compacted. Compacted reasoning is silently lost. Mitigation: (a) the v2 plan should include a prompt instruction requiring agents to persist key reasoning checkpoints to their artifact files (not just conversational memory); (b) for long-running agents, inject a "checkpoint your reasoning to progress.md every N tool calls" instruction. This is a prompt-engineering mitigation, not an architectural one. The upstream fix would be a `ContextCompacted` hook event.

**Experiment 16: Worktree path enforcement / sandboxing (roadmap item 9).** Hypothesis: worktree isolation prevents writes outside the worktree directory. Result: **CONFIRMED GAP — no path enforcement.** An agent spawned with `isolation: "worktree"` successfully wrote to `/tmp/`, to the main repo at `/home/user/canon/`, and to its own worktree. All three writes succeeded. Worktree "isolation" only sets the agent's working directory (CWD) — it does not restrict which filesystem paths tools can access. There is no sandbox. Real path enforcement requires one of: (a) OS-level sandboxing (chroot, namespaces), (b) tool-level path validation (Write/Edit/Bash checking paths against an allowlist), or (c) hook-based interception (pre-tool hooks rejecting out-of-bounds paths). The v2 plan should implement option (c) as a defense-in-depth layer, since hooks are already in the architecture. This is a significant finding for the `agent-tool-scope-minimization` principle.

**Experiment 17: Background janitor agent (roadmap item 17).** Hypothesis: the lead can spawn an async agent for housekeeping while the main flow continues. Result: **PASS.** `run_in_background: true` worked cleanly. The janitor agent scanned workspace files, wrote scan results to disk, and the lead received a completion notification automatically. The lead was free to do other work during the janitor's execution. This validates the background janitor pattern: spawn at flow completion with `run_in_background`, let it prune worktrees and checkpoint databases, and handle its completion notification asynchronously.

#### Critical architecture experiment

**Experiment 18: MCP tool access from spawned agents.** Hypothesis: agents spawned via the Agent tool can access Canon's MCP server tools. Result: **FLAWED EXPERIMENT — tested the wrong primitive.** The experiment used the Agent tool (subagents), which does not inherit Canon's MCP server. However, per Claude Code's [agent teams documentation](https://code.claude.com/docs/en/agent-teams): "Each teammate has its own context window. When spawned, a teammate loads the same project context as a regular session: CLAUDE.md, MCP servers, and skills." **Agent teams teammates DO have MCP access.** This changes the architecture picture:

1. **Teammates can call Canon MCP tools directly.** `record_agent_metrics`, `post_event`, `get_principles`, `report_result`, `get_file_context`, `graph_query` — all available to teammates. Gaps 5 (principle loading), 17 (agent metrics), 18 (activity logging), and 8 (post-state effects) are significantly easier to address than if agents had no MCP access.
2. **The plan-time pipeline is an optimization, not a hard requirement.** Pre-composing principles, enrichment, and KG context into the spawn prompt is still the right design — it's more efficient than each teammate independently querying the same data, and it ensures consistent context across wave peers. But agents are not helpless without it; they can fall back to MCP tool calls for anything the pipeline misses.
3. **Structured response contracts remain valuable** for the lead to parse completion status, even though agents can also call `report_result` directly. The lead needs to know what happened to drive HITL breakpoints and post-state effects.
4. **The Agent tool (subagents) vs. agent teams (teammates) distinction matters.** Experiments 1–17 used the Agent tool. Most findings (prompt delivery, file I/O, structured responses, worktree lifecycle) are portable to agent teams. Tool access findings are not — teammates get more tools than subagents. A Phase 1 validation checkpoint should re-confirm MCP access with actual agent teams teammates.

### 2.6 Experiment summary and architecture confidence

Across 18 experiments (17 via Agent tool, 1 corrected per agent teams docs), the v2 target architecture is validated with three confirmed constraints and three confirmed gaps:

**Constraints (shape the design but don't block it):**
- Session continuation is disk-only — no cross-agent memory (exp 6)
- Worktree settings must be injected by orchestrator before spawn (exp 8)
- Agent tool subagents lack MCP access; agent teams teammates have it (exp 18 corrected) — plan-time pipeline is an efficiency optimization, not a hard requirement

**Gaps (require mitigations in the plan):**
- No agent timeout/abort mechanism (exp 11/14) — mitigate with prompt budgets + polling watchdog
- No worktree path enforcement (exp 16) — mitigate with pre-tool hooks
- No real-time loop detection (exp 10) — mitigate with post-hoc self-report analysis

**Confirmed working patterns:**
- HITL pause/resume between sequential agents (exp 1)
- 21k+ char hydrated prompts delivered intact (exp 2)
- Worktree create/merge/cleanup from lead (exp 3)
- Structured completion signals parseable by lead (exp 4)
- Filesystem-based flow event channel (exp 5)
- Synchronous Agent tool = deterministic artifact enforcement (exp 7)
- Filesystem polling for mid-execution signals (exp 13)
- Background async agents (exp 17)

**Portability note:** Experiments 1–17 used the Agent tool (subagents), not agent teams (teammates). Findings about file I/O, prompt delivery, structured responses, worktree lifecycle, and filesystem signaling are portable. Findings about tool access need re-validation with actual agent teams in Phase 1. The v2 plan includes a Phase 1 validation checkpoint for this.

Architecture confidence: **HIGH for the core path** (plan-time composition → spawn → structured response → effects). The plan-time pipeline remains the right design for efficiency and consistency, even though teammates could theoretically self-serve via MCP tools. Medium confidence for observability (loop detection, effort budgets) — workable mitigations exist but are weaker than the legacy model's full-visibility wrapper.
