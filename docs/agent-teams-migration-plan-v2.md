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

### 2.1 The hybrid model: subagents and agent teams

The v1 plan assumed a single replacement substrate. The v2 plan uses **both** Claude Code primitives, each for what it does best. Anthropic's guidance:

> Use subagents when you need quick, focused workers that report back. Use agent teams when teammates need to share findings, challenge each other, and coordinate on their own.

Most Canon flow steps are sequential pipelines — researcher → architect → implementor → reviewer — where each step produces an artifact consumed by the next. This is textbook subagent work: focused, fast, cheap. Only wave tasks (parallel implementation across files), debate protocols, and collaborative review genuinely need inter-agent coordination.

**Decision framework — which primitive for which step:**

| Step pattern | Primitive | Rationale |
|-------------|-----------|-----------|
| Single agent, focused task, artifact goes to next step | **Subagent** | Fast, cheap, result returns to orchestrator |
| Sequential pipeline (research → plan → implement → review) | **Subagents** (chained) | Each step is independent; only the artifact connects them |
| Parallel implementation across files (wave tasks) | **Agent team** | Teammates need to avoid file conflicts, coordinate merges |
| Debate / competing hypotheses | **Agent team** | Teammates challenge each other's findings |
| Collaborative review (reviewer + author discussion) | **Agent team** | Back-and-forth requires direct messaging |
| Consultation (advisory, non-blocking) | **Subagent** | Quick opinion, result returns to orchestrator |
| Background housekeeping (janitor, learner) | **Subagent** (background) | No coordination needed, just runs and reports back |

**Key capability differences (per [Claude Code docs](https://code.claude.com/docs/en/agent-teams)):**

| Capability | Subagents | Agent teams teammates |
|-----------|-----------|----------------------|
| Context | Own context window; results return to caller | Own context window; loads CLAUDE.md, MCP servers, skills |
| MCP access | **No** — only built-in tools | **Yes** — same project context as a regular session |
| Communication | Report results back to lead only | Native Mailbox — message each other directly |
| Coordination | Lead manages all ordering | Shared task list with dependencies, self-claiming |
| HITL gates | Lead checks result, then decides next step | Native plan approval mode (read-only until lead approves) |
| Hooks | SubagentStart/Stop | TeammateIdle, TaskCreated, TaskCompleted |
| Permissions | Inherit lead's tools via subagent definition `tools` field | Inherit lead's permission mode; subagent definition `tools` honored |
| Lifecycle | Synchronous (lead waits) or background | Independent sessions; lead can message, redirect, shut down |
| Token cost | Lower — results summarized back | Higher — each is a full Claude instance |
| Abort | None (wait or timeout) | Lead asks to shut down (teammate can reject; shutdown is graceful) |

### 2.2 Architecture layers

#### Layer 1: Runbook Loader (data)

Reads a declarative YAML runbook from `skills/canon/runbooks/<name>.yaml`. Runbooks describe *what* to do — roles, artifacts, dependencies, HITL gates, wave policy — but contain no execution logic. Each step declares its **dispatch mode**: `subagent` (default) or `team`. The loader is unchanged from v1 and already exists on the Phase 2 branch (`parseRunbook` in `lead-mode.ts`).

#### Layer 2: Plan-Time Pipeline (composition)

Takes a parsed runbook + workspace state and produces **fully-hydrated spawn descriptors**. This layer is critical for subagent steps (subagents lack MCP access and cannot self-serve context) and an efficiency optimization for team steps (pre-composing avoids each teammate independently querying the same data).

Pipeline stages:

1. **Workspace bootstrap** — create workspace directory, seed `progress.md`, build cache prefix, run preflight checks. Replaces `init_workspace`.
2. **Worktree creation** — for wave/team steps, create per-task Git worktrees. Replaces `createWaveWorktrees`.
3. **Principle resolution** — match principles to step scope via `shared/matcher.ts`. Inject into spawn prompt. *Required for subagents; optimization for teammates (who can call `get_principles` themselves).*
4. **Context enrichment** — assemble the four-section enrichment block (Recent Changes, Drift Signals, Prior Work, Tensions). Replaces `assembleEnrichment`.
5. **Tool profile resolution** — resolve each role's tools, permissions, and write scope. For subagents: injected into the spawn prompt and the subagent definition `tools` field. For teammates: carried via subagent definition `tools` allowlist (honored per docs).
6. **Permissions setup** — for subagent worktree steps: write `.claude/settings.local.json` (subagents need this). For team steps: permissions inherit from lead (per docs: "Teammates start with the lead's permission settings").
7. **Commit provenance** — inject `Canon-Workflow / Canon-Agent / Canon-State / Canon-Task` trailers. Same for both primitives.
8. **Session continuation** — inject `continue_from` context summary for resumed steps. Subagents: in spawn prompt. Teammates: in spawn prompt (no cross-session memory per docs).
9. **Wave briefing** — for wave 2+ steps, inject prior-wave summaries. Relevant for team dispatch.
10. **Consultation pre-briefing** — resolve `before` / `between` consultation outputs. Consultations themselves are subagent-dispatched.
11. **File claims registration** — register affected files in `.canon/claims.json`.
12. **HITL classification** — classify breakpoint config. For subagents: lead checks result post-completion. For teammates: use native plan approval mode where applicable.
13. **Prompt validation** — scan for unresolved `${...}` references.

#### Layer 3: Run-Time Coordinator (execution)

Dispatches steps using the appropriate primitive and manages the flow lifecycle.

**For subagent steps** (the common path):
- Spawn subagent with hydrated descriptor.
- Wait for result (synchronous) or poll (background).
- Parse structured response for completion status, metrics, flow events.
- Verify artifact on disk.
- Run post-step effects (persist_review, check_postconditions).
- Present HITL breakpoint if classified.
- Spawn next step.

**For team steps** (wave tasks, debate):
- Create agent team via lead session.
- Spawn teammates from hydrated descriptors. Teammates load Canon MCP servers from project context — they can call `record_agent_metrics`, `post_event`, `report_result` directly.
- Create shared task list with dependencies derived from the runbook.
- Teammates self-claim tasks and coordinate via native Mailbox.
- Use `TaskCompleted` hooks for artifact enforcement (exit 2 if artifact missing).
- Use `TeammateIdle` hooks as backstop.
- For architect approval gates: use native plan approval mode ("require plan approval before they make any changes").
- After all tasks complete: merge worktrees per wave policy, run inter-wave gates.
- Lead synthesizes results and decides next action.
- Clean up team before proceeding.

**For either path:**
- Drain flow events (from subagent structured responses or teammate messages).
- Handle mid-flow adaptation (insert/skip/escalate).
- Detect stuck states via prompt-based budgets and post-completion metrics.

#### Layer 4: Completion Phase (teardown)

Runs after the final step completes or the flow is aborted. Same regardless of dispatch mode:

- **Learn gate evaluation** — `evaluateLearnGate(projectDir)` (ADR-016).
- **Flow analytics** — aggregate metrics into `FlowRunEntry` via DriftStore.
- **Claims release** — `releaseClaims(projectDir, workflow)`.
- **Agent metrics persistence** — from subagent structured responses or teammate `record_agent_metrics` calls.
- **Drift persistence** — flush pending review entries to DriftStore.
- **Worktree cleanup** — remove `.canon/worktrees/<task_id>/` after merges.
- **Team teardown** — clean up Claude Code team state (if a team was created).

### 2.3 Why this hybrid outperforms either primitive alone

1. **Cost efficiency.** Most flow steps (research, architecture, single-file implementation, review) are fast subagent dispatches. Token cost scales linearly with teammates — only pay that cost for steps that genuinely need coordination.
2. **Composition guarantee.** Subagents lack MCP access, so the plan-time pipeline must inject everything. This forces discipline: every integration is explicitly composed, not accidentally available. For team steps, the same pipeline provides consistent context across peers.
3. **Native HITL.** Agent teams' plan approval mode maps directly to Canon's architect approval gate. No custom HITL vocabulary needed for that case. Subagent steps use the simpler post-completion check.
4. **Native coordination for waves.** Shared task list with dependencies, file-locking for claim prevention, and direct teammate messaging replace Canon's custom wave orchestration for the cases that need it.
5. **Canon's agent definitions work for both.** The 13 agent defs in `agents/*.md` are valid as both subagent types and teammate types. The `tools` allowlist in definitions is honored in both paths.

### Design principle: no silent losses

Every integration in the legacy pipeline maps to a named stage in the plan-time pipeline, a named responsibility in the run-time coordinator, or a named step in the completion phase. The integration disposition table (§9) traces each of the 28 audit gaps to its v2 home. If an integration cannot be traced, the plan is incomplete.

### 2.4 Experimental validation (2026-04-12)

Eighteen experiments tested architecture assumptions. Experiments 1–17 used the **Agent tool (subagents)** — findings about file I/O, prompt delivery, structured responses, and worktree lifecycle are portable to agent teams. Findings about tool access and communication channels differ between the two primitives. Experiment 18 was corrected against the [agent teams documentation](https://code.claude.com/docs/en/agent-teams).

#### Subagent-path experiments (validated via Agent tool)

**Experiment 1: HITL pause/resume.** Sequential spawn-pause-spawn works natively. The Agent tool is synchronous: lead spawns step 1, receives result, presents gate, spawns step 2. **PASS.**

**Experiment 2: Spawn prompt size.** 20,959-byte hydrated prompt delivered intact. No truncation. **PASS.**

**Experiment 3: Worktree lifecycle.** Create/list/remove from lead session works. Merge validated by production `wave-lifecycle.ts`. **PASS.**

**Experiment 4: Completion signal.** Agent returned parseable structured `STRUCTURED_RESULT` block. Artifacts verified on disk post-completion. **PASS.**

**Experiment 5: Flow events via structured response.** Agent emitted `FLOW_EVENT:TYPE:TARGET:reason=...` lines. Lead parsed all three. Also wrote JSON events file as backup channel. **PASS.** *Note: agent teams teammates have the native Mailbox for this — a richer channel than structured response parsing.*

**Experiment 6: Session continuation.** No cross-session memory. Disk-persisted state recoverable; conversational context lost. Context summaries must be explicit in the spawn prompt. **CONFIRMED CONSTRAINT.** *Applies to both subagents and teammates (per docs: "The lead's conversation history does not carry over").*

**Experiment 7: Artifact enforcement timing.** Synchronous Agent tool = deterministic sequencing. Lead checks artifact after agent completes, before spawning next step. **PASS BY DESIGN.** *For agent teams: `TaskCompleted` hooks provide native enforcement.*

**Experiment 8: Worktree settings injection.** Subagents need settings.local.json written before spawn (they can't write their own). **CONFIRMED CONSTRAINT for subagents.** *For agent teams: teammates inherit lead's permission settings per docs — different mechanism.*

**Experiment 9: Concurrent file claims.** Sequential operations work. Concurrent read-modify-write has lost-update risk. **PASS with caveat** — add optimistic concurrency.

#### Roadmap compatibility experiments

**Experiment 10: Tool-level loop detection.** Post-hoc only for subagents (no mid-execution visibility). Self-report + metadata `tool_uses` match. *For teams: lead can message teammates to check progress.* **POST-HOC for subagents; PARTIAL for teams.**

**Experiment 11/14: Timeout and effort budgets.** No timeout/abort for subagents. *For teams: lead can ask teammate to shut down (graceful, teammate can reject). "Shutdown can be slow: teammates finish their current request."* **GAP for subagents; PARTIAL for teams.**

**Experiment 12: Self-reported metrics.** Agent self-reported `tool_calls: 8` matched metadata `tool_uses: 8`. **PASS.** *For teams: teammates can call `record_agent_metrics` directly via MCP.*

**Experiment 13: Mid-execution signaling.** Filesystem polling works (8-second gaps between signals). *For teams: native Mailbox with automatic delivery replaces polling.* **PASS for subagents; NATIVE for teams.**

**Experiment 15: Compaction.** No compaction visibility for either primitive. Mitigate with prompt-based reasoning checkpoints. **CONFIRMED GAP.**

**Experiment 16: Path enforcement.** No sandbox — worktree isolation only sets CWD. Writes to arbitrary paths succeed. **CONFIRMED GAP.** *Same for both primitives. Mitigate with pre-tool hooks.*

**Experiment 17: Background agent.** `run_in_background` works for async subagents. *For teams: all teammates are inherently independent sessions.* **PASS.**

#### Documentation-corrected finding

**Experiment 18: MCP tool access.** Subagents do NOT inherit Canon MCP server. Agent teams teammates DO — per docs: "a teammate loads the same project context as a regular session: CLAUDE.md, MCP servers, and skills." The `skills` and `mcpServers` fields in subagent definitions are NOT applied to teammates — teammates get MCP from project/user settings. **This validates the hybrid model**: subagent steps need the plan-time pipeline (no MCP fallback); team steps benefit from it but can self-serve.

### 2.5 Experiment summary

**Confirmed constraints:**
- No cross-session memory for either primitive (exp 6)
- Subagents need settings.local.json pre-injected; teammates inherit lead's permissions (exp 8, docs)
- Subagents lack MCP access; teammates have it (exp 18, docs)

**Confirmed gaps (mitigations needed):**
- No hard timeout/abort for subagents; graceful shutdown for teammates (exp 11/14, docs)
- No path enforcement in worktree isolation (exp 16)
- No compaction visibility (exp 15)
- Post-hoc only loop detection for subagents (exp 10)

**Architecture confidence:** HIGH. The hybrid model assigns each primitive to its strength: subagents for the fast sequential pipeline (most steps), agent teams for parallel coordination (waves, debate). The plan-time pipeline is required for subagent steps and an efficiency optimization for team steps. Phase 1 should include a validation checkpoint with actual agent teams to confirm teammate MCP access and Mailbox behavior in Canon's environment.
