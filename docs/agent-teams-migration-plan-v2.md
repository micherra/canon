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

## 2. Target Architecture

### 2.1 The core insight

The v1 plan asked "how do we replace drive_flow with runbooks?" The v2 draft asked "how do we replace drive_flow with a hybrid of subagents and agent teams?" Both questions assumed the state machine needed a replacement. The right question is: **does Canon's state machine provide anything Claude can't do natively?**

The answer, after 18 experiments and a documentation review, is no. Everything `drive_flow` coordinates — sequencing, conditionals, HITL gates, parallel dispatch, convergence, skip conditions, effects — is native Claude capability. The state machine was built before Claude Code had multi-agent coordination. Now that it does, the custom scheduler is overhead.

What the state machine does NOT provide is Canon's actual value: principle-grounded context, drift tracking, knowledge graph queries, artifact contracts, commit provenance, file claims, enrichment. Those are MCP tools. They stay.

### 2.2 The architecture: Canon as Claude's toolkit

```
User request
  → Claude (lead) reads CLAUDE.md + agent defs + runbook
  → Claude calls Canon MCP tools to compose context
  → Claude spawns subagents or creates agent team
  → Agents work (teammates have MCP access; subagents don't)
  → Claude handles HITL, effects, completion natively
  → Claude calls Canon MCP tools for analytics and cleanup
```

**What stays (Canon's value):**

| Layer | What | Why |
|-------|------|-----|
| **MCP tools** | `get_principles`, `list_principles`, `get_compliance`, `get_drift_report`, `get_file_context`, `graph_query`, `semantic_search`, `codebase_graph`, `record_agent_metrics`, `post_event`, `show_pr_impact`, `review_code`, `store_pr_review`, `store_summaries` | These ARE Canon. Principles, drift, KG, artifacts, metrics — Claude uses them as a native toolkit. |
| **Agent definitions** | 13 types in `agents/*.md` | Valid as both subagent types and agent team teammate types. The `tools` allowlist is honored in both paths. |
| **Hooks** | `TaskCompleted`, `TeammateIdle`, `SubagentStart/Stop` scripts | Defense-in-depth artifact enforcement and observability. |
| **Workspace storage** | `.canon/workspaces/<id>/` | Artifact storage, progress tracking, workspace metadata. |
| **Shared libraries** | `commit-trailers.ts`, `file-claims.ts`, `matcher.ts` | Principle matching, commit provenance, file ownership — used by MCP tools and available to the lead. |
| **Runbooks** | `skills/canon/runbooks/*.yaml` | Lightweight playbooks describing recommended step sequences. Not executable — Claude reads them as guidance. |

**What goes (the custom coordination layer):**

| Component | File(s) | Why it's deletable |
|-----------|---------|-------------------|
| State machine runtime | `drive-flow.ts`, `drive-flow-helpers.ts`, `drive-flow-wave.ts`, `drive-flow-wave-lifecycle.ts` | Claude sequences steps natively. |
| 9-stage prompt pipeline | `features/prompt-pipeline/` (all stages) | Claude calls MCP tools directly to compose context before spawning. Each MCP tool is a standalone capability, not a pipeline stage. |
| Flow YAML runtime | Parser, validator, fragment inclusion, transition matcher | Claude reads runbooks for guidance; no executable state machine needed. |
| Wave event plumbing | `inject_wave_event`, `resolve_wave_event`, flow event channel | Agent teams' native Mailbox + task list replace custom wave coordination. |
| Custom HITL vocabulary | Five breakpoint shapes, convergence exhausted, gate failure | Claude handles HITL natively. Agent teams' plan approval mode covers architect gates. |
| Message channel | `post_message`, `get_messages` | Agent teams' Mailbox replaces this. |
| Session continuation | `applySessionContinuation` | Claude includes context summaries in spawn prompts naturally. |
| Consultation executor | `consultation-executor.ts` | Claude can spawn an advisory subagent and inject its output — no special mechanism needed. |

### 2.3 How Claude orchestrates a Canon flow

A concrete example of `fast-path` (bug fix):

1. **User says** "fix the broken search" to the Canon lead session.
2. **Claude reads** `CLAUDE.md`, sees Canon orchestration instructions. Reads the `fast-path` runbook for the recommended step sequence.
3. **Claude calls** `get_principles` with the target file scope → gets matched principles. Calls `get_file_context` → gets KG summaries. Calls `get_drift_report` → gets recent drift. Assembles this into a research prompt.
4. **Claude spawns** a `canon-researcher` subagent with the enriched prompt. Waits for result. Gets a research synthesis artifact.
5. **Claude spawns** a `canon-architect` subagent with the research synthesis as upstream context. Waits for result. Gets a plan index.
6. **Claude presents** the plan to the user for approval (native HITL). User approves.
7. **Claude spawns** a `canon-implementor` subagent with the plan and principles. Waits for result. Gets an implementation summary.
8. **Claude spawns** a `canon-reviewer` subagent. Waits for result. Gets a review verdict.
9. **If verdict is not clean**, Claude loops back to step 7 with the review feedback. (Native judgment, not a state transition.)
10. **Claude calls** `record_agent_metrics`, `store_summaries`, evaluates learn gate, releases file claims. Done.

For an `epic` flow with wave tasks, step 7 becomes: Claude creates an agent team, spawns N `canon-implementor` teammates (one per task), they self-coordinate via shared task list and Mailbox, Claude merges worktrees after the wave completes.

### 2.4 Dispatch framework

| Step pattern | Primitive | Rationale |
|-------------|-----------|-----------|
| Single agent, focused task, artifact goes to next step | **Subagent** | Fast, cheap, result returns to lead |
| Sequential pipeline (research → plan → implement → review) | **Subagents** (chained) | Each step is independent; only the artifact connects them |
| Parallel implementation across files (wave tasks) | **Agent team** | Teammates coordinate via Mailbox, shared task list, file locking |
| Debate / competing hypotheses | **Agent team** | Teammates challenge each other's findings directly |
| Consultation (advisory, non-blocking) | **Subagent** | Quick opinion, result returns to lead |
| Background housekeeping (janitor, learner) | **Subagent** (background) | No coordination needed |

### 2.5 Why this is simpler

1. **One orchestrator: Claude.** No custom state machine, no custom scheduler, no transition resolver. Claude reads guidance and uses judgment — the thing it's best at.
2. **MCP tools as primitives.** Each Canon capability is a standalone MCP tool call, not a pipeline stage wired into a runtime. The lead composes them as needed, not in a fixed 13-stage sequence.
3. **Native coordination.** Subagents for sequential work, agent teams for parallel work. No custom wave plumbing, no custom message channel, no custom HITL vocabulary.
4. **Canon's value is untouched.** Principles, drift, KG, artifacts, metrics, commit provenance, file claims — all preserved as MCP tools. What's deleted is only the scheduling machinery.
5. **Agent definitions work as-is.** All 13 agent defs are valid subagent and teammate types. The `tools` allowlist is honored in both paths per [Claude Code docs](https://code.claude.com/docs/en/agent-teams).

### 2.6 The consistency question

The risk: Claude might not consistently follow the same process. Two runs of the same task might produce different execution paths.

Mitigations:
- **CLAUDE.md** describes the expected flow patterns and orchestration discipline. Claude reads this on every session.
- **Runbooks** as suggested playbooks — Claude follows them but can adapt when the situation warrants.
- **Hooks** as guardrails — `TaskCompleted` enforces artifacts exist, `TeammateIdle` catches premature stops. These are hard enforcement, not Claude judgment.
- **MCP tool contracts** — `record_agent_metrics`, `store_summaries`, `get_compliance` provide structured feedback loops. Canon's observability surface tells you what actually happened regardless of the execution path.
- **Agent definitions** constrain each agent's tool access and behavioral instructions. A `canon-researcher` gets Read/Glob/Grep, not Write/Edit. This is enforced by Claude Code, not by Claude's judgment.

The state machine provided *determinism*. But Canon's flows aren't deterministic today (convergence loops, skip conditions, adaptive waves). And Claude's judgment about "what comes next" is arguably better than a rigid state graph — it can adapt to what it finds without needing a pre-authored transition for every contingency.

### 2.7 Experimental validation (2026-04-12)

Eighteen experiments informed the architecture. Experiments 1–17 used the Agent tool (subagents); experiment 18 was corrected against the [agent teams documentation](https://code.claude.com/docs/en/agent-teams).

**Key findings that shaped this architecture:**

| # | What we tested | Result | Architecture impact |
|---|---------------|--------|-------------------|
| 1 | HITL pause/resume between spawns | PASS | Claude can gate between steps natively |
| 2 | 21k char enriched spawn prompt | PASS | MCP-composed context fits in spawn prompts |
| 3 | Worktree lifecycle from lead | PASS | Lead can manage wave worktrees |
| 4 | Structured completion parsing | PASS | Lead can parse agent results and run effects |
| 5 | Flow event channel (structured response) | PASS | Subagent path works; teams use native Mailbox |
| 6 | Session continuation | CONSTRAINT | No cross-session memory — context via prompt injection |
| 7 | Artifact enforcement timing | PASS | Synchronous subagents = deterministic enforcement |
| 8 | Worktree settings injection | CONSTRAINT | Subagents need pre-injected settings; teammates inherit lead permissions |
| 9 | Concurrent file claims | PASS (caveat) | Add optimistic concurrency to claims.json |
| 10 | Tool-level loop detection | POST-HOC | Subagents: check metrics after completion. Teams: lead messages to check |
| 11/14 | Timeout / abort / effort budgets | GAP | No hard timeout. Teams: graceful shutdown. Mitigate with prompt budgets |
| 12 | Self-reported metrics | PASS | Subagent self-report matches metadata. Teams: call `record_agent_metrics` via MCP |
| 13 | Mid-execution signaling | PASS | Subagents: filesystem polling. Teams: native Mailbox |
| 15 | Compaction visibility | GAP | No signal. Mitigate with reasoning checkpoint instructions |
| 16 | Path enforcement | GAP | No sandbox. Mitigate with pre-tool hooks |
| 17 | Background async agent | PASS | Janitor/learner pattern viable |
| 18 | MCP tool access | CORRECTED | Subagents: no MCP. Teammates: full MCP (per docs) |

**Critical documentation findings (not experimentally tested):**

| Feature | Per Claude Code docs | Impact |
|---------|---------------------|--------|
| Teammates load CLAUDE.md, MCP servers, skills | "same project context as a regular session" | Teammates have full Canon MCP access |
| Native Mailbox | Automatic message delivery between teammates | Replaces custom `post_message` / `get_messages` and flow event channel |
| Plan approval mode | "Teammate works in read-only plan mode until the lead approves" | Maps directly to Canon's architect approval gate |
| Shared task list with dependencies | Tasks auto-unblock; file-locking prevents race conditions | Replaces custom wave task coordination |
| Subagent `tools` allowlist honored for teammates | "The teammate honors that definition's tools allowlist" | Canon agent definitions enforce tool scope in both paths |
| Graceful teammate shutdown | "Lead sends shutdown request. Teammate can reject." | Partial abort mechanism for long-running teammates |
| One team per session | Limitation | Lead cleans up team between flow phases |
| No nested teams | Limitation | Teammates cannot spawn their own teams |
| Permissions set at spawn | "Teammates start with the lead's permission settings" | Different mechanism than subagent settings.local.json |

**Architecture confidence:** HIGH. The "Canon as Claude's toolkit" model is validated. Canon's MCP tools provide every capability the state machine composed; Claude's native orchestration replaces the scheduling machinery. Phase 1 should include a validation checkpoint with actual agent teams to confirm teammate MCP access and Mailbox behavior in Canon's environment.

---

## 3. Integration Disposition Table

Every one of the 28 gaps from the integration audit must map to a concrete replacement or an explicit deprecation. The "v2 home" column shows where each integration lives in the new architecture. Dispositions: **native** (Claude or Claude Code handles it), **mcp** (Canon MCP tool stays as-is), **hook** (enforcement via Claude Code hooks), **guidance** (CLAUDE.md / runbook instructions), **deprecate** (intentionally dropped with rationale).

### HIGH severity

| # | Integration | Legacy path | Disposition | v2 Home | Rationale |
|---|------------|-------------|-------------|---------|-----------|
| 1 | Auto-approve settings injection | `worktree-settings.ts` → `injectSettingsIntoRequests` | **guidance + native** | For subagents: lead writes `settings.local.json` into worktree before spawn (Bash tool). For teammates: permissions inherit from lead per docs. CLAUDE.md instructs the lead to set up worktree permissions before dispatching. | Lead handles this as a pre-spawn step; no pipeline stage needed. |
| 2 | Tool profile resolution | `tool-profiles.ts` → `resolveToolProfile` | **native** | Agent definitions in `agents/*.md` carry `tools` allowlists. Per docs, both subagents and teammates honor the definition's `tools` field. KG-informed trust computation is a future enhancement, not a launch requirement. | Tool scoping moves from runtime resolution to declarative agent definitions. |
| 3 | Workspace worktree creation | `wave-lifecycle.ts` → `createWaveWorktrees` | **native** | Lead creates worktrees via Bash (`git worktree add`) before spawning wave teammates. Lead merges via `git merge` after wave completes. Validated in experiment 3. | Git operations are native Bash commands. No MCP tool needed. |
| 4 | Context enrichment | `context-enrichment.ts` → `assembleEnrichment` | **mcp** | Lead calls `get_file_context`, `get_drift_report`, `graph_query` to assemble context. Injects results into spawn prompt. Teammates can also call these MCP tools directly. | Enrichment is already decomposed into standalone MCP tools. The 9-stage pipeline was just a fixed composition order. |
| 5 | Principle loading | `matcher.ts` → prompt pipeline stage 1 | **mcp** | Lead calls `get_principles(file_path, task_description)` → gets matched principles. Injects into spawn prompt. Teammates can also call `get_principles` directly via MCP. | Already a standalone MCP tool. Verified working in this environment (returned matched principles with file scope). |
| 6 | Commit provenance trailers | `commit-trailers.ts` → `buildProvenanceSection` | **guidance** | CLAUDE.md and agent definitions instruct agents to include Canon trailers in commits. The trailer format (`Canon-Workflow`, `Canon-Agent`, etc.) is documented in the orchestration guidance. | Trailers are a commit message convention. Agents follow instructions; no runtime injection needed. |
| 7 | File claims | `file-claims.ts` → `registerClaims` / `releaseClaims` / `checkClaimOverlaps` | **mcp** | `update_board` MCP tool already calls `registerClaims` and `releaseClaims`. Lead calls `update_board` at flow start and completion. For agent teams: native task list with file-locking prevents concurrent claims on the same task. | Claims registration is already an MCP tool side effect. Agent teams add native file-level coordination. |
| 8 | Post-state effects | `effects.ts` → `executeEffects` | **mcp + native** | Lead calls `store_pr_review` / `write_review` after reviewer completes (persist_review effect). Lead runs contract-checker assertions via Bash (check_postconditions effect). No effect executor needed — the lead IS the effect executor. | Effects are MCP tool calls and shell commands. Claude as lead runs them between steps. |
| 9 | Wave policy | `WavePolicy { isolation, merge_strategy, on_conflict, gate, coordination }` | **native + guidance** | Runbook wave steps declare merge strategy and conflict handling. Lead creates worktrees (isolation), runs `git merge`/`git rebase` (merge_strategy), presents conflicts to user (on_conflict: hitl), runs shell gates between waves (gate). Agent teams' shared task list handles coordination. | Wave policy becomes lead orchestration logic guided by runbook annotations, not a runtime schema. |
| 10 | HITL breakpoint presentation | Five breakpoint shapes in `drive-flow-helpers.ts` | **native** | Claude handles HITL natively: (a) presents results and asks the user, (b) uses agent teams' plan approval mode for architect gates, (c) presents merge conflicts for resolution, (d) reports gate failures and asks how to proceed. No custom breakpoint vocabulary needed. | Claude's conversational HITL is richer than five fixed shapes — it adapts to context. |
| 11 | Workspace bootstrap | `init_workspace` → directory creation, progress.md, cache prefix, preflight checks | **mcp** | `init_workspace` MCP tool stays. Lead calls it at flow start. The tool creates the workspace directory, seeds progress.md, checks for claim overlaps. | Already a standalone MCP tool. No change needed. |

### MEDIUM severity

| # | Integration | Legacy path | Disposition | v2 Home |
|---|------------|-------------|-------------|---------|
| 12 | Session continuation (ADR-009a) | `applySessionContinuation` | **native** | Claude naturally includes relevant context from prior steps in spawn prompts. No special mechanism — the lead's conversation contains the context. |
| 13 | Inter-wave gates | `WavePolicy.gate` | **native** | Lead runs shell gates between waves via Bash. Runbook annotates which gate to run. |
| 14 | Wave briefing assembly | `wave-briefing.ts` | **native** | Lead summarizes prior wave results and includes in next wave's spawn prompts. Agent teams teammates can also read prior artifacts directly. |
| 15 | Consultation prompts | `consultation-executor.ts` | **native** | Lead spawns an advisory subagent, gets the opinion, injects into the next step's prompt. No special executor — it's just another subagent spawn. |
| 16 | Discovered gates / postconditions | `report_result` → `BoardStateEntry` accumulation | **mcp** | Agents call `report_result` MCP tool (available to teammates). Lead can also record via `update_board`. |
| 17 | Agent metrics recording | `record_agent_metrics` | **mcp** | Teammates call `record_agent_metrics` directly via MCP. For subagents: lead parses self-reported metrics from structured response and calls the MCP tool on their behalf. Validated in experiment 12. |
| 18 | Agent activity logging | `post_event` | **mcp + hook** | Teammates call `post_event` directly via MCP. Hooks (`SubagentStart/Stop`) log lifecycle events via `observability.sh`. |
| 19 | Drift tracking / review persistence | `persist_review` effect → DriftStore | **mcp** | Lead calls `store_pr_review` or `write_review` MCP tool after reviewer completes. Already a standalone tool. |
| 20 | Learn gate evaluation (ADR-016) | `evaluateLearnGate` in `buildDoneSummary` | **guidance** | CLAUDE.md instructs the lead to check learn gate at flow completion. Lead runs `.canon/learn.sh` via Bash if it exists. |
| 21 | Flow run analytics | `update_board complete_flow` → `DriftStore.appendFlowRun` | **mcp** | Lead calls `update_board({ operation: "complete_flow" })` at flow end. Tool aggregates metrics internally. |
| 22 | Flow event channel drain | `drainFlowEvents` → insert/skip/escalate | **native** | For subagents: lead parses flow events from structured response (validated in experiment 5). For teammates: teammates message the lead via native Mailbox. Lead processes and adapts. |

### LOW severity

| # | Integration | Legacy path | Disposition | v2 Home |
|---|------------|-------------|-------------|---------|
| 23 | Variable interpolation | `${WORKSPACE}`, `${slug}`, etc. | **deprecate** | Runbooks use structured fields, not template variables. Claude constructs prompts directly — no variable substitution needed. |
| 24 | Template loading | `injectTemplates` stage 5 | **guidance** | Agent definitions and CLAUDE.md reference templates. Agents read templates from `templates/` directory as needed. |
| 25 | Competitive / debate protocols | `compete.count`, `synthesis` | **native** | Lead spawns an agent team with N teammates and competing instructions. Agent teams' native messaging enables debate. Per docs: "teammates test different theories in parallel and converge." |
| 26 | Parallel roles | `type: parallel` with `roles: [...]` | **native** | Lead spawns multiple subagents or teammates. No special state type needed. |
| 27 | Skip conditions | `skip_when: no_contract_changes` | **native** | Claude evaluates skip conditions via judgment. Reads artifacts, checks file scope, decides whether to skip. Richer than pattern-matched conditions. |
| 28 | Stuck detection / iteration caps | `max_iterations`, `stuck_when`, `max_revisions` | **guidance + hook** | CLAUDE.md instructs budget limits. `TeammateIdle` hook catches premature stops. Prompt-based budgets ("complete within N tool calls"). Post-hoc metrics check via `record_agent_metrics`. Confirmed gap: no hard timeout (experiment 11/14). |

### Summary

| Disposition | Count | Examples |
|-------------|-------|---------|
| **native** (Claude / Claude Code) | 12 | HITL, session continuation, wave briefing, skip conditions, parallel roles, debate |
| **mcp** (Canon MCP tool stays) | 10 | Principles, enrichment, file claims, metrics, drift, analytics, workspace bootstrap |
| **guidance** (CLAUDE.md / runbook) | 4 | Commit provenance, learn gate, templates, budget limits |
| **hook** (Claude Code hooks) | 1 | Activity logging (with MCP backup) |
| **deprecate** | 1 | Variable interpolation |

**Zero gaps require new code.** Every HIGH-severity integration maps to an existing MCP tool, a native Claude capability, or a combination. The migration is: write CLAUDE.md orchestration guidance, write runbooks as playbooks, delete the state machine.
