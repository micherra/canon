# Canon → Agent Teams Migration Plan

**Status:** REVISED — v2.1-aligned implementation plan
**Owner:** Canon maintainers
**Last updated:** 2026-04-19
**Supersedes:** `docs/agent-teams-migration-plan.md` (v1, 2026-04-10)
**Aligned with:** `docs/agent-teams-migration-plan-v2.1.md` (architectural source)
**Architect review:** `docs/agent-teams-migration-plan-v2.1-review.md` (concerns + rewrite guidance)
**Source material:** `docs/v2-plan-kickoff-prompt.md` on `canon/agent-teams-phase-2`; 28-gap integration audit (2026-04-11)

> **Relationship to v2.1.** v2.1 is the architectural source of truth — it defines the target architecture, synthesis model, learning loop, lifecycle persistence, and ratification gates. **This document is the executable implementation plan that lands v2.1.** A reader running the migration works from this document; a reader understanding *why* the migration has its shape reads v2.1. Both ship; neither is deleted.
>
> **Do not start v2.1a or v2.1b work without first clearing the architect review** (`docs/agent-teams-migration-plan-v2.1-review.md`). The review identifies two HIGH-severity concerns that should have a documented resolution path before implementation begins.

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

### What v2.1 adds on top of v2

v2 (2026-04-12 draft) specified the architecture — Canon-as-Claude's-toolkit, 27-integration disposition table, three-phase rollout with feature-flag gating. v2.1 (2026-04-19, the architectural source this plan aligns to) preserves every v2 decision and adds two cross-cutting capabilities:

1. **Synthesis replaces static runbooks.** v2 specified 5 hand-authored runbook files (fast-path, feature, epic, migrate, test-gap). v2.1 replaces those files with a canonical 15-ID step vocabulary, a `runbook-synthesis.md` skill that defines the composition contract, and a `planner-brief.md` skill that produces the strategic brief. `canon-planner` iterates with the user until approval; only the approved runbook executes. Static runbooks couldn't learn; synthesized runbooks close the plan-quality arm of the learning loop.

2. **Unified learning loop across Canon's artifact stack.** v2 preserved principles, drift, and commit provenance as MCP tools but didn't articulate how Canon improves from every interaction. v2.1 makes this explicit: observation → pattern → proposal → refinement is one mechanism applied across five in-scope refinement targets (principles, conventions, synthesis skill, planning brief skill, templates). Four additional targets are deferred to v2.2+ and one (KG priors) is cut entirely. The learner's role expands from principle-only to the full five-target matrix.

v2.1 also adds one new enforcement layer (L4: `canon-workspace-check.sh` PreToolUse hook) that backstops the per-message intent re-classification discipline (L1, added to CLAUDE.md). Everything else — integration dispositions, agent roster, MCP tools, workspace storage, permission model, phased rollout with feature-flag gating — is preserved from v2.

### What this plan reorganizes

Because v2.1 adds substantial architecture (synthesis, learning loop, lifecycle persistence), the execution phasing expands from v2's three phases into a five-step rollout:

```
v2 Phase 1 (Gate A)
  → v2.1a (synthesis + L1 + L4)
    → v2.1b (minimum viable lifecycle persistence, Gate B)
      → v2.2 (surface expansion, contingent)
        → Phase 2 (validation)
          → Phase 3 (deletion, unchanged from v2)
```

v2 Phase 1 remains a hard precondition: `canon-planner` and `canon-engineer` agent definitions must exist and be validated in ≥ 3 runs under `CANON_AGENT_TEAMS_MODE=on` before any v2.1 work begins. See §10 for the full phase boundaries.

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
  → Agents work (both subagents and teammates have Canon MCP access)
  → Claude handles HITL, effects, completion natively
  → Claude calls Canon MCP tools for analytics and cleanup
```

**What stays (Canon's value):**

| Layer | What | Why |
|-------|------|-----|
| **MCP tools** | `get_principles`, `list_principles`, `get_compliance`, `get_drift_report`, `get_file_context`, `graph_query`, `semantic_search`, `codebase_graph`, `record_agent_metrics`, `post_event`, `show_pr_impact`, `review_code`, `store_pr_review`, `store_summaries` | These ARE Canon. Principles, drift, KG, artifacts, metrics — Claude uses them as a native toolkit. |
| **Agent definitions** | 11 types in `agents/*.md` (Phase 1: delete implementor + fixer + guide + chat, add engineer + planner) | Valid as both subagent types and agent team teammate types. Per docs: subagents "inherit all tools from the main conversation, including MCP tools" by default. Definitions support `skills` (preload rules + domain primers), `maxTurns` (effort budget), `permissionMode`, `memory` (cross-session learning). Six agents get `memory: project`: planner (feature history), engineer (fix patterns), researcher (codebase topology), architect (design history), scribe (doc landscape), learner (pattern mining). Reviewer excluded per `agent-cold-review` rule. Guide and chat removed — lead handles these natively via MCP tools and conversation. Each agent includes `agent-context-check` skill for self-serve context verification. |
| **Orchestration journal** | `log_step`, `verify_completion` MCP tools (~50–80 lines) | The lead's checklist. Records steps executed, artifacts expected. Completion hook verifies. Not a state machine — no scheduling, no forced ordering. |
| **Domain skills** | 12 skill files in `skills/canon/references/` (6 existing primers + 6 new) | Domain expertise loaded on-demand by the lead based on task scope — NOT preloaded into agent frontmatter. Lead reads relevant skills and includes in spawn prompt. Agents can also self-serve. |
| **Hooks** | `TaskCompleted`, `TeammateIdle`, `PostCommit`, `SessionStart`, `SubagentStop`, completion verification | Artifact enforcement, trailer enforcement, doc staleness detection, scribe queuing, completion verification. |
| **Workspace storage** | `.canon/workspaces/<id>/` | Artifact storage, progress tracking, workspace metadata. |
| **Shared libraries** | `commit-trailers.ts`, `file-claims.ts`, `matcher.ts` | Principle matching, commit provenance, file ownership — used by MCP tools and available to the lead. |
| **Runbooks** | `skills/canon/runbooks/*.md` | Lightweight playbooks describing recommended step sequences. Not executable — Claude reads them as guidance. |

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

### 2.3 Pre-build gate (canon-planner)

Claude defaults to action — "add dark mode" → starts building. Canon needs to be smarter. Before committing to any build flow, the lead evaluates whether the request is ready to build:

- Is the problem clearly defined?
- Are acceptance criteria explicit?
- Have alternatives been considered?
- Is the value proportional to the effort?

If any answer is no, the lead spawns `canon-planner` before proceeding to a build runbook. If the request is a clear bug fix or small change with obvious scope, the lead skips straight to fast-path.

**canon-planner** is a new agent that:
1. **Clarifies requirements** — "What problem are you solving? Who benefits?"
2. **Challenges assumptions** — "You're assuming users need X. What if Y is the actual need?"
3. **Evaluates alternatives** — "You could build this, or configure the existing system to do 80% of it."
4. **Assesses value** — "This would take ~4 agents across 2 waves. Is the value proportional?"
5. **Produces a brief** — problem statement, target users, acceptance criteria, alternatives considered, recommended approach, open questions

The brief either greenlights the build (lead proceeds to runbook), recommends alternatives (lead presents to user), or asks clarifying questions (lead presents to user, planner runs again with answers).

**Agent definition:**
- `model: opus` (judgment-heavy, not speed-critical)
- `permissionMode: plan` (read-only — produces a brief, not code)
- `maxTurns: 25`
- `memory: project` (remembers what features have been built, which were successful, patterns of over-engineering)
- `skills: agent-surface-assumptions, agent-evidence-over-intuition, agent-context-check, status-protocol`
- Tools: `Read, Glob, Grep, WebFetch, mcp__canon__get_principles, mcp__canon__get_file_context, mcp__canon__graph_query, mcp__canon__semantic_search`

This is not the chat agent (brainstorms) or the researcher (discovers facts). The planner's job is to **push back constructively** — "I could build this, but should I?"

### 2.4 How Claude orchestrates a Canon flow

A concrete example of `feature` flow (4–10 file feature):

1. **User says** "add dark mode to the settings page" to the Canon lead session.
2. **Claude evaluates** the request against the pre-build gate. Requirements are clear, scope is defined. Proceeds to build. (If vague, would spawn canon-planner first.)
3. **Claude reads** `CLAUDE.md`, sees Canon orchestration instructions. Reads the `feature` runbook for the recommended step sequence.
3. **Claude calls** `init_workspace` to create the workspace. Calls `get_principles` with the target file scope. Calls `get_file_context` for KG summaries. Assembles a research prompt.
4. **Claude spawns** a `canon-researcher` subagent. The researcher has Canon MCP access via its `tools` allowlist and calls `semantic_search`, `graph_query` directly. Returns a research synthesis artifact.
5. **Claude spawns** a `canon-architect` subagent with the research synthesis as upstream context. The architect queries the knowledge graph, designs the approach, produces a plan index with wave assignments.
6. **Claude presents** the plan to the user for approval (native HITL). User approves.
7. **Claude creates an agent team** for the implementation wave. Spawns N `canon-engineer` teammates in implementation mode (one per task from the plan index). Teammates self-coordinate via shared task list and Mailbox. `TaskCompleted` hooks enforce artifact production.
8. **Claude merges** worktrees after the wave completes. Runs inter-wave gates if configured.
9. **Claude spawns** a `canon-reviewer` subagent. Returns a review verdict.
10. **If verdict is not clean**, Claude spawns a `canon-engineer` subagent in fix mode with the review feedback. Loops review → fix until clean.
11. **Claude calls** `update_board({ operation: "complete_flow" })`, releases file claims, records metrics, evaluates learn gate. Done.

For a `fast-path` flow (simple bug fix), steps 2–6 are skipped — the lead goes straight to spawning a single `canon-engineer` subagent in implementation mode that handles implementation, testing, and self-review in one pass.

### 2.4 Subagent capabilities (per [Claude Code docs](https://code.claude.com/docs/en/sub-agents))

Subagents are far richer than "focused workers that report back." Canon's agent definitions can leverage the full subagent frontmatter:

| Capability | Frontmatter field | Canon application |
|-----------|-------------------|-------------------|
| **MCP access** | Default: inherits all tools including MCP. `tools` restricts. | Subagents call `get_principles`, `record_agent_metrics`, `get_file_context` directly. No lead injection needed. |
| **Scoped MCP** | `mcpServers: [canon]` | Reference the Canon MCP server by name for roles that restrict `tools`. Inline definitions also supported. |
| **Preloaded skills** | `skills: [skill-name]` | Inject Canon skills into subagent context at startup. Subagents don't inherit parent skills — must be explicit. |
| **Per-agent hooks** | `hooks: { PreToolUse: [...] }` | Tool enforcement scoped to a role: block destructive commands for researchers, validate SQL for db-reader. |
| **Persistent memory** | `memory: project` | Cross-session learning at user, project, or local scope. Maps to roadmap items 18 (short-term memory) and 19 (error/fix memory). |
| **Effort budget** | `maxTurns: N` | Limits agentic turns before stopping. Native effort budget — partially addresses the timeout gap (experiment 11/14). |
| **Permission mode** | `permissionMode: auto` | Per-role permissions without settings.local.json. `acceptEdits`, `auto`, `plan`, `dontAsk` available. |
| **Isolation** | `isolation: worktree` | Git worktree per spawn. Automatic cleanup if no changes. |
| **Model selection** | `model: haiku` | Route cheap tasks to Haiku, expensive tasks to Opus. Per-role cost optimization. |

**Key correction from experiment 18:** The experiment tested in an environment where the Canon MCP server wasn't connected. In a properly configured environment, subagents inherit Canon MCP tools by default. Both subagents and teammates have full Canon MCP access. The "subagent prompt quality" risk in the earlier draft was unfounded.

### 2.5 Dispatch framework

| Step pattern | Primitive | Rationale |
|-------------|-----------|-----------|
| Single agent, focused task, artifact goes to next step | **Subagent** | Fast, focused, returns result to lead. Has full MCP access — calls `get_principles`, `get_file_context` itself. |
| Sequential pipeline (research → plan → implement → review) | **Subagents** (chained) | Each step is independent; only the artifact connects them. Each subagent has its own MCP context. |
| Parallel implementation across files (wave tasks) | **Agent team** | Teammates coordinate via Mailbox, shared task list, file locking. |
| Debate / competing hypotheses | **Agent team** | Teammates challenge each other's findings directly. |
| Consultation (advisory, non-blocking) | **Subagent** | Quick opinion, result returns to lead. |
| Background housekeeping (janitor, learner) | **Subagent** (background + `memory: project`) | Persistent learning across sessions via memory frontmatter. |

### 2.5 Agent self-serve context (resilience model)

In the legacy model, agents were helpless — they received everything from the 9-stage prompt pipeline and couldn't self-serve. If a pipeline stage failed or was misconfigured, the agent operated with incomplete context silently.

In the new model, agents have MCP access and preloaded skills. This creates a **self-healing context chain**:

1. **Lead composes context** (primary path): calls `get_principles`, `get_file_context`, `get_drift_report` and includes results in the spawn prompt. This is what the CLAUDE.md orchestration guidance instructs.
2. **Agent self-serves** (fallback path): if the lead's prompt is missing principles or file context, the agent calls the MCP tools itself. Every agent with Canon MCP tools in its `tools` allowlist can independently call `get_principles(file_path, task_description)` to load matched principles.
3. **Skills guarantee baseline** (hard floor): critical rules and references are preloaded via `skills` frontmatter — they're in agent context regardless of what the lead or agent does. An engineer always has `agent-tdd-required`, a reviewer always has `agent-cold-review`.

A preloaded skill `agent-context-check` (registered as `rules/agent-context-check.md` → `skills/canon/references/agent-context-check.md`) is injected into every agent via the `skills` frontmatter. It instructs:

> Before starting work, verify you have Canon principles for your target files. If your spawn prompt does not include a `## Principles` section, call `get_principles` with your target file path and task description. Similarly, if you need file context or dependency information, call `get_file_context` or `graph_query` directly.

This is delivered via skill injection (layer 2, medium enforcement), not instruction body changes — agent definition bodies remain untouched.

This is **more resilient** than the legacy pipeline:
- Legacy: one pipeline → one failure point → silent context loss
- New: lead composition + agent self-serve + preloaded skills → three independent channels, any one sufficient

### 2.6 Why this is simpler

1. **One orchestrator: Claude.** No custom state machine, no custom scheduler, no transition resolver. Claude reads guidance and uses judgment — the thing it's best at.
2. **MCP tools as primitives.** Each Canon capability is a standalone MCP tool call, not a pipeline stage wired into a runtime. The lead composes them as needed, not in a fixed 13-stage sequence.
3. **Native coordination.** Subagents for sequential work, agent teams for parallel work. No custom wave plumbing, no custom message channel, no custom HITL vocabulary.
4. **Canon's value is untouched.** Principles, drift, KG, artifacts, metrics, commit provenance, file claims — all preserved as MCP tools. What's deleted is only the scheduling machinery.
5. **Self-healing context.** Agents self-serve missing context via MCP tools. Skills preload critical rules. Three independent context channels vs. one pipeline.
5. **Agent definitions work as-is.** All 11 agent defs are valid subagent and teammate types. The `tools` allowlist is honored in both paths per [Claude Code docs](https://code.claude.com/docs/en/agent-teams).

### 2.7 Orchestration journal (the lead's checklist)

CLAUDE.md guidance alone is prompt engineering — Claude reads it, usually follows it, sometimes doesn't. An earlier Canon iteration tried a separate orchestrator agent, but Claude didn't call it reliably. The solution is neither prose nor a separate agent: it's a **lightweight MCP tool that acts as the lead's checklist**.

The orchestration journal is ~50–80 lines of TypeScript. It provides two MCP tools:

```
log_step({ workspace, step_id, agent_type, artifacts_expected, mcp_tools_called })
verify_completion({ workspace }) → { steps_logged, steps_missing, artifacts_missing }
```

**How it works:**

1. **Flow start:** The lead reads the runbook, calls `init_workspace`, then calls `log_step` for each step it plans to execute. This creates the checklist from the runbook.
2. **Before each spawn:** The lead calls `log_step` with `status: "started"` and the expected artifacts. This is a natural pre-spawn step — CLAUDE.md instructs it, and the MCP tool schema validates the input.
3. **After each spawn:** The lead calls `log_step` with `status: "completed"` and the actual artifacts produced. If the artifact is missing, the lead sees the gap immediately.
4. **Flow end:** The completion verification hook calls `verify_completion`. If any step was started but not completed, or any expected artifact is missing, the hook exits 2 and blocks the lead from declaring done.

**What this provides beyond CLAUDE.md:**

| Property | CLAUDE.md alone | With journal |
|----------|----------------|-------------|
| Audit trail | None — conversation compacts away | Structured log in workspace, survives compaction |
| Completion enforcement | Soft — lead decides it's done | Hard — hook calls `verify_completion`, blocks if incomplete |
| Skipped step detection | None unless human notices | Journal shows logged vs. completed steps |
| Post-hoc analysis | Read the conversation (if available) | Read the journal (always available, structured) |
| MCP composition tracking | None | `mcp_tools_called` field records which tools the lead called per step |

**What this is NOT:**
- Not a state machine. No transition logic, no forced ordering, no "next state" resolution.
- Not scheduling. The lead still decides what to do next based on judgment.
- Not blocking at step boundaries. The lead can skip steps if justified — the journal just records that it did.
- Not a large addition. ~50–80 lines of TypeScript, one new MCP tool registration, one workspace JSON file.

The journal is to the orchestrator what a task list is to an agent team: a shared record of intent and progress that hooks can verify.

### 2.8 Enforcement model (defense-in-depth)

The state machine provided determinism through a single hard enforcement layer. The new model replaces it with seven layers, each covering different guarantees:

| Layer | Mechanism | Type | What it guarantees |
|-------|-----------|------|-------------------|
| 1 | CLAUDE.md + runbooks | Soft | Step ordering, MCP tool composition, dispatch decisions |
| 2 | Skills preloading | Medium | Critical rules and domain primers always in agent context |
| 3 | Orchestration journal (`log_step` / `verify_completion`) | Medium-hard | Audit trail of steps executed; completion hook blocks if steps missing |
| 4 | Agent definitions (`tools`, `maxTurns`, `permissionMode`) | Hard | Tool access restrictions, effort budgets, write permissions |
| 5 | Hooks (`TaskCompleted`, `PostCommit`, completion verification) | Hard | Artifact existence, commit trailers, completion cleanup |
| 6 | MCP tool contracts (schema validation) | Hard | Input/output shapes for `update_board`, `record_agent_metrics`, `write_*` |
| 7 | Workspace state (filesystem) | Hard | Artifacts on disk at known paths, auditable post-hoc |

**Plus self-healing context (§2.5):** if the lead misses a composition step, agents self-serve via MCP.

**Post-subagent artifact check (in CLAUDE.md guidance):** After each subagent returns, the lead verifies expected artifacts exist at the paths listed in the runbook's `artifacts` field before proceeding to the next step. This compensates for the lack of hook-based enforcement on subagents (`TaskCompleted` and `TeammateIdle` hooks only apply to agent teams teammates, not subagents).

**Completion verification hook:** Calls `verify_completion` from the orchestration journal. Blocks the lead from declaring done if:
- Any step was logged as "started" but not "completed"
- Any expected artifact is missing from disk
- Board state is not "complete"
- Claims are not released

**What's genuinely weaker and accepted:**
- Step ordering is not enforced — Claude may reorder steps. Accepted as a feature.
- Context composition quality varies — mitigated by agent self-serve (§2.5) and skills (layer 2).
- The lead can skip `log_step` calls entirely — but CLAUDE.md instructs it, the MCP tool is in its tools list, and the completion hook catches the gap at the end.

### 2.7 Platform capabilities (per Claude Code documentation)

This section replaces an earlier experimental validation section. The original 18 experiments were run using the Agent tool in a web environment where Canon's MCP server was not connected. This produced a flawed conclusion that subagents lacked MCP access — corrected twice after reviewing the actual documentation. Rather than present environment-limited experiments as evidence, this section cites the authoritative Claude Code documentation directly.

#### Subagent capabilities ([docs](https://code.claude.com/docs/en/sub-agents))

| Capability | Documentation quote / summary | Canon application |
|-----------|------------------------------|-------------------|
| **MCP inheritance** | "By default, subagents inherit all tools from the main conversation, including MCP tools." | Subagents call `get_principles`, `record_agent_metrics`, `get_file_context` directly. No lead injection needed. |
| **`tools` allowlist** | Restricts inherited tools when set. "A tool listed in both [tools and disallowedTools] is removed." | Canon agent defs can restrict per-role tool access. Omitting `tools` inherits everything including Canon MCP. |
| **`mcpServers`** | "Give a subagent access to MCP servers." Reference by name or inline. "String references share the parent session's connection." | Agent defs can reference `canon` MCP server by name for roles that restrict `tools` but still need Canon access. |
| **`skills`** | "Subagents don't inherit skills from the parent conversation; you must list them explicitly." Full content injected at startup. | Preload Canon skills per agent role. |
| **`hooks`** | Per-subagent lifecycle hooks (PreToolUse, etc.) | Tool enforcement scoped to a role — block destructive commands for researchers, validate queries for db-readers. |
| **`memory`** | Persistent directory that "survives across conversations." Scopes: user, project, local. | Maps directly to roadmap items 18 (short-term memory) and 19 (error/fix memory). Native cross-session learning. |
| **`maxTurns`** | "Maximum number of agentic turns before the subagent stops." | Native effort budget. Replaces custom `max_iterations` / `max_revisions`. |
| **`permissionMode`** | Per-subagent override: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. | Per-role permissions without worktree settings.local.json. |
| **`isolation: worktree`** | "Run the subagent in a temporary git worktree." Automatic cleanup if no changes. | Native worktree isolation per spawn. |
| **`model`** | Per-subagent model selection: `sonnet`, `opus`, `haiku`, or `inherit`. | Route cheap tasks (research) to Haiku, expensive tasks (implementation) to Opus. |

#### Agent teams capabilities ([docs](https://code.claude.com/docs/en/agent-teams))

| Capability | Documentation quote / summary | Canon application |
|-----------|------------------------------|-------------------|
| **MCP access** | "Each teammate loads the same project context as a regular session: CLAUDE.md, MCP servers, and skills." | Teammates have full Canon MCP access. |
| **Mailbox** | "When teammates send messages, they're delivered automatically to recipients." Direct teammate-to-teammate messaging. | Replaces custom `post_message` / `get_messages` and flow event channel. |
| **Plan approval** | "The teammate works in read-only plan mode until the lead approves their approach." | Maps directly to Canon's architect approval gate. Native HITL. |
| **Shared task list** | Dependencies auto-unblock. "Task claiming uses file locking to prevent race conditions." | Replaces custom wave task coordination. |
| **`tools` honored** | "The teammate honors that definition's tools allowlist and model." | Canon agent definitions enforce tool scope for teammates. |
| **Graceful shutdown** | "The lead sends a shutdown request. The teammate can approve or reject." | Partial abort for long-running teammates. |
| **Hooks** | `TeammateIdle` (exit 2 keeps teammate working), `TaskCreated`, `TaskCompleted` (exit 2 prevents completion). | Artifact enforcement and idle backstop. |

#### Limitations (from both docs)

| Limitation | Source | Impact |
|-----------|--------|--------|
| One team per session | Agent teams docs | Lead cleans up between flow phases. |
| No nested teams | Agent teams docs | Teammates cannot spawn teams. |
| No session resumption for teammates | Agent teams docs | Cross-session resume via artifacts only. |
| Subagents cannot spawn other subagents | Subagent docs | Single delegation depth. Lead orchestrates all spawning. |
| Skills not inherited by subagents | Subagent docs | Must list explicitly in `skills` frontmatter. |
| No compaction visibility | Neither docs | No hook for context compaction. Mitigate with reasoning checkpoints in artifacts. |
| No path enforcement | Neither docs | Worktree isolation sets CWD only, not a sandbox. Mitigate with per-agent `hooks` (PreToolUse). |

#### Phase 2 validation requirements

The following must be validated end-to-end with Canon's MCP server connected in a local environment (not this web session):

1. Subagents successfully call Canon MCP tools (`get_principles`, `record_agent_metrics`, `get_file_context`).
2. Agent definitions with `tools` restrictions plus `mcpServers: [canon]` retain Canon MCP access.
3. `maxTurns` stops a subagent at the configured limit.
4. `memory: project` persists and is readable across sessions.
5. `skills` preloading injects Canon skill content into subagent context.
6. Agent teams: teammates call Canon MCP tools, Mailbox delivers messages, `TaskCompleted` hook fires with exit 2 blocking, plan approval mode activates.
7. Full fast-path flow end-to-end: lead calls MCP tools → spawns subagents → verifies artifacts → runs effects → completes.

**Architecture confidence:** HIGH. The documentation confirms that both subagents and teammates have full Canon MCP access and that subagent definitions natively support effort budgets, persistent memory, scoped hooks, per-role permissions, and model selection. These capabilities replace several custom Canon mechanisms. The architecture requires no new code — only orchestration guidance (CLAUDE.md, runbooks, agent definition updates) and deletion of the legacy coordination layer.

---

## 3. Integration Disposition Table

Every one of the 28 gaps from the integration audit must map to a concrete replacement or an explicit deprecation. The "v2 home" column shows where each integration lives in the new architecture. Dispositions: **native** (Claude or Claude Code handles it), **mcp** (Canon MCP tool stays as-is), **hook** (enforcement via Claude Code hooks), **guidance** (CLAUDE.md / runbook instructions), **deprecate** (intentionally dropped with rationale).

### HIGH severity

| # | Integration | Legacy path | Disposition | v2 Home | Rationale |
|---|------------|-------------|-------------|---------|-----------|
| 1 | Auto-approve settings injection | `worktree-settings.ts` → `injectSettingsIntoRequests` | **native** | Replaced entirely by `permissionMode` frontmatter in agent definitions. `acceptEdits` for all code-writing agents (engineer, tester, scribe, shipper, learner, writer), `plan` for read-only agents (researcher, architect, reviewer, security, planner). No `auto` mode (requires Team/Enterprise — not available on Pro/Max per [docs](https://code.claude.com/docs/en/permission-modes)). `acceptEdits` works on all plans. No runtime settings injection, no `settings.local.json`, no worktree setup. Two YAML values replace ~614 lines of permission infrastructure. When the lead session runs in auto mode (Team/Enterprise), subagent `permissionMode` is overridden by the classifier. | Simpler AND more secure — `acceptEdits` is scoped to working directory by Claude Code. Works on all plans. |
| 2 | Tool profile resolution | `tool-profiles.ts` → `resolveToolProfile` | **native** | Replaced entirely by `tools` allowlist + `permissionMode` in agent definitions. `tools` controls which tools are available. `permissionMode` controls approval mode. Both are declarative YAML, enforced by Claude Code. `tool-profiles.ts` (322 lines), `trust-resolver.ts` (156 lines), and `worktree-settings.ts` (136 lines) are all deletable — permission model is now one frontmatter field, not a runtime computation. | Declarative over computed. KG-informed trust was over-engineered — the three `permissionMode` values cover all cases. |
| 3 | Workspace worktree creation | `wave-lifecycle.ts` → `createWaveWorktrees` | **native** | Lead creates worktrees via Bash (`git worktree add`) before spawning wave teammates. Lead merges via `git merge` after wave completes. Validated in experiment 3. | Git operations are native Bash commands. No MCP tool needed. |
| 4 | Context enrichment | `context-enrichment.ts` → `assembleEnrichment` | **mcp** | Lead calls `get_file_context`, `get_drift_report`, `graph_query` to assemble context. Injects results into spawn prompt. Teammates can also call these MCP tools directly. | Enrichment is already decomposed into standalone MCP tools. The 9-stage pipeline was just a fixed composition order. |
| 5 | Principle loading | `matcher.ts` → prompt pipeline stage 1 | **mcp** | Lead calls `get_principles(file_path, task_description)` → gets matched principles. Injects into spawn prompt. Teammates can also call `get_principles` directly via MCP. | Already a standalone MCP tool. Verified working in this environment (returned matched principles with file scope). |
| 6 | Commit provenance trailers | `commit-trailers.ts` → `buildProvenanceSection` | **guidance + hook** | CLAUDE.md and agent definitions instruct agents to include Canon trailers in commits. A PostCommit hook (`post-commit-trailers.sh`) validates trailer presence and blocks commits without `Canon-Workflow` trailer. | Downgrades from programmatic injection to convention, but the PostCommit hook provides enforcement backstop. |
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

---

## 4. Phase Boundaries

The migration has three phases. Phase 1 adds guidance (no deletions, no behavior change). Phase 2 validates (no deletions, feature-flagged behavior change). Phase 3 deletes (removes ~130 files / ~35,000 lines behind a verified flag flip).

### Phase 1 — Orchestration Guidance (additions only)

**Goal:** Give Claude everything it needs to orchestrate Canon flows natively, without touching the legacy code path.

**Preconditions:** None. Can start immediately.

**Deliverables:**

| Deliverable | Path | Purpose |
|------------|------|---------|
| Orchestration CLAUDE.md | `CLAUDE.md` (update) | Add orchestration discipline: how the lead composes context via MCP tools, when to use subagents vs agent teams, HITL patterns, post-step effects, completion checklist. |
| Runbook format template | `templates/runbook-template.md` | Canonical example defining the markdown + YAML frontmatter format. All runbooks conform to this. |
| Fast-path runbook | `skills/canon/runbooks/fast-path.md` | Implement → pre-launch-check → context-sync → ship → learn. Simplest build flow. |
| Feature runbook | `skills/canon/runbooks/feature.md` | Design → implement (wave) → verify → review → fix loop → context-sync → ship → learn. Absorbs refactor as a variant annotation. |
| Epic runbook | `skills/canon/runbooks/epic.md` | Research → design → multi-wave implement → test → security → review → fix loops → context-sync → ship → learn. |
| Migrate runbook | `skills/canon/runbooks/migrate.md` | Parallel research → design → implement (wave) → verify → security → review → fix → context-sync → ship → learn. |
| Test-gap runbook | `skills/canon/runbooks/test-gap.md` | Scan → write-tests → fix → review → context-sync. No ship step. |
| Agent def updates | `agents/*.md` | Add `maxTurns`, `permissionMode` frontmatter. Add `skills` frontmatter to preload role-specific rules and references (e.g., implementor gets `agent-tdd-required`, `principle-loading`; reviewer gets `agent-cold-review`). |
| Orchestration journal | `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` (~50–80 lines) | `log_step` and `verify_completion` MCP tools. The lead's checklist — records steps executed, completion hook verifies. |
| Commit trailer hook | `hooks/canon-agent-teams/post-commit-trailers.sh` | PostCommit hook validating Canon-Workflow trailer presence. |
| Completion verification hook | `hooks/canon-agent-teams/completion-verify.sh` | Calls `verify_completion` journal tool. Blocks "done" if steps or artifacts missing. |
| SessionStart doc-check hook | `hooks/canon-agent-teams/session-start-doc-check.sh` | Compares HEAD against `.canon/last-scribe-commit`. Nudges lead if documentation may be stale. |
| SessionStart KG-check hook | `hooks/canon-agent-teams/session-start-kg-check.sh` | Checks if `knowledge-graph.db` exists and is fresh (computed_at_commit matches HEAD). If missing or stale, instructs lead to run `codebase_graph` before proceeding. |
| SubagentStop scribe-queue hook | `hooks/canon-agent-teams/post-engineer-scribe.sh` | After `canon-engineer` completes, writes `pending-scribe.json` to workspace. Lead runs scribe before completing flow. |
| Feature flag | Environment variable `CANON_AGENT_TEAMS_MODE` | `off` (default): legacy `drive_flow` path unchanged. `on`: Claude reads runbooks, calls MCP tools, logs to journal, spawns agents natively. |

**Exit criteria:**
- All 5 runbooks written and reviewed.
- CLAUDE.md orchestration section reviewed.
- Agent definitions carry `tools` allowlists.
- Feature flag wiring: when `off`, `drive_flow` path is byte-identical to today.
- `npm test` passes, `npm run build` passes with zero new errors.

**MUST NOT touch:**
- Any file under `mcp-server/src/features/orchestration/`
- Any file under `mcp-server/src/features/prompt-pipeline/`
- Any flow YAML under `flows/`
- Any existing MCP tool implementation

### Phase 2 — Validation (no deletions)

**Goal:** Prove that Claude-as-lead with `CANON_AGENT_TEAMS_MODE=on` produces equivalent results to the legacy `drive_flow` path for every flow type.

**Preconditions:** Phase 1 complete. MCP server connected (Canon MCP tools available to the lead session).

**Deliverables:**

Phase 2 must be planned with the same rigor as Phase 1 — a task index, wave structure, and done criteria. The deliverables below define what Phase 2's task plan must cover.

| Deliverable | Method | Pass criteria |
|------------|--------|---------------|
| **Fast-path consistency (3 runs)** | Run the same bug-fix task 3 times with flag on. | All runs produce: implementation summary, review verdict. Artifact structure matches across runs. No MCP tool calls skipped. Post-step effects (metrics, claims) completed in all 3. |
| **Feature flow equivalence (3 runs)** | Run a 4–6 file feature 3 times with flag on, including wave dispatch via agent teams. | Shared task list created. Teammates coordinate without file conflicts. Worktrees merged. All artifacts produced. Commit trailers present (PostCommit hook validates). |
| **Epic flow end-to-end (1 run)** | Run a multi-wave epic with flag on. | Research, design, multi-wave implementation, review, fix cycle all complete. Lead maintains quality through 8+ spawn cycles. Context pressure does not degrade output. |
| **Agent teams MCP validation** | During feature/epic runs, verify teammate MCP access. | Teammates successfully call `get_principles`, `record_agent_metrics`. Principle-grounded output observed. |
| **Skill preloading validation** | Verify agent definitions with `skills` frontmatter receive preloaded content. | Spawned agents reference preloaded rules without Read tool calls. Confirm via transcript inspection. |
| **Regression (flag off, 3 flows)** | Run fast-path, feature, and review-only with flag off. | Zero divergence from pre-Phase-1 baseline behavior. |
| **Integration checklist** | After each run, check every HIGH-severity gap from §3 disposition table. | All 11 HIGH-severity integrations observed functioning in at least one run. Documented per-gap. |
| **Error handling** | Deliberately trigger: agent spawn failure, MCP tool error during a run. | Lead recovers gracefully. Retries or presents error to user. Does not silently drop the step. |
| **maxTurns exhaustion** | Set engineer maxTurns to 10, give a task that needs more. | Lead detects incomplete result, offers to retry with higher budget. Journal shows step as incomplete. |
| **Mid-flow resume** | Start a feature flow, complete 3 steps, end the session. Start a new session and say "resume". | Lead reads journal, identifies completed steps, loads artifact context, continues from the right step. |

**Exit criteria:**
- 3 successful runs each on fast-path and feature flows with flag on. Artifacts consistent across runs.
- 1 successful end-to-end epic flow with flag on.
- Agent teams validated for wave dispatch with teammate MCP access confirmed.
- Skill preloading validated for at least 3 agent types.
- Regression: flag off produces byte-identical behavior to baseline across 3 flow types.
- All 11 HIGH-severity integration gaps verified functioning (cross-reference §3).
- Error handling validated for at least 2 failure scenarios.
- Commit trailer PostCommit hook fires and validates correctly.
- Documented results in `docs/phase-2-validation-results.md` with per-run details.
- Phase 2 task plan reviewed and approved before execution.

**MUST NOT touch:**
- Any legacy implementation file. Phase 2 is read-only validation.
- Feature flag default (stays `off`).

### Phase 3 — Deletion

**Goal:** Remove the custom coordination layer. Flip the feature flag default to `on`, then remove the flag entirely after a stable period.

**Preconditions:** Phase 2 complete. All validation criteria met. Human sign-off on Phase 2 results.

**Phase 1 → Phase 2 handoff:** Human reviews Phase 1 validation report. Confirms: all runbooks cover their legacy flows, all agent defs parse, journal tool builds and tests pass, CLAUDE.md section complete. Only then does Phase 2 planning begin.

**Phase 2 → Phase 3 handoff:** Human reviews Phase 2 validation results. Confirms: consistency tests pass, all HIGH-severity gaps verified, resume protocol works, maxTurns exhaustion handled. Human sign-off required before any deletion.

**Sub-phase 3a: Flag flip.** Set `CANON_AGENT_TEAMS_MODE=on` as default. Legacy path still exists but is no longer the default. **Pre-flight:** all legacy in-progress workspaces must be completed or abandoned before the flip. Add a check to `init_workspace` that warns if legacy workspace state is detected without a journal. Monitor for regressions (1 week or 10 successful flows, whichever comes first).

**Sub-phase 3b: Delete coordination layer.** Pre-deletion checks: (1) grep `flows/` for non-standard files — if custom flow definitions exist, preserve them or provide a conversion guide; (2) analyze `enter-and-prepare-state.ts` dependencies on prompt-pipeline and refactor in a dedicated commit before main deletion. Then remove ~130 files / ~35,000 lines:

**Orchestration tools (10 files, ~2,089 lines):**

| File | Lines | What it did |
|------|-------|-------------|
| `tools/drive-flow.ts` | 587 | State machine main loop |
| `tools/drive-flow-helpers.ts` | 537 | Spawn request building, settings injection, HITL helpers |
| `tools/drive-flow-wave.ts` | 162 | Wave state entry |
| `tools/drive-flow-wave-lifecycle.ts` | 468 | Wave advancement, merge, cleanup |
| `tools/inject-wave-event.ts` | 81 | Wave event injection |
| `tools/resolve-wave-event.ts` | 94 | Wave event resolution |
| `tools/post-message.ts` | 24 | Agent mailbox write |
| `tools/get-messages.ts` | 37 | Agent mailbox read |
| `tools/resolve-after-consultations.ts` | 71 | Post-consultation resolution |
| `tools/get-spawn-prompt.ts` | 88 | Debug prompt assembly |

**Orchestration engine (3 files, ~632 lines):**

| File | Lines | What it did |
|------|-------|-------------|
| `engine/consultation-executor.ts` | 98 | Consultation prompt dispatch |
| `engine/compete.ts` | 152 | Competitive spawns |
| `engine/debate.ts` | 382 | Debate protocol |

**Orchestration services (4 files, ~1,394 lines):**

| File | Lines | What it did |
|------|-------|-------------|
| `services/wave-briefing.ts` | 89 | Wave summary assembly |
| `services/context-enrichment.ts` | 553 | Four-section enrichment block |
| `services/inject-context.ts` | 599 | Context injection resolution |
| `services/drive-flow-types.ts` | 158 | Drive-flow type definitions |

**Prompt pipeline (14 files, ~2,219 lines):** Entire `features/prompt-pipeline/` directory.

| Subdirectory | Files | Lines |
|-------------|-------|-------|
| `tools/` | 3 (assemble-prompt, fanout, validate) | ~740 |
| `services/` | 9 (all pipeline stages) | ~1,058 |
| `model/` | 2 (types, tool-profiles) | ~421 |

**Domains (4 files, ~594 lines):**

| File | Lines | What it did |
|------|-------|-------------|
| `workspaces/wave-events.ts` | 64 | Wave event types |
| `workspaces/wave-lifecycle.ts` | 233 | Worktree create/merge/cleanup |
| `workspaces/wave-variables.ts` | 92 | Variable escaping for waves |
| `flows/flow-event-channel.ts` | 205 | Mid-flow event channel |

**Flow definitions (31 files, ~3,071 lines):** Entire `flows/` directory including fragments, schema docs, and README.

**Tests (~65 files, ~26,854 lines):**

| Category | Files | Lines |
|----------|-------|-------|
| Drive-flow tests | 17 | ~8,896 |
| Wave event tests | 3 | ~1,318 |
| Consultation tests | 7 | ~3,212 |
| Engine tests (compete, debate) | 2 | ~950 |
| Spawn prompt tests | 4 | ~1,725 |
| Coordination integration tests | 3 | ~1,576 |
| Domain wave/flow tests | 5 | ~1,592 |
| Prompt-pipeline tests | 21 | ~7,585 |

**Registration changes:** Update `mcp-server/src/app/register-orchestration.ts` to remove:
- `registerWaveEventTools()` call
- `registerMessagingTools()` call
- `registerDriveFlowTool()` call
- Imports for all deleted tool handlers

**Refactoring required:** `enter-and-prepare-state.ts` (KEEP, 482 lines) imports from prompt-pipeline. These imports must be replaced or the file refactored before prompt-pipeline deletion.

**Exit criteria for sub-phase 3b:**
- `npm run build` passes with zero TypeScript errors.
- `npm test` passes (all remaining tests green; deleted test count matches expectation).
- Every file in the delete list is confirmed absent.
- `register-orchestration.ts` no longer imports deleted modules.
- `enter-and-prepare-state.ts` refactored to remove prompt-pipeline dependencies.
- No runtime references to deleted modules (grep confirms zero import paths to deleted files).
- 10 successful flows run after deletion (at least 1 per flow type).

**Sub-phase 3c: Remove feature flag.** After stable period post-deletion:
- Remove `CANON_AGENT_TEAMS_MODE` env var checks.
- Collapse any remaining conditional paths.
- Update all documentation referencing the flag.

**MUST NOT touch:**
- Any kept MCP tool implementation.
- Agent definitions (except `tools` allowlist updates done in Phase 1).
- Principles, rules, conventions.
- Hooks infrastructure.
- Shared libraries (`commit-trailers.ts`, `file-claims.ts`, `matcher.ts`).
- The MCP server entry point or registration for kept tools.

### Deletion summary

| Category | Files | Lines |
|----------|-------|-------|
| Implementation (coordination layer) | ~35 | ~6,928 |
| Flow definitions + docs | ~31 | ~3,071 |
| Tests | ~65 | ~26,854 |
| **Total** | **~131** | **~36,853** |

Expected reduction: approximately 40–45% of `mcp-server/src/` by line count. The remaining code is Canon's value: MCP tools, agent definitions, hooks, principles, shared libraries, and workspace management.

---

## 4b. Parallel Workstream: MCP & Intelligence Roadmap

See **`docs/mcp-intelligence-roadmap.md`** for the full roadmap of MCP tool improvements, KG intelligence enhancements, self-improving skills, and memory architecture.

This workstream is independent of Phases 1–3. All changes are backward-compatible. Summary of priorities:

| Priority | Focus | Key deliverable |
|----------|-------|----------------|
| **P0** | Reduce tool calls per spawn | `get_context` composite tool (1 call replaces 3-4) |
| **P1** | Prepare tools for new model | Journal init in `init_workspace`, `report_result` simplification |
| **P2** | Consolidation and cleanup | 6 `write_*` → 1 `write_artifact`, board/journal merge |
| **P3** | KG intelligence | `infer_domains`, community detection, confidence-scored edges, design rationale nodes |
| **P4** | Self-improving skills | Flow outcome tracking, skill effectiveness analysis, graph-structured memory |
| **P5** | Memory architecture | Ebbinghaus decay, 4-tier hierarchy, token budgets |

---

## 5. Validation Strategy

### How each phase proves it is complete

**Phase 1 (Orchestration Guidance):** purely additive — validated by review, not testing.

- Human review of all 5 runbooks against their legacy flow counterparts. Each runbook must cover every state in its legacy flow, including HITL gates, wave annotations, and expected artifacts.
- Human review of CLAUDE.md orchestration section. Must cover: MCP tool composition, dispatch framework (subagent vs team), HITL patterns, post-step effects, completion checklist, commit provenance convention.
- `npm run build` and `npm test` pass with zero changes to existing code (Phase 1 adds files only).
- Manual spot check: with flag `off`, run one legacy flow and confirm identical behavior.

**Phase 2 (Validation):** functional equivalence testing.

| Test | Method | Pass criteria |
|------|--------|--------------|
| **Fast-path equivalence** | Run the same bug-fix task with flag off (legacy) and flag on (Claude-as-lead). Compare artifact set. | Both runs produce: research synthesis, plan index, implementation summary, review verdict. Structure and coverage are comparable. |
| **Feature flow with waves** | Run a 4–6 file feature with flag on. Use agent teams for the implementation wave. | Shared task list created. Teammates claim tasks without conflicts. Worktrees created and merged. All artifacts produced. `TaskCompleted` hooks fire. |
| **Agent teams MCP access** | During the feature flow, verify teammates call Canon MCP tools. | Teammates successfully call `get_principles`, `record_agent_metrics`. Principle-grounded output observed. |
| **HITL gates** | Run a flow that requires architect approval. | Lead presents the plan to the user. Plan approval mode activates for the teammate. User approves. Implementation proceeds. |
| **Regression (flag off)** | Run 3 different flow types with flag off. | Zero divergence from baseline behavior. Artifacts byte-for-byte identical if same inputs. |
| **Consistency (flag on)** | Run fast-path 3 times on the same task with flag on. | All runs produce the same artifact types with comparable quality. No structural omissions across runs. |
| **Context pressure** | Run a full feature flow end-to-end (6+ spawns: research, architect, implement, review, fix, re-review). | Lead maintains orchestration quality through the final step. No context-related degradation (forgotten MCP calls, missing effects). |
| **Completion effects** | After any flow with flag on, verify post-completion. | `update_board complete_flow` called. File claims released. Agent metrics recorded. Learn gate evaluated if applicable. |

**Phase 3 (Deletion):** structural integrity.

- `npm run build` passes with zero TypeScript errors after all deletions.
- `npm test` passes. Expected test count drops by ~65 test files. No unexpected test failures.
- `grep -r` confirms zero remaining imports to deleted module paths across the entire codebase.
- `register-orchestration.ts` compiles and registers only kept tools.
- 10 successful flows post-deletion (at least 1 per flow type) confirming no runtime regressions.

### Rollback path

**Phase 1:** Revert the CLAUDE.md and runbook additions. No code was changed.

**Phase 2:** Flip the feature flag back to `off`. Legacy path runs unchanged.

**Phase 3a (flag flip):** Flip the flag back to `off`. Legacy code is still present.

**Phase 3b (deletion):** `git revert` the deletion commit(s). This is the point of no easy return — all deletion commits must be atomic per-directory to enable targeted reverts. Alternatively, the legacy code exists on main's git history and can be cherry-picked back.

**Phase 3c (flag removal):** No rollback needed — the flag is gone because the legacy path is gone.

---

## 6. Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **Claude doesn't consistently follow orchestration guidance.** The lead skips MCP tool calls, forgets post-step effects, or doesn't follow the runbook. | HIGH | MEDIUM | CLAUDE.md instructions are authoritative. Hooks enforce artifacts (`TaskCompleted`). Post-flow audit: `update_board complete_flow` validates metrics were recorded. Consistency testing in Phase 2 catches systematic omissions. |
| **Agent teams is experimental and may change.** The `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag may be renamed, behavior may change, or the feature may be deprecated. | HIGH | LOW | Feature flag gating isolates Canon from upstream changes. If agent teams breaks, fall back to subagent-only mode (sequential flows still work; wave parallelism degrades to sequential). Monitor Claude Code changelog. |
| **The plan may have missed integrations.** The 28-gap audit is thorough but not provably exhaustive. New integrations may have landed since the audit. | MEDIUM | MEDIUM | Phase 2 validation catches functional gaps. Re-audit checkpoint: before Phase 3 deletion, re-run the integration comparison between legacy output and Claude-as-lead output. |
| **Agent definitions may restrict MCP access unintentionally.** If an agent def specifies a `tools` allowlist that omits MCP tools, the subagent loses Canon MCP access. Must ensure agent defs either omit `tools` (inherit all) or include `mcpServers: [canon]` alongside restricted tool lists. | LOW | MEDIUM | Audit all 11 agent definitions in Phase 1. For roles with restricted `tools`, add `mcpServers: [canon]` to preserve MCP access. Test each role's MCP access during Phase 2 validation. |
| **Context window pressure during long flows.** Each spawn cycle adds prompt + response to the lead's context. Epic flows with many waves may exhaust the lead's context window. | MEDIUM | LOW | Context compaction is automatic in Claude Code. Lead persists critical state to workspace artifacts (not just conversation). Phase 2 context pressure test validates this explicitly. |
| **One team per session limits flow composition.** Agent teams docs: "a lead can only manage one team at a time." Flows that need multiple teams (e.g., epic with research team → implementation team) must tear down and rebuild. | LOW | HIGH | Documented in CLAUDE.md: "Clean up the current team before starting a new one." The lead tears down between phases. This matches the legacy model (one wave at a time). |
| **No hard abort for stuck agents.** Experiment 11/14 confirmed: no timeout parameter, graceful shutdown only for teammates. | LOW | LOW | Prompt-based budgets. Lead monitors duration. For teammates: graceful shutdown request. Stream idle timeout (~100s) catches stalled agents. |
| **No path enforcement in worktree isolation.** Experiment 16 confirmed: worktree isolation only sets CWD, not a sandbox. | LOW | LOW | Pre-tool hooks can reject out-of-bounds writes. Agent definitions restrict tool access via `tools` allowlist. This is an existing gap, not introduced by the migration. |
| **enter-and-prepare-state.ts refactoring risk.** This 482-line file imports from prompt-pipeline (being deleted). Refactoring it incorrectly could break kept MCP tools. | MEDIUM | LOW | Refactor in a dedicated commit before the main deletion. Test thoroughly. The file's responsibility (state entry + prompt assembly) partially overlaps with the deleted pipeline — determine what it still needs vs. what it delegated to the pipeline. |
| **Orchestration journal is a single point of enforcement.** If the lead skips `log_step` calls, the completion hook becomes a no-op (nothing to verify). Layers 3 and 5 of the enforcement model both depend on the journal being populated. | MEDIUM | MEDIUM | CLAUDE.md instructs `log_step` calls. The completion hook should also check that at least N journal entries exist (matching the runbook step count), not just that logged entries are complete. If zero entries exist, the hook blocks with "no journal entries — lead must call log_step for each runbook step." |

---

## 7. Out of Scope

The following are explicitly NOT part of this migration:

1. **Rewriting Canon's MCP tools beyond the parallel workstream.** The 38 MCP tools stay functionally unchanged. The parallel workstream (§4b) adds batch modes, simplifies state-machine-dependent tools, and prepares tools for the new model — but these are backward-compatible improvements, not rewrites. The migration itself (Phases 1–3) does not modify MCP tool implementations except adding the orchestration journal.

2. **Modifying agent definitions.** Agent definitions in `agents/*.md` get `tools` allowlist updates in Phase 1 but no behavioral changes. Their prompt bodies, model selections, and role descriptions are unchanged.

3. **Modifying principles, rules, or conventions.** Canon's 54 principles are untouched. The matcher, compliance checker, and drift system are untouched.

4. **Rewriting the knowledge graph.** `codebase_graph`, `graph_query`, `semantic_search` and their underlying SQLite database are untouched.

5. **Changing the artifact storage layout.** `.canon/workspaces/<id>/` structure stays. Artifact schemas stay. Write tools stay.

6. **Building a custom prompt pipeline replacement.** The v2 architecture does NOT build a new pipeline. Claude calls MCP tools directly. There is no "plan-time pipeline" — that was the earlier draft's design, superseded by the simpler "Claude calls tools" model.

7. **Closing or modifying PR #112.** The v1 Phase 1/2 code on `canon/agent-teams-phase-2` is read-only reference. PR #112 is handled separately by the user.

8. **Executing any phase of this plan.** This document is the plan. Execution is a separate session after the plan is reviewed and approved.

9. **Upstream Claude Code changes.** The plan does not depend on Anthropic shipping new features (timeout parameter, path enforcement, compaction hooks). It works with Claude Code as it exists today. Mitigations for confirmed gaps use existing mechanisms.

10. **Performance optimization beyond §4b.** The parallel workstream covers batch modes and tool simplification. Deeper optimizations (caching, response compression, lazy loading) are deferred unless Phase 2 validation reveals a performance problem.
