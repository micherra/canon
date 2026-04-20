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
  → Claude (lead) reads CLAUDE.md + agent defs
  → Classifies intent per-message (L1 re-classification discipline)
  → Build intent: spawns canon-planner
      → Planner emits planning-brief.md + runbook.md
      → Iterates with user until approval
  → Claude calls Canon MCP tools to compose context for each step
  → Claude spawns subagents or creates agent team per synthesized runbook
  → Agents work (both subagents and teammates have Canon MCP access)
  → Claude handles HITL, effects, completion natively
  → Claude calls Canon MCP tools for analytics and cleanup
  → completion-verify.sh snapshots the workspace to lifecycle DB
```

**What stays (Canon's value):**

| Layer | What | Why |
|-------|------|-----|
| **MCP tools** | `get_principles`, `list_principles`, `get_compliance`, `get_drift_report`, `get_file_context`, `graph_query`, `semantic_search`, `codebase_graph`, `record_agent_metrics`, `post_event`, `show_pr_impact`, `review_code`, `store_pr_review`, `store_summaries` | These ARE Canon. Principles, drift, KG, artifacts, metrics — Claude uses them as a native toolkit. |
| **Agent definitions** | 11 types in `agents/*.md` (v2 Phase 1: delete implementor + fixer + guide + chat, add engineer + planner) | Valid as both subagent types and agent team teammate types. Definitions support `skills` (preload rules + domain primers), `maxTurns` (effort budget), `permissionMode`, `memory`. Six agents get `memory: project`: planner (feature history), engineer (fix patterns), researcher (codebase topology), architect (design history), scribe (doc landscape), learner (pattern mining). Reviewer excluded per `agent-cold-review` rule. Guide and chat removed — lead handles these natively. Each agent includes `agent-context-check` skill for self-serve context verification. |
| **Orchestration journal** | `log_step`, `verify_completion` MCP tools | The lead's checklist. Records steps executed, artifacts expected, domain skills loaded, per-step outcome. Completion hook verifies. Not a state machine — no scheduling, no forced ordering. |
| **Domain skills** | 12 skill files in `skills/canon/references/` (6 existing + 6 new) | Domain expertise loaded on-demand by the lead or agent based on task scope. |
| **Step vocabulary + synthesis skills** (new in v2.1a) | `skills/canon/references/runbook-vocabulary.md`, `skills/canon/references/runbook-synthesis.md`, `skills/canon/references/planner-brief.md` | The canonical set of step IDs Canon knows + the rules the planner follows to compose a runbook from them. Replaces v2's 5 hardcoded runbook files. |
| **Hooks** | `TaskCompleted`, `TeammateIdle`, `PostCommit`, `SessionStart`, `SubagentStop`, `completion-verify.sh`, `canon-workspace-check.sh` (new in v2.1a — L4) | Artifact enforcement, trailer enforcement, doc staleness detection, scribe queuing, completion verification, Canon-bypass detection. |
| **Workspace storage** | `.canon/workspaces/<id>/` | Artifact storage, progress tracking. Ephemeral — snapshotted to lifecycle DB at completion, then torn down. |
| **Lifecycle DB** (new in v2.1b) | `.canon/drift-db.sqlite` extended with `lifecycle_workspace_snapshots` table | Durable per-flow record surviving workspace cleanup. Substrate for the learning system. |
| **Shared libraries** | `commit-trailers.ts`, `file-claims.ts`, `matcher.ts` | Principle matching, commit provenance, file ownership. |

**What goes (the custom coordination layer — deleted in Phase 3):**

| Component | File(s) | Why it's deletable |
|-----------|---------|-------------------|
| State machine runtime | `drive-flow.ts`, `drive-flow-helpers.ts`, `drive-flow-wave.ts`, `drive-flow-wave-lifecycle.ts` | Claude sequences steps natively. |
| 9-stage prompt pipeline | `features/prompt-pipeline/` (all stages) | Claude calls MCP tools directly to compose context before spawning. |
| Flow YAML runtime | Parser, validator, fragment inclusion, transition matcher | Claude reads vocabulary + synthesis skill for guidance; no executable state machine needed. |
| Wave event plumbing | `inject_wave_event`, `resolve_wave_event`, flow event channel | Agent teams' native Mailbox + task list replace custom wave coordination. |
| Custom HITL vocabulary | Five breakpoint shapes, convergence exhausted, gate failure | Claude handles HITL natively. Agent teams' plan approval mode covers architect gates. |
| Message channel | `post_message`, `get_messages` | Agent teams' Mailbox replaces this. |
| Session continuation | `applySessionContinuation` | Claude includes context summaries in spawn prompts naturally. |
| Consultation executor | `consultation-executor.ts` | Claude can spawn an advisory subagent directly — no special mechanism needed. |

### 2.3 Pre-build gate — canon-planner (v2.1 iterate-until-approved)

Claude defaults to action — "add dark mode" → starts building. Canon needs to be smarter. Before committing to any build flow, the lead evaluates whether the request is ready to build:

- Is the problem clearly defined?
- Are acceptance criteria explicit?
- Have alternatives been considered?
- Is the value proportional to the effort?

v2's pre-build gate made this a conditional call to `canon-planner` (spawn only if the request was vague). v2.1 changes this to an unconditional rule: **every build request routes through `canon-planner`**, not just vague ones. The planner produces two artifacts per build and iterates with the user until approval.

**canon-planner v2.1 responsibilities:**

1. **Clarifies requirements** — "What problem are you solving? Who benefits?"
2. **Challenges assumptions** — "You're assuming users need X. What if Y is the actual need?"
3. **Evaluates alternatives** — "You could build this, or configure the existing system to do 80% of it."
4. **Assesses value** — "This would take ~4 agents across 2 waves. Is the value proportional?"
5. **Produces a planning brief** — `plans/${slug}/planning-brief.md`: problem statement, target users, acceptance criteria, alternatives considered, recommended approach, open questions.
6. **Synthesizes a runbook** — `plans/${slug}/runbook.md`: step sequence composed from the canonical vocabulary (see §5.1) per the synthesis contract (see §5.3).
7. **Iterates with the user until approval** — conversational mechanism; intermediate iterations persisted to the lifecycle DB for analytics.

The planner's job is asymmetric: strategic for the brief (value assessment, alternatives, clarifying questions), mechanical for the synthesis (vocabulary-based step composition, HITL posture, artifact paths). v2.1 captures these as two skill files — `planner-brief.md` and `runbook-synthesis.md` — that the planner loads. The agent body shrinks to: load these skills, emit both artifacts, run the iterate-until-approved loop.

**Agent definition (v2.1):**
- `model: opus` (judgment-heavy, not speed-critical)
- `permissionMode: plan` (read-only — produces a brief + runbook, not code)
- `maxTurns: 40` (iteration loop may take several rounds)
- `memory: project` (remembers what features have been built, which were successful, patterns of over-engineering)
- `skills: planner-brief, runbook-synthesis, agent-surface-assumptions, agent-evidence-over-intuition, agent-context-check, status-protocol`
- Tools: `Read, Glob, Grep, WebFetch, mcp__canon__get_principles, mcp__canon__get_file_context, mcp__canon__graph_query, mcp__canon__semantic_search`

This is not the chat agent (brainstorms, removed in v2) or the researcher (discovers facts). The planner's job is to **push back constructively** — "I could build this, but should I? Here's the plan and the questions."

**Trivial requests still clear quickly.** The planner calibrates proposal depth to request complexity: a one-line typo fix produces a 1-step runbook with a one-line overview, approval clears in seconds with "go." A multi-wave epic produces a full brief and may iterate several rounds. v2 had a two-path fast-path / feature split; v2.1 replaces it with one path (planner) whose *output* scales with complexity. See §6 for the iterate-until-approved mechanism and §6.2 for the lightweight-proposal pattern.

### 2.4 How Claude orchestrates a Canon flow (iterate-until-approved)

A concrete example of a medium build — "add dark mode to the settings page":

1. **User says** "add dark mode to the settings page" to the Canon lead session.
2. **Claude classifies intent** (per-message, per L1 re-classification discipline; see §6.4). This is a build request → routes to `canon-planner`.
3. **Claude spawns `canon-planner`.** Planner loads `planner-brief` and `runbook-synthesis` skills. Reads user request; calls `get_principles` with target-file scope; calls `get_file_context` for KG summaries. Produces `planning-brief.md` + initial `runbook.md` + confidence signals.
4. **Claude presents** the brief + proposed runbook to the user, including the per-signal confidence breakdown. User reviews.
5. **User iterates.** Possible paths: clarification ("what about the mobile view?"), redirect ("skip the design step — it's a CSS change"), modification ("use theme variable X, not Y"). Each iteration re-spawns the planner with full workspace context; new runbook row persisted to the lifecycle DB.
6. **User approves** the final runbook. Lead records the approval internally; the approved runbook row is the one executed against.
7. **Claude calls** `init_workspace` to create the workspace. Calls MCP tools per the runbook's per-step `mcp_tools` field to compose context for the first step.
8. **Claude executes the approved runbook step by step.** For each step: calls MCP tools to compose context per the step's `mcp_tools` field; spawns the step's declared agent via `dispatch: subagent` or `team`; verifies artifacts exist at declared paths before proceeding.
9. **Agents do the work.** Both subagents and teammates have Canon MCP access; they call `get_principles`, `get_file_context`, `graph_query` directly.
10. **Claude handles HITL** at declared step postures (`approval` / `checkpoint` / `on_failure`). Confidence does not modify HITL postures — it is advisory only (see §7.3).
11. **Review + fix loop** if the runbook includes it. Fix is a step with `cause:` set (see §5.2).
12. **Claude calls** `update_board({ operation: "complete_flow" })`, releases file claims, records metrics. `completion-verify.sh` fires, calls `verify_completion` and then `snapshot_workspace({ workspace_id })`. Workspace is torn down after snapshot. Done.

For a **trivial bug fix** (lightweight proposal — see §6.2):
- Steps 1–6 still happen, but the planner synthesizes a 1-step runbook with a one-line overview; user approves in seconds with "go."
- Steps 7–12 run against that minimal runbook.

**Thin-gate-no-skip pattern.** Every build routes through planner, but trivial work produces trivial plans that clear quickly. There is no autodispatched fast-path that skips synthesis or approval.

### 2.5 Subagent capabilities (per [Claude Code docs](https://code.claude.com/docs/en/sub-agents))

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

### 2.6 Dispatch framework

| Step pattern | Primitive | Rationale |
|-------------|-----------|-----------|
| Single agent, focused task, artifact goes to next step | **Subagent** | Fast, focused, returns result to lead. Has full MCP access — calls `get_principles`, `get_file_context` itself. |
| Sequential pipeline (research → plan → implement → review) | **Subagents** (chained) | Each step is independent; only the artifact connects them. Each subagent has its own MCP context. |
| Parallel implementation across files (wave tasks) | **Agent team** | Teammates coordinate via Mailbox, shared task list, file locking. |
| Debate / competing hypotheses | **Agent team** | Teammates challenge each other's findings directly. |
| Consultation (advisory, non-blocking) | **Subagent** | Quick opinion, result returns to lead. |
| Background housekeeping (janitor, learner) | **Subagent** (background + `memory: project`) | Persistent learning across sessions via memory frontmatter. |

### 2.7 Agent self-serve context (resilience model)

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

### 2.8 Why this is simpler (amended for v2.1)

1. **One orchestrator: Claude.** No custom state machine, no custom scheduler, no transition resolver. Claude reads guidance and uses judgment — the thing it's best at.
2. **MCP tools as primitives.** Each Canon capability is a standalone MCP tool call, not a pipeline stage wired into a runtime. The lead composes them as needed, not in a fixed 13-stage sequence.
3. **Native coordination.** Subagents for sequential work, agent teams for parallel work. No custom wave plumbing, no custom message channel, no custom HITL vocabulary.
4. **Canon's value is untouched.** Principles, drift, KG, artifacts, metrics, commit provenance, file claims — all preserved as MCP tools. What's deleted is only the scheduling machinery.
5. **Self-healing context.** Agents self-serve missing context via MCP tools. Skills preload critical rules. Three independent context channels vs. one pipeline.
6. **Agent definitions work as-is.** All 11 agent defs are valid subagent and teammate types. The `tools` allowlist is honored in both paths.
7. **Canon's whole stack improves from every interaction** (v2.1 addition). The learning system is one mechanism — observation → pattern → proposal → refinement — applied across every Canon artifact type. Principles, conventions, synthesis skill, planning brief skill, and templates are the five in-scope v2.1 refinement targets; the mechanism is uniform; the learner curates weekly (see §3).
8. **Runbooks as data, not files** (v2.1 addition). v2's 5 static runbook files are replaced by 1 vocabulary file + 2 skills; runbooks are synthesized per plan by `canon-planner`. Plan quality becomes learnable where static runbooks couldn't learn (see §5).

### 2.9 Orchestration journal (the lead's checklist; v2.1 extensions)

CLAUDE.md guidance alone is prompt engineering — Claude reads it, usually follows it, sometimes doesn't. The solution is neither prose nor a separate agent: it's a **lightweight MCP tool that acts as the lead's checklist**.

The orchestration journal provides two MCP tools:

```
log_step({ workspace, step_id, agent_type, artifacts_expected, mcp_tools_called, domain_skills_loaded, outcome })
verify_completion({ workspace }) → { steps_logged, steps_missing, artifacts_missing, flow_outcome }
```

**How it works:**

1. **Flow start:** Lead reads the synthesized runbook and calls `log_step` for each planned step. Creates the checklist.
2. **Before each spawn:** `log_step` with `status: "started"` plus expected artifacts.
3. **After each spawn:** `log_step` with `status: "completed"` plus actual artifacts.
4. **Skipped steps:** `log_step` with `status: "skipped"` plus reason (from the synthesized `skip_when`).
5. **Flow end:** `completion-verify.sh` hook calls `verify_completion`. Blocks the lead from declaring done if any step is missing or any expected artifact is missing.
6. **Snapshot** (v2.1b addition): after `verify_completion` clears, the hook calls `snapshot_workspace({ workspace_id })` which materializes the workspace into `lifecycle_workspace_snapshots`. Workspace can then be torn down.

**v2.1 extensions to the journal:**

- **`domain_skills_loaded` field** — captures which skills the agent loaded per step. Enables skill-effectiveness analyses (learner input; see §3).
- **`outcome` field** — typed per-step outcome (review verdict, fix iterations, test pass rate). Feeds Phase 2 calibration.
- **Snapshot integration** — `completion-verify.sh` extends to invoke `snapshot_workspace` after `verify_completion` clears.

**What this provides beyond CLAUDE.md:**

| Property | CLAUDE.md alone | With journal |
|----------|----------------|-------------|
| Audit trail | None — conversation compacts away | Structured log in workspace + lifecycle DB, survives compaction and workspace teardown |
| Completion enforcement | Soft — lead decides it's done | Hard — hook calls `verify_completion`, blocks if incomplete |
| Skipped step detection | None unless human notices | Journal shows logged vs. completed vs. skipped |
| Post-hoc analysis | Read the conversation (if available) | Query `lifecycle_workspace_snapshots`; structured, always available |
| Skill-effectiveness tracking (v2.1) | None | `domain_skills_loaded` correlated with `outcome` → learner input |

**What this is NOT:**
- Not a state machine. No transition logic, no forced ordering, no "next state" resolution.
- Not scheduling. The lead still decides what to do next based on judgment.
- Not blocking at step boundaries. The lead can skip steps if justified — the journal records the skip.

The journal is to the orchestrator what a task list is to an agent team: a shared record of intent and progress that hooks can verify.

### 2.10 Enforcement model — defense-in-depth (amended for v2.1)

The state machine provided determinism through a single hard enforcement layer. v2.1 replaces it with **eight** layers (v2 had seven; v2.1 adds L4 as the PreToolUse hook backstop):

| Layer | Mechanism | Type | What it guarantees |
|-------|-----------|------|-------------------|
| 1 | CLAUDE.md + vocabulary + synthesis skill | Soft | Step ordering, MCP tool composition, dispatch decisions, **per-message intent re-classification** (v2.1 L1 addition) |
| 2 | Skills preloading | Medium | Critical rules and domain primers always in agent context |
| 3 | Orchestration journal (`log_step` / `verify_completion`) | Medium-hard | Audit trail of steps executed, skills loaded, per-step outcomes; completion hook blocks if steps missing |
| 4 | Agent definitions (`tools`, `maxTurns`, `permissionMode`) | Hard | Tool access restrictions, effort budgets, write permissions |
| 5 | **`canon-workspace-check.sh` PreToolUse hook (v2.1a L4 addition)** | Hard | Blocks `Edit` / `Write` / `Bash`-that-modifies-code when no active Canon workspace exists for the current flow. Backstops L1 against intent-misclassification drift. |
| 6 | Hooks (`TaskCompleted`, `PostCommit`, `completion-verify.sh`) | Hard | Artifact existence, commit trailers, completion cleanup, lifecycle snapshot |
| 7 | MCP tool contracts (schema validation) | Hard | Input/output shapes for `update_board`, `record_agent_metrics`, `write_*`, `snapshot_workspace` (v2.1b) |
| 8 | Workspace state + lifecycle DB | Hard | Artifacts on disk at known paths while workspace exists; structured record in lifecycle DB surviving workspace cleanup |

**Plus self-healing context (§2.7):** if the lead misses a composition step, agents self-serve via MCP.

**Post-subagent artifact check (in CLAUDE.md guidance):** After each subagent returns, the lead verifies expected artifacts exist at the paths listed in the runbook's `artifacts` field before proceeding to the next step. Compensates for the lack of hook-based enforcement on subagents (`TaskCompleted` and `TeammateIdle` hooks apply only to agent teams teammates, not subagents).

**Completion verification hook** (`completion-verify.sh`): calls `verify_completion` + then `snapshot_workspace` (v2.1b addition). Blocks the lead from declaring done if:
- Any step was logged as "started" but not "completed"
- Any expected artifact is missing from disk
- Board state is not "complete"
- Claims are not released
- Snapshot fails (v2.1b)

**Canon-bypass check hook** (`canon-workspace-check.sh`, v2.1a L4 addition): blocks `Edit` / `Write` / `Bash` code-modification when no active Canon workspace exists for the current flow. Prevents Claude from drifting out of Canon during session transitions (e.g., chat/question session pivoting to build request, lead continuing with native tools rather than re-routing through planner).

> **Implementation note.** The architect review flags L4's predicate as needing a principled allowlist (`.gitignore`-based) and an intent-routing expansion so that `principle`, `learn`, and `docs` intents also create workspaces. Both items must be resolved before v2.1a ships L4. See `docs/agent-teams-migration-plan-v2.1-review.md` §4.1 HIGH-1.

**What's genuinely weaker and accepted:**
- Step ordering is not enforced — Claude may reorder steps. Accepted as a feature.
- Context composition quality varies — mitigated by agent self-serve (§2.7) and skills (layer 2).
- The lead can skip `log_step` calls entirely — but CLAUDE.md instructs it, the MCP tool is in its tools list, and the completion hook catches the gap at the end.
- Confidence signals may be miscalibrated initially (LLM overconfidence bias) — mitigations in §7.4; learner calibration in v2.2.

### 2.11 Platform capabilities (per Claude Code documentation)

This section cites the authoritative Claude Code documentation. Both subagents and teammates have full Canon MCP access when properly configured.

#### Subagent capabilities ([docs](https://code.claude.com/docs/en/sub-agents))

| Capability | Documentation quote / summary | Canon application |
|-----------|------------------------------|-------------------|
| **MCP inheritance** | "By default, subagents inherit all tools from the main conversation, including MCP tools." | Subagents call `get_principles`, `record_agent_metrics`, `get_file_context` directly. No lead injection needed. |
| **`tools` allowlist** | Restricts inherited tools when set. | Canon agent defs can restrict per-role tool access. Omitting `tools` inherits everything including Canon MCP. |
| **`mcpServers`** | "Give a subagent access to MCP servers." Reference by name or inline. | Agent defs can reference `canon` MCP server by name for roles that restrict `tools` but still need Canon access. |
| **`skills`** | "Subagents don't inherit skills from the parent conversation; you must list them explicitly." | Preload Canon skills per agent role. |
| **`hooks`** | Per-subagent lifecycle hooks (PreToolUse, etc.) | Tool enforcement scoped to a role. |
| **`memory`** | Persistent directory that "survives across conversations." Scopes: user, project, local. | Native cross-session learning. |
| **`maxTurns`** | "Maximum number of agentic turns before the subagent stops." | Native effort budget. |
| **`permissionMode`** | Per-subagent override. | Per-role permissions without `settings.local.json`. |
| **`isolation: worktree`** | "Run the subagent in a temporary git worktree." Automatic cleanup if no changes. | Native worktree isolation per spawn. |
| **`model`** | Per-subagent model selection. | Route cheap tasks to Haiku, expensive tasks to Opus. |

#### Agent teams capabilities ([docs](https://code.claude.com/docs/en/agent-teams))

| Capability | Documentation quote / summary | Canon application |
|-----------|------------------------------|-------------------|
| **MCP access** | "Each teammate loads the same project context as a regular session: CLAUDE.md, MCP servers, and skills." | Teammates have full Canon MCP access. |
| **Mailbox** | Direct teammate-to-teammate messaging. | Replaces custom `post_message` / `get_messages` and flow event channel. |
| **Plan approval** | "The teammate works in read-only plan mode until the lead approves their approach." | Maps directly to Canon's architect approval gate. Native HITL. |
| **Shared task list** | Dependencies auto-unblock. "Task claiming uses file locking to prevent race conditions." | Replaces custom wave task coordination. |
| **`tools` honored** | "The teammate honors that definition's tools allowlist and model." | Canon agent definitions enforce tool scope for teammates. |
| **Graceful shutdown** | Lead sends a shutdown request; teammate can approve or reject. | Partial abort for long-running teammates. |
| **Hooks** | `TeammateIdle`, `TaskCreated`, `TaskCompleted` (exit 2 prevents completion). | Artifact enforcement and idle backstop. |

#### Limitations

| Limitation | Source | Impact |
|-----------|--------|--------|
| One team per session | Agent teams docs | Lead cleans up between flow phases. |
| No nested teams | Agent teams docs | Teammates cannot spawn teams. |
| No session resumption for teammates | Agent teams docs | Cross-session resume via artifacts only. |
| Subagents cannot spawn other subagents | Subagent docs | Single delegation depth. Lead orchestrates all spawning. |
| Skills not inherited by subagents | Subagent docs | Must list explicitly in `skills` frontmatter. |
| No compaction visibility | Neither docs | No hook for context compaction. Mitigate with reasoning checkpoints in artifacts. |
| No path enforcement | Neither docs | Worktree isolation sets CWD only, not a sandbox. Mitigate with per-agent `hooks` (PreToolUse) and L4 (`canon-workspace-check.sh`). |

---

## 3. Canon's learning system

Canon's quality-up story depends on a single mechanism applied across every dimension of what it produces:

**Observation → Pattern → Proposal → Refinement**

- **Observation** — a single data point from a flow. "In flow X, review found principle P violation on file Y; fix took N iterations; the fix summary cited root cause Z."
- **Pattern** — recurring observations across multiple flows. "10 recent flows showed principle P violations on auth-related files; 8 shared the same underlying cause."
- **Proposal** — a concrete refinement suggestion grounded in the pattern. Structured patch to an artifact.
- **Refinement** — an accepted proposal applied to the relevant Canon artifact.

Every interaction contributes observations to a growing corpus. The learner periodically mines that corpus for patterns and emits proposals. A Canon maintainer-equivalent curates weekly (§3.4). Accepted proposals land as refinements. Over weeks and months, Canon's principles sharpen, its synthesis skill learns common request shapes, its templates lose dead sections, and its domain skills reflect what actually works.

This is the **unified learning loop**. There isn't one for principles and one for plans — there's one mechanism with many refinement targets.

### 3.1 Why synthesis is load-bearing for this

Static runbooks break the plan-quality arm of this loop. A hand-written `fast-path.md` never learns — whoever wrote it wrote it once. Whatever observations accumulate about how fast-path runs play out have no feedback path into the file.

Synthesized runbooks close that loop. Each run is a data point: planner proposed X, user iterated to Y, execution produced outcome Z. The learner sees the pattern ("planner consistently misses `security` step for auth-touching requests"), proposes a synthesis-skill refinement ("when affected files match auth paths, include `security` by default"), and the next synthesis does better.

Static runbooks serve principle refinement fine — the corpus still captures review findings, fixes, and deviations. But they obstruct plan refinement entirely. Synthesis is what makes Canon learn at the plan layer, not just the principle layer.

### 3.2 Why the learner is the engine

The `canon-learner` agent is the orchestrator of this mechanism. Today it mostly produces principle and convention suggestions. Under v2.1, its role expands modestly: it analyzes the v2.1 scope's five refinement targets (§3.3) and emits proposals. Full expansion to all possible targets is v2.2+ (§3.5).

One agent, multiple query types, multiple output targets. Same learner, richer analyses.

### 3.3 Refinement targets matrix

The surface of Canon artifacts the learning system can refine across the v2.1 + v2.2 horizon. Reduced from an 11-target matrix in earlier drafts per architect review. v2.1 has **5 in-scope targets**, **4 deferred to v2.2+**, and **1 cut entirely**.

**In scope (5 targets):**

| Target | Phase | Location | What gets refined |
|--------|-------|----------|-------------------|
| **Principles** | v2.1b | `principles/*.md` | Scope narrowing, severity promotion/demotion, wording clarifications, new principles from recurring patterns. First refinement target — the only one v2.1b ships. Today's learner already produces principle proposals; v2.1b expands the data feeding them. |
| **Conventions** | v2.2 | `.canon/CONVENTIONS.md` | Established patterns observed across N flows; graduation to principles when warranted. |
| **Runbook synthesis skill** | v2.2 | `skills/canon/references/runbook-synthesis.md` | Default step selection, skill-selection patterns, contract pairings, request-shape recognition. Required for synthesis to learn. |
| **Planning brief skill** | v2.2 | `skills/canon/references/planner-brief.md` | Strategic analysis patterns, open-question framing, value-assessment accuracy. Lower-risk write scope (skill file, not agent prompts). |
| **Templates** | v2.2 | `templates/*.md` | Section utility (drop dead sections), placeholder clarity, structured-tag additions. Lowest blast radius. |

v2.1b ships principle refinement only. The other four become available in v2.2 once v2.1b's loop demonstrably closes (≥ 1 accepted principle-refinement proposal per §15 Gate B / §10.3 v2.1b exit).

**Deferred to v2.2+ (4 targets):**

| Target | Original location | Why deferred |
|--------|------------------|--------------|
| Domain skills | `skills/canon/references/*.md` | Per-skill writes need clearer change-acceptance criteria; defer until in-scope skill-target work has established the pattern. |
| Agent definitions | `agents/*.md` | New write scope (today's learner only writes to `.canon/proposed-learnings/`). Letting the learner edit agent prompts needs its own trust/audit design pass. |
| Agent rules | `rules/*.md` | Same trust scope as agent definitions. |
| Vocabulary | `skills/canon/references/runbook-vocabulary.md` | Meta-circular — the learner proposing changes to the canonical step list it depends on for synthesis is a self-modifying loop needing explicit stability design. |

Agent memory is also deferred (audit/groom → v2.2; seeding → v2.3+). Memory-related writes are a new write scope with serious failure modes (groom-away-critical-knowledge, incorrect consolidation, stale-seed calcification) — deferred until the base learner proves trustworthy on lower-risk targets first.

**Cut entirely (1 target):**

**Knowledge graph priors** (`knowledge-graph.db`) — cut from the learning system's refinement target set. The KG is its own subsystem with its own confidence story (computed from code structure, semantic neighborhoods, file relationships). Automated KG refinement based on flow-corpus statistics is a separate architectural commitment that doesn't belong in this proposal. If automated KG refinement ever becomes desirable, it is a separate Canon system designed against the KG's own data model and confidence semantics.

### 3.4 Learner-loop curation ownership

**A Canon maintainer-equivalent curates weekly.** A human reviewer reads the learner's proposals in `.canon/proposed-learnings/{timestamp}/` once per week, accepts or rejects each, and applies accepted proposals as real edits to the relevant artifact (principle file, skill, template). Rejected proposals are logged with a reason in `.canon/learning.jsonl` and dismissed; the learner reads this log to avoid re-suggesting dismissed items.

- Cadence: weekly (adjustable based on signal volume)
- Review artifact: the existing `.canon/proposed-learnings/{timestamp}/` directory the learner already produces
- Apply mechanism: manual edits by the reviewer (the learner's proposals include structured patches where possible; reviewer applies)
- Dismissal log: `.canon/learning.jsonl` (already exists) records accepted/dismissed decisions

Automation (planner auto-tunes from learner output without human curation) is §11 P5 territory — deferred beyond v2.1 unless the supervised loop proves trustworthy and high-quality for a sustained period first.

### 3.5 Single-target vs. cross-target analyses

Within the 5 in-scope targets, some analyses produce single-target proposals; others correlate across targets:

- **Single-target:** "Principle P's fix-iteration cost is elevated → refine P." Target: principles.
- **Cross-target (v2.2):** observation patterns that suggest connected refinements to the synthesis skill *and* a domain skill, or template *and* a principle. Cross-target proposals are higher-signal but require more analysis surface; defer to v2.2 once v2.1b's single-target loop is demonstrably working.

Cross-target analyses against the deferred targets (agent defs, vocabulary, etc.) wait for those targets' own ratification.

---

## 4. Observation mechanism — hybrid structured tags + prose

The learning system needs observations captured at flow time, stored durably (§8), and queryable cross-run. Two viable approaches existed: everything upfront-structured, or everything post-hoc extracted. Neither is ideal.

**Decision: hybrid.** Specialist agents produce their normal prose artifacts unchanged. They add lightweight **structured tags** in frontmatter for the highest-value signals. The learner reads both — tags are high-confidence signals consumed directly; prose is fallback for richer analysis when needed.

### 4.1 Why hybrid

- **Upfront-only structured:** rigid; heavy authoring burden; schema changes cascade to every agent. Over-engineers the observation layer before we know what's useful.
- **Post-hoc-only extraction:** extraction quality varies; LLM token cost per flow; latency. Spends tokens extracting what agents could have emitted directly.
- **Hybrid:** low authoring burden (small frontmatter additions); high-value signals are structured and direct; prose stays natural for deeper analysis.

### 4.2 First-pass structured tags per artifact

Low-burden additions to existing templates. Agents already produce this information in prose; promoting the most-useful bits to structured fields is cheap.

| Artifact | Structured frontmatter fields |
|----------|------------------------------|
| Planning brief | `confidence_signals[]`, `request_shape_tag`, `alternatives_considered` count |
| Synthesized runbook | `vocabulary_version`; per-step schema in §5.2 |
| Research finding | `dimensions_explored[]`, `risks_surfaced[]`, `confidence_per_dimension{}` |
| Design decision | `decision_id`, `options_considered` count, `chosen_option_tag`, `rationale_tags[]` |
| Task plan | `task_id`, `dependencies[]`, `file_count`, `principle_ids[]` |
| Implementation summary | `compliance_declared_for: [principle_id]`, `justified_deviations: [{principle_id, reason_short}]` (`memory_cited: [item_id]` deferred to v2.2 alongside memory work) |
| Test report | `tests_added` count, `coverage_delta`, `tests_paired_with_principle_ids[]` |
| Review finding | `principle_id` per finding (already in drift-db `violations` table since v1), `severity`, `file_path` |
| Fix summary | `cause`, `root_cause_tag`, `upstream_step_id` |
| HITL event | `event_type`, `posture`, `outcome`, `phase`, `step_id_affected` (often null) |

> **Planning brief note.** v2.1 §7.1 includes an aggregate `confidence: 0.0-1.0` scalar alongside `confidence_signals[]` in the planning brief frontmatter. Per architect review HIGH-2 (see `docs/agent-teams-migration-plan-v2.1-review.md` §4.1), the user-facing aggregate scalar should be dropped in favor of per-signal display only; the aggregate remains as internal planner state and as a lifecycle-DB column for v2.2 calibration. The tag row above reflects that adjustment.

**What's new vs. what already exists** (per v2.1 scope inspection):

- **Review finding `principle_id`** — already exists in drift-db `violations` table (indexed since v1). v2.1b work is *ensuring reviewer consistently populates* the field, not schema addition. May require review-template or reviewer-agent prompt updates.
- **Fix summary `cause` / `root_cause_tag`** — genuinely new. Fix summaries today live as workspace markdown with unstructured prose.
- **Implementation summary `justified_deviations[]`** — genuinely new. Prose today; structured frontmatter in v2.1b.

v2.1b scope (the three highest-value tags) = the two genuinely new ones above plus ensuring `principle_id` is populated. Other tags land in v2.2.

### 4.3 Tag discipline — rules the indexer follows

- **Tags are optional.** Missing fields don't fail ingestion. Indexer tolerates absence within the declared schema; learner treats missing as "no signal from this field" rather than error.
- **Schema is closed** (per §4.6 resolution). Agents emitting fields outside §4.2's list have those fields *dropped* by the indexer; no `extra_tags` JSON catch-all. Schema evolution requires a versioned migration, not per-flow accretion.
- **Prose stays authoritative.** When a tag and prose disagree, prose wins for factual questions; tag wins for aggregate analysis. (The learner flags tag-prose disagreement as a data-quality signal.)
- **Secret / PII scrubbing.** Tag values pass through a basic secret-pattern match before persistence. Free-text short-summary fields are bounded (e.g., 280 chars).

### 4.4 What about richer analysis the tags don't capture?

Prose extraction remains available for the learner when it wants richer context than tags provide. E.g., if the learner detects a pattern in design-decision outcomes but wants to understand *why* architects chose certain options, it reads the `rationale_tags[]` tag first, falls back to scanning the prose body of the decision artifact if the tags aren't sufficient.

This is a small number of LLM calls per week (at learner cadence), not per flow. Avoids the token cost of per-flow extraction while preserving the ability to dig deeper when analysis requires it.

### 4.5 HITL event categorization

The event-type enum is expanded from v2's implicit list of five breakpoint shapes to nine explicit event types plus a phase dimension:

```yaml
event_type: approval | clarification | redirect | reject | abort | iterate | modify | escalate | consult
phase: synthesis | execution | post_execution
```

- **`approval`** — user approves the runbook or a step posture
- **`clarification`** — user provides clarifying info
- **`redirect`** — user redirects to a different approach
- **`reject`** — user rejects the proposal
- **`abort`** — user aborts the flow
- **`iterate`** — user asks for another iteration (synthesis-phase only)
- **`modify`** — user supplies their own content (distinct from redirect; overrides planner output)
- **`escalate`** — user asks for a different specialist
- **`consult`** — user triggers an advisory subagent

Phase distinguishes *when* in the flow lifecycle the event occurred: `synthesis` (during planner-user iteration), `execution` (during runbook execution after approval), `post_execution` (after all steps complete). The same event type can mean different things at different phases. A `redirect` during synthesis is "steer the plan"; a `redirect` during execution is "halt and adjust mid-flow." The analytic signal is `event_type × phase`.

### 4.6 Schema policy — closed for v2.1

The structured-tag schema is closed for v2.1. Fields enumerated in §4.2 are the complete list. Agents that emit fields outside this list have those fields **dropped** by the indexer; nothing is silently captured in a generic `extra_tags` JSON blob.

**Rationale:**

- We don't yet have signal on which extra fields agents would invent. Designing a promotion path before any data exists is premature optimization.
- SQLite JSON queryability is decent but real query performance comes from indexed columns; an open `extra_tags` blob accumulates unstructured data that never gets the column treatment unless explicitly promoted.
- A closed schema forces every additional signal through a deliberate schema-change review, which is a healthy forcing function.

**How to evolve the schema** (when a new field is wanted):

1. Propose a schema change as a versioned migration against `drift-schema.ts`
2. Update the relevant template + agent prompt
3. Migrate existing data if applicable
4. Same review cadence as Canon principle changes

**Future possibility (v2.2+, not in v2.1):** the learner could analyze patterns in agent prose outputs, detect recurring fields agents *would* like to emit, and propose schema additions automatically. This is a natural extension of the learning system but explicitly out of scope for v2.1.

---

## 5. Synthesis architecture — vocabulary, step schema, contract

v2.1 replaces v2's 5 hardcoded runbook files (fast-path, feature, epic, migrate, test-gap) with a vocabulary-based synthesis system. The planner composes a plan-specific runbook from a canonical step vocabulary; the runbook's frontmatter metadata feeds the orchestration journal; the runbook's body prose guides the lead through step-by-step execution.

### 5.1 Vocabulary

The canonical set of step IDs Canon knows. Adding a new ID is a versioned change (like adding a principle — deliberate, reviewed). The vocabulary lives at `skills/canon/references/runbook-vocabulary.md` and is loaded as a skill by any agent that needs to understand runbook structure.

| Step ID | Default agent | Dispatch | Default HITL | Purpose |
|---------|---------------|----------|--------------|---------|
| `research` | canon-researcher | subagent | none | Investigation — any scope (codebase, risks, coverage gaps, migration scope, drift). |
| `design` | canon-architect | subagent | approval | Plan index + design decisions. |
| `spike` | canon-engineer | subagent | none | Time-boxed exploratory prototype; produces findings, not shipped code. |
| `implement` | canon-engineer | subagent or team | none | Build code with TDD/BDD. `team` when wave-parallel. |
| `migrate` | canon-engineer | subagent | none | Schema/data migration execution (pairs with rollback artifact). |
| `verify` | canon-engineer | subagent | on_failure | Run existing tests / gates post-change. |
| `test` | canon-tester | subagent | none | Net-new integration tests; coverage-gap fills. |
| `benchmark` | canon-tester | subagent | on_failure | Performance verification against baseline. |
| `security` | canon-security | subagent | none | Security assessment. |
| `review` | canon-reviewer | subagent | checkpoint | Principle compliance. |
| `fix` | canon-engineer | subagent | on_failure | Fix mode. Required: `cause: test-failure \| security \| review \| verify`. |
| `pre-launch-check` | null | n/a | on_failure | Gate-only — lead runs discovered checks via Bash. |
| `ship` | canon-shipper | subagent | on_failure | PR description synthesis. |
| `context-sync` | canon-scribe | subagent | none | Doc sync — **mandatory tail**. |
| `learn` | canon-learner | subagent | none | Pattern analysis — **mandatory tail**. |

Total: **15 entries** (13 functional + 2 mandatory tail).

**Vocabulary evolution discipline (semver-style):**

- **Minor versions are additive only.** New step IDs, new default values, new optional fields. Existing runbooks remain valid.
- **Major versions may remove or rename entries**, but only after a deprecation cycle.
- **Deprecation cycle:** at least one minor version where the entry is marked deprecated (still functional but emits a deprecation notice). Removal happens in the next major version.

**Resume behavior across vocab versions:** locked-runbook resumes continue with the synthesis-time vocab unless a referenced entry was removed in a later major version. If removed, the planner regenerates the runbook with full workspace context (original brief + prior approved runbook + steps executed + artifacts produced + HITL events from prior session), presented for re-approval. Most vocab evolution is additive → no regen triggered.

> **Review note (MEDIUM-4).** The state-transition graph for regen-rejected outcomes is under-specified in v2.1. Before v2.1a ships, decide whether deprecated-vocab continuation is permitted or the flow must abort on regen rejection. See `docs/agent-teams-migration-plan-v2.1-review.md` §4.2 MEDIUM-4.

### 5.2 Step schema — first-class fields

Every step in a synthesized runbook carries structural fields defined by the synthesis skill (`skills/canon/references/runbook-synthesis.md`, v2.1a), plus three domain-oriented axes:

**`skills:` — what domain expertise to load.** General-purpose: any step can declare domain primers to load from `skills/canon/references/`. Agents read named skills on their first turn via `agent-context-check`.

```yaml
- id: implement
  agent: canon-engineer
  dispatch: team
  skills:
    - backend-api
    - authentication-security
  mcp_tools: [get_principles, get_file_context]
  artifacts: ["plans/${slug}/${task_id}-SUMMARY.md"]
  hitl: none
```

Validation: **strict**. The planner validates every `skills:` name against the file list in `skills/canon/references/` at synthesis time. Unresolvable names are a synthesis error.

**`cause:` — analytic lineage + skill hint (fix-specific).** Used on `fix` (and potentially future re-work steps). Carries two signals:

1. Analytic: which upstream step triggered this fix (for outcome correlation).
2. Skill hint: a default primer the planner auto-adds to `skills:` (e.g., `cause: review` → `review-feedback-handling`).

**`mode:` — deferred.** The `mode` field for step behavioral variants (e.g., `implement` in refactor mode vs. fresh mode) is deferred. Real variants today are handled via synthesis rules in `runbook-synthesis.md`. Promote `mode:` to a first-class field in a future vocabulary revision if synthesis rules proliferate beyond 3–4 variants.

### 5.3 Synthesis contract

Rules the planner (via `runbook-synthesis.md` skill) MUST follow when emitting a runbook.

**Planner MUST:**

1. **Include mandatory tail.** Every build runbook ends with `context-sync` followed by `learn`.
2. **Use canonical step IDs only.** Any step ID not in `runbook-vocabulary.md` is a synthesis error.
3. **Preserve default agent / dispatch / HITL** unless overriding with explicit justification in the brief body.
4. **Validate `skills:` names strictly** against `skills/canon/references/` at synthesis time.
5. **Use `${slug}` / `${task_id}` / `${timestamp}` placeholders** per the runbook format spec.
6. **Include a one-paragraph Overview** explaining why this step sequence was chosen.
7. **Emit body H3 prose per step** with intent, skip-when elaboration, and coordination notes. Rules live in the synthesis skill itself (`skills/canon/references/runbook-synthesis.md`).
8. **Apply contract pairings** from synthesis rules:
   - Behavior-preserving `implement` → mandatory-following `verify` with "no behavior changes" criterion
   - `migrate` → paired rollback artifact
   - `security` findings → at least one `fix` step with `cause: security` before `ship`
   - `review` verdict not clean → `fix` with `cause: review` loop until clean

**Planner MAY:**

- Reorder steps (`security` before `review` for auth-sensitive changes)
- Skip optional steps (`design` for scoped fixes; `test` for doc-only changes)
- Repeat steps (two `review` passes for risky migrations; multiple `fix` cycles)
- Expand a single step into multiple waves

**Planner MUST NOT:**

- Invent new step IDs. Adding a vocabulary entry is a deliberate versioned change, not a per-run decision.
- Remove baseline HITL from step defaults. The runbook's declared `hitl:` posture stays regardless of confidence signal.
- Skip mandatory tail regardless of flow size or user preference.

### 5.4 Iteration, not one-shot

The contract applies across the full planner-user iteration loop. Each iteration re-spawns the planner with full workspace context; intermediate iterations are persisted as separate rows in `lifecycle_synthesized_runbooks` (v2.2; the v2.1b schema persists the `stage: approved` row to `lifecycle_workspace_snapshots.approved_runbook_id` only). Only the `stage: approved` row is executed against.

### 5.5 Single-point-of-failure mitigation (review MEDIUM-2)

v2 had 5 hand-authored runbook files; a bug in any one was localized. v2.1 concentrates runbook behavior into 1 vocabulary + 2 skills, so a synthesis-skill regression propagates to every flow type simultaneously. Two complementary mitigations apply:

- **Synthesis regression suite.** Maintain 5–10 canonical test requests (bug fix, small feature, migration, refactor, etc.) with expected runbook shapes. Re-run on every synthesis-skill change; block the change if the suite diverges without explicit justification.
- **Weekly curation for synthesis-skill changes.** Per §3.4, synthesis-skill refinement proposals flow through the weekly curator review cadence. Human sign-off precedes any synthesis-skill edit that lands. This is the same path principle refinements follow.

See `docs/agent-teams-migration-plan-v2.1-review.md` §4.2 MEDIUM-2 for the full discussion.

---

## 6. User-approval affordance

Under the iterate-until-approved model, the user is always the approval gate. This section defines what approval looks like at the runtime / MCP level.

### 6.1 Mechanism: conversational

The lead interprets user messages for approval signals. The user never invokes a slash command or MCP tool directly; from their perspective, approval is natural — "looks good," "yes go," "approved," "let's proceed" all signal approval. Ambiguous cases ("looks good, but change X first" / "mostly yes") are clarification events, not approval events; the lead asks explicitly rather than auto-approving.

**Internal journal record:** when the lead infers approval, it records the approved stage via the journal MCP tool (creating a `lifecycle_synthesized_runbooks` row with `stage: approved` in v2.2; v2.1b records the approval via `lifecycle_workspace_snapshots.approved_runbook_id`). The approval record is internal bookkeeping, not a user-facing mechanism.

**Ambiguity handling:** if the user's message is ambiguous or partial, the lead asks rather than proceeds. Example: *"Approving the full runbook? Step `design` shows low confidence — proceed with it as-specified, or dig into the open questions first?"* No auto-approve on ambiguity.

### 6.2 Lightweight proposals for trivial work

The planner calibrates proposal *depth* to request complexity:

- Trivial bug fix → 1-step runbook (just `implement`), one-line overview, approval clears in seconds with "go"
- Small feature → 3–4 step runbook, brief overview, user skims in seconds
- Complex epic → multi-wave runbook, full overview, iteration may take multiple rounds

This replaces v2's autodispatched fast-path (no gate, no visibility) with a **thin-gate-no-skip** pattern: every request goes through the planner, but trivial work produces a trivial plan that clears in seconds. Arguably *more efficient* than the original fast-path because the user has visibility and the journal has a record, at minimal latency cost.

The planner does NOT fall back to a "skip approval when confidence ≥ threshold" mechanism. Decision: iterate-until-approved stands. Friction is addressed by making the proposal light, not by skipping the gate.

### 6.3 Friction acknowledgment

Every build request now has a synchronous planner round-trip — this is a material change from v2's autodispatched fast-path. Mitigation is the lightweight-proposal principle above. The architect review flags cold-start tolerability as the residual risk; the recommended mitigation is a pre-ship spike plus Phase 2 measurement of cold-start and steady-state latency separately.

> **Review note (MEDIUM-6).** Before v2.1a ships, spike trivial-request iteration-0 latency against 3 representative requests. In Phase 2, measure cold-start (fresh memory, empty corpus) and steady-state (after ≥ 20 flows of the same shape) separately. The red flag is absence-of-improvement across flows, not absolute latency — self-healing via memory and corpus anchoring is the design bet. See `docs/agent-teams-migration-plan-v2.1-review.md` §4.2 MEDIUM-6.

### 6.4 Intent re-classification discipline (L1)

**Intent is classified per user message, not per session.** Every user message re-classifies; chat/question sessions that pivot to a build request route the pivot message through planner. Don't let conversational continuity carry forward across intent-class boundaries.

CLAUDE.md instruction (soft enforcement):

> Re-classify every user message. If the current message is a build request, route to planner regardless of prior conversation flow. Chat/question history doesn't make subsequent builds "chat."

### 6.5 Pre-write gate + Canon-bypass detection (L4)

Before the lead uses `Edit`, `Write`, or `Bash` for code changes:

> **Verify Canon routing.** Ask: "Is this request currently routed through a Canon build flow (planner + approved runbook)?" If no, stop. Present the build request to the user and route through planner. Editing code outside a Canon flow is the failure mode this rule prevents.

L1 is soft (prompt discipline). L4 is the hard backstop: a PreToolUse hook `canon-workspace-check.sh` that blocks `Edit` / `Write` / `Bash`-that-modifies-code when no active Canon workspace exists for the current flow.

Defense in depth: L1 is the soft path (Claude usually does the right thing); L4 is the hard floor (if Claude fails to re-classify, the hook catches it before uncontrolled code modification).

> **Review note (HIGH-1).** L4's predicate must be principled before shipping. Resolution framing per the architect review: **the allowlist is `.gitignore`**. Any change to a tracked file belongs in a Canon flow (branch + PR); anything gitignored is out-of-scope for L4 by construction. `git check-ignore` is the oracle. "Bash-that-modifies-code" becomes the concrete predicate "Bash invocations whose resolved target paths include any tracked file."
>
> This framing resolves the blast-radius concern but exposes an architectural requirement v2.1 does not yet address: **not all Canon intents currently create workspaces.** CLAUDE.md routes `build` / `explore` / `test` / `review` / `security` through `load_flow` + `init_workspace`, but `principle` (canon-writer), `learn` (canon-learner), and any future `docs` intent edit tracked files without creating workspaces. Under the tracked-files-in-Canon-flow framing, each of those intents needs a workspace-creating path (a dedicated lightweight flow or a shared "content" flow pattern). L4 cannot ship before this intent-routing expansion is specified; otherwise L4 blocks legitimate canon-writer and canon-learner runs.
>
> See `docs/agent-teams-migration-plan-v2.1-review.md` §4.1 HIGH-1 for the full resolution path (four pre-ship items).

### 6.6 Iteration persistence

All iterations are persisted (in v2.2 schema), but only the `stage: approved` row is executed against.

- Each iteration gets one row in `lifecycle_synthesized_runbooks` (`stage: proposed` for intermediates; `stage: approved` for the final version; `stage: regenerated` per §5.1 if vocab version changed mid-flow)
- `iteration_index` tracks ordinality within a flow (0 = first proposal, N = approved final)
- `lifecycle_workspace_snapshots.approved_runbook_id` points to the single `stage: approved` row per workspace
- Intermediate iterations are available to the learner for calibration analyses (planner-quality trends, iteration-pattern detection, confidence-vs-iteration-count correlation) but never executed against

**v2.1b persistence scope:** v2.1b ships `lifecycle_workspace_snapshots` with `approved_runbook_id` only (intermediate iterations not yet persisted as their own rows; the approved runbook is the v2.1b lifecycle-DB record). Full iteration tracking in `lifecycle_synthesized_runbooks` is v2.2 scope per §8.

---

## 7. Confidence scoring

Confidence is a **surfaced signal during iteration**, not a gating mechanism. Under the iterate-until-approved planner loop, the user is always the approval gate; confidence informs the user during iteration, doesn't decide for them.

### 7.1 Schema (v2.1-review adjusted)

v2.1 §7.1 originally specified a user-facing aggregate `confidence: 0.0-1.0` scalar alongside per-signal scores. Per architect review HIGH-2 (see `docs/agent-teams-migration-plan-v2.1-review.md` §4.1), the user-facing aggregate is dropped in favor of per-signal display only. The aggregate still computes internally and persists to the lifecycle DB for v2.2 calibration.

**User-facing** in the synthesized runbook frontmatter:

```yaml
confidence_signals:
  - {signal: "novelty",           value: 0.7}
  - {signal: "scope_clarity",     value: 0.9}
  - {signal: "domain_coverage",   value: 0.8}
  - {signal: "dependency_drift",  value: 0.6}
  - {signal: "question_count",    value: 0.85}
```

**Internal (not user-facing):** a planner-computed aggregate scalar that persists to `lifecycle_workspace_snapshots` (v2.1b) for outcome correlation. Used by the learner for v2.2 calibration analyses. Never displayed to the user in v2.1a/b.

**Rationale.** Three of the five signals (`novelty` in v2.1a, `scope_clarity`, `question_count`) are LLM self-assessment — the planner grading its own work. An aggregate rolling these up inherits overconfidence skew. Per-signal scores have concrete referents ("scope_clarity: 0.3" points at something the user can clarify); the holistic scalar is a vibe-check that invites misuse. Dropping the user-facing aggregate preserves the "surface uncertainty" UX via per-signal display while avoiding the uncalibrated-scalar problem.

### 7.2 Signals

| Signal | Meaning | How computed |
|--------|---------|--------------|
| `novelty` | Has Canon built something like this before? | Planner's `memory: project` in v2.1a; `query_workspace_history({ similar_to: brief_summary })` in v2.2 |
| `scope_clarity` | Does the request have concrete acceptance criteria? | Planner analysis of brief; fewer open questions ⇒ higher |
| `domain_coverage` | Are relevant domain primers available? | Ratio of affected file-layers with ≥ 1 matching primer in `skills/canon/references/` |
| `dependency_drift` | How much has changed in target files since related work? | `get_drift_report` + recent commit density |
| `question_count` | Open questions remaining in the brief? | Inverse of count, clamped |

Overall internal aggregate combines signals with equal weighting initially. As lifecycle data accumulates, the learner proposes weight refinements based on observed correlation between each signal and flow outcome.

### 7.3 HITL invariant — confidence is advisory, not a modifier

Confidence is surfaced to the user during iteration (per-signal display). It does NOT modify the runbook's HITL postures — neither at synthesis time nor at runtime.

- If a step declares `hitl: approval`, that stays approval. No confidence level allows skipping it.
- If a step declares `hitl: none`, that stays none. Low confidence does NOT auto-insert a checkpoint.
- The synthesis skill picks HITL postures from step-type defaults (per the vocabulary in §5.1); confidence is not an input to that choice.

**What confidence IS for:**

- Surfacing uncertainty to the user via per-signal display ("scope_clarity is 0.3 — let's tighten the acceptance criteria")
- Informing the user's decision to iterate more before approving
- Feeding the learner for calibration analyses (§7.5)

**What confidence is NOT for:**

- Modifying the runbook's HITL postures (at synthesis or runtime)
- Bypassing user approval for high-confidence proposals
- Auto-adding checkpoints — that's the user's judgment during iteration, not a synthesis rule
- A user-facing holistic vibe-check (per §7.1 review adjustment)

The user — not confidence — decides how much iteration is warranted before approval.

### 7.4 Overconfidence mitigation

LLMs systematically skew toward overconfidence. Without explicit mitigations, the planner will emit 0.9+ on most requests and the signal becomes noise. Mitigations are required from day one of v2.1a; some extend into v2.2.

| # | Mitigation | Scope | Mechanism |
|---|-----------|-------|-----------|
| 1 | **Signal decomposition is primary** | v2.1a | Per-signal scores are what the user sees. Forces the planner to articulate per-signal uncertainty rather than a vibe check. (Reinforced by §7.1 review adjustment — aggregate dropped from user-facing schema.) |
| 2 | **Articulate the unknowns** | v2.1a | Before emitting signals, the planner must list what information WOULD raise confidence if available. If it can't list anything, internal aggregate caps at 0.75 regardless of per-signal scores. |
| 3 | **Cold-start defaults low** | v2.1a / v2.1b | `novelty` starts near 0 when no corpus match; `domain_coverage` low when no matching primers. Internal aggregate starts low and climbs as evidence accumulates. |
| 4 | **Corpus anchoring** | v2.2 | Planner calls `query_workspace_history({ similar_to: brief_summary })` to compare against prior flows. No close matches → `novelty` and `domain_coverage` both pushed down. |
| 5 | **Conservative prompt guidance** | v2.1a | Explicit in `runbook-synthesis.md`: *"Under-confidence is safer than over-confidence. Surface uncertainty; don't hide it."* |
| 6 | **Learner calibration detection** | v2.2 | Learner tracks per-signal-vs-outcome correlation (more actionable than aggregate correlation). Uniform overconfidence on any signal is a detectable pattern. Learner proposes dampening adjustments. |

**Acknowledged residual risk:** even with all six mitigations, confidence emitted by an LLM is inherently suspect. v2.1a/b ships with unvalidated calibration. Internal aggregate is used for lifecycle-DB storage only; user sees per-signal scores.

This is acceptable because (a) confidence is advisory (§7.3), not a gating mechanism, and (b) per-signal scores are more verifiable than an aggregate. Miscalibration during v2.1a/b doesn't break anything critical, and per-signal data accrues cleanly from day one for v2.2 calibration.

### 7.5 Rescoring across iterations (v2.1a scope)

Under iterate-until-approved (§6), the runbook may go through N rounds before the user approves it. Per-signal scores are **re-evaluated at each iteration, not emitted once at the initial proposal**.

- Each `stage: proposed` row in `lifecycle_synthesized_runbooks` (v2.2) records its own per-signal scores and internal aggregate
- v2.1b records per-signal scores on the approved runbook only (via `lifecycle_workspace_snapshots.approved_runbook_id` → runbook frontmatter)
- `iteration_index` (v2.2) preserves the trajectory (iteration 0: 0.62 internal aggregate; iteration 1: 0.78 after user clarifications; …; `stage: approved`: 0.88)
- Rescoring happens at the start of each planner response during iteration

**Why per-iteration:**

- Later scores inform subsequent decisions; trajectory is itself a learner signal
- Without per-iteration rescoring, initial overconfidence compounds — the user never sees the planner revise per-signal scores downward as complications surface

Storage cost: negligible. Per-signal scores + internal aggregate fit in the existing lifecycle schema; no additional schema change beyond §8.1.

---

## 8. Lifecycle persistence substrate

Everything in §§3–7 depends on one piece of infrastructure: a durable, queryable record of what happened in each flow that survives workspace cleanup. Workspaces under `.canon/workspaces/<id>/` are ephemeral by design — they're scratch, not record. Without repo-level persistence, observations are lost and the learning loop can't close.

### 8.1 Storage decision — v2.1b minimum; full schema deferred to v2.2

**v2.1b ships ONE new table** (`lifecycle_workspace_snapshots`) extending `.canon/drift-db.sqlite`, with per-run snapshot at flow completion. **The full schema (additional tables) defers to v2.2.**

Rationale: drift analytics and lifecycle persistence share the same underlying concern (time-series record of execution). Existing infrastructure already handles schema migrations and the query layer. Adding one table for v2.1b is trivially small; postponing the full schema to v2.2 avoids over-committing before real data demonstrates which tables are needed.

**Concrete v2.1b migration** (against `mcp-server/src/platform/storage/drift/drift-schema.ts`):

```sql
-- v2.1b migration: add lifecycle_workspace_snapshots
CREATE TABLE lifecycle_workspace_snapshots (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  approved_runbook_id INTEGER,          -- NULL in v2.1b (lifecycle_synthesized_runbooks not yet created)
  outcome TEXT NOT NULL,                 -- 'complete' | 'aborted' | 'abandoned'
  total_iterations_to_approve INTEGER,
  total_steps_executed INTEGER,
  total_steps_skipped INTEGER,
  total_hitl_events INTEGER,
  total_deviations INTEGER,
  flow_duration_ms INTEGER,
  commit_range_first TEXT,
  commit_range_last TEXT,
  snapshotted_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_lifecycle_workspace_snapshots_slug
  ON lifecycle_workspace_snapshots(slug);
CREATE INDEX idx_lifecycle_workspace_snapshots_snapshotted_at
  ON lifecycle_workspace_snapshots(snapshotted_at);
```

Drift-db already has a migration runner. Adding this table is ~20 lines of schema DDL + a migration version bump. Reversible — `DROP TABLE lifecycle_workspace_snapshots` if rollback is required.

### 8.2 Persistence boundary — per-run snapshot

Workspace files are the source of truth *while a flow is running*. At flow completion, `snapshot_workspace({ workspace_id })` reads the workspace and materializes a structured lifecycle record.

- `completion-verify.sh` hook is the natural trigger — verify, snapshot, then the workspace can be safely cleaned up
- Janitor processes also call `snapshot_workspace` before deleting abandoned workspaces, preserving partial state

In-progress flows are queried from the workspace, not the DB. Real-time dashboards and mid-run interventions are out of scope for v2.1 (see §14; flagged in the architect review as MEDIUM-5 — document the decision explicitly rather than leaving it implicit).

### 8.3 New MCP tools

**`snapshot_workspace({ workspace_id }) → { snapshot_id }`** (v2.1b — ships first)

v2.1b scope: writes a row to `lifecycle_workspace_snapshots` only. Does not populate additional tables (they don't exist in v2.1b). Return shape is minimal.

v2.2 scope (when other tables exist): expanded to return `{ snapshot_id, runbook_id, deviations_detected }` and write to all `lifecycle_*` tables.

Triggered by:

- `completion-verify.sh` hook after successful flow completion (primary)
- Janitor / cleanup processes before deleting an abandoned workspace

Idempotent — re-running against the same workspace updates the existing snapshot.

**`query_workspace_history({ filters, projection }) → rows`** (v2.2 — deferred)

Structured query interface for the learner and human introspection. Deferred to v2.2 because most useful filters require the `lifecycle_*` tables that v2.2 adds. For v2.1b's single-analysis scope (principle refinement), the learner queries `lifecycle_workspace_snapshots` + existing drift-store review-finding tables directly.

### 8.4 Why drift-db extension (not a separate DB, not JSONL-first)

- **Drift analytics and lifecycle persistence share the same concern** (time-series record of execution).
- **Existing migration infrastructure handles the one-table addition for free.** A new DB would need its own migration story for zero real benefit at this scope.
- **JOINs with existing `FlowRunEntry` are natural** — same `workspace_id` key.
- **For one table with ~one row per workspace completion**, JSONL-first's main appeal (write-path simplicity) doesn't pay for itself — the write volume is trivial. The structured-read need is real from day one: the learner's principle-refinement analysis needs to JOIN against `drift_store.violations` (see §15 Gate B), filter by `workspace_id` / `principle_id` / `timestamp`. That's a native SQLite operation against a small table.

### 8.5 Why v2.2 legitimately revisits this decision

When v2.2's schema expands to ~5 tables with higher-volume rows (step executions per flow, HITL events per iteration), the calculus changes. JSONL-first becomes a real design choice at that scope:

- Write volume grows — step_executions and hitl_events could produce 10–50 rows per flow
- Existing Canon JSONL patterns (`.canon/learning.jsonl`, `.canon/flow-runs.jsonl`) suggest append-log is Canon's native pattern for event streams
- Materialization via a `refresh_lifecycle_index` MCP tool (Kappa-style — raw events append to JSONL, structured tables built lazily) becomes a legitimate alternative

**v2.2 decision is explicitly deferred.** Rather than designing the full schema now and pre-committing to drift-db for all of it, v2.2 chooses between:

- Direct drift-db extension (five more tables)
- JSONL-first with SQLite materialization (Kappa pattern)
- Hybrid — critical path in drift-db; high-volume events in JSONL

The choice depends on observed data volume and query patterns from v2.1b's deployment. v2.2's scope expansion proposal will include a concrete storage-decision ADR informed by that real data.

### 8.6 Retention policy

Tiered default for v2.2 (v2.1b's one table has no meaningful retention policy yet):

- Most recent 100 snapshots — full detail across all `lifecycle_*` tables
- 100 to 1 year old — aggregate; keep `lifecycle_workspace_snapshots` + top-level rows; drop per-row detail
- &gt; 1 year — drop entirely, or export to `.canon/archive/`

Janitor process runs retention (SessionStart hook or scheduled). Settings in `.canon/retention.toml` (new) or extended Canon config.

### 8.7 Privacy and sharing

Lifecycle data includes condensed records of user requests and interventions. Safe defaults:

- **No verbatim user input in DB.** Summary fields are auto-generated, bounded (280 chars). Full brief lives in workspace markdown, referenced by path not content.
- **Secret-detection pass** — summary generation runs a basic pattern match (API keys, tokens) before persisting; matches elided.
- **Local-only by default.** `.canon/drift-db.sqlite` is gitignored; lifecycle tables inherit.
- **Team sharing is out of scope for v2.1.** If/when Canon grows team features, a separate "shared" DB handles cross-machine sync.

---

## 9. Integration Disposition Table

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

## 10. Phase Boundaries

> **⚠️ HARD PRECONDITION (Gate A): v2 Phase 1 exit criteria must be met before any v2.1 work begins.** `canon-planner` and `canon-engineer` agent definitions must exist (currently they don't — only `canon-implementor` and `canon-fixer` exist), must register with the Canon MCP server, and must be validated in ≥ 3 successful runs under `CANON_AGENT_TEAMS_MODE=on`. This is not a soft guideline. Without these agents, v2.1 has nothing to build on. See §15 Gate A.

The migration runs in five sequential steps plus a deletion phase:

- **v2 Phase 1** (§10.1) — orchestration guidance: journal, hooks, agent def updates, skills registration. Additive-only. Completes before any v2.1 work starts.
- **v2.1a** (§10.2) — vocabulary + synthesis skills + canon-planner rewrite + L1 (CLAUDE.md re-classification) + L4 (canon-workspace-check hook). Ships synthesis over static runbooks.
- **v2.1b** (§10.3) — minimum viable lifecycle persistence: one table + one MCP tool + three structured tags + one learner analysis dimension. Proves the learning loop closes end-to-end.
- **v2.2** (§10.4) — surface expansion contingent on v2.1b evidence.
- **Phase 2** (§10.5) — validation, extended from v2 with synthesis-specific and learning-specific deliverables.
- **Phase 3** (§10.6) — deletion, unchanged from v2.

### 10.1 v2 Phase 1 — Orchestration Guidance (additions only)

**Goal:** Give Claude everything it needs to orchestrate Canon flows natively, without touching the legacy code path.

**Preconditions:** None. Can start immediately.

**Key deliverables** (v2's static runbook authoring rows removed — runbook format is now defined by the synthesis skill shipped in v2.1a, not a Phase 1 deliverable):

| Deliverable | Path | Purpose |
|------------|------|---------|
| Orchestration CLAUDE.md (initial version) | `CLAUDE.md` (update) | Orchestration discipline: how the lead composes context via MCP tools, when to use subagents vs agent teams, HITL patterns, post-step effects, completion checklist. v2.1a will amend this further — see §10.2. |
| Runbook format | Defined by the synthesis skill (v2.1a deliverable, not v2 Phase 1) | No separate template or standing format doc. Single source of truth is the synthesis skill. v2's `phase1-00` (which produced `templates/runbook-template.md` + `skills/canon/runbooks/README.md`) is ABANDONED in v2.1 — those artifacts were deleted to avoid drift with the synthesis skill that v2.1a writes. |
| Agent def updates | `agents/*.md` | Add `maxTurns`, `permissionMode`, `skills` frontmatter. **Create `canon-engineer` and `canon-planner` via `phase1-08`.** Remove `canon-implementor`, `canon-fixer`, `canon-guide`, `canon-chat`. |
| Orchestration journal tool | `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` | `log_step` and `verify_completion` MCP tools. See §2.9 for the v2.1-extended signature. |
| Commit trailer hook | `hooks/canon-agent-teams/post-commit-trailers.sh` | PostCommit hook validating Canon-Workflow trailer presence. |
| Completion verification hook | `hooks/canon-agent-teams/completion-verify.sh` | Calls `verify_completion` journal tool. Blocks "done" if steps or artifacts missing. (v2.1b extends to call `snapshot_workspace` after verify clears.) |
| SessionStart doc-check hook | `hooks/canon-agent-teams/session-start-doc-check.sh` | Compares HEAD against `.canon/last-scribe-commit`. Nudges lead if documentation may be stale. |
| SessionStart KG-check hook | `hooks/canon-agent-teams/session-start-kg-check.sh` | Checks `knowledge-graph.db` freshness. |
| SubagentStop scribe-queue hook | `hooks/canon-agent-teams/post-engineer-scribe.sh` | After `canon-engineer` completes, writes `pending-scribe.json` to workspace. Lead runs scribe before completing flow. |
| Feature flag | Environment variable `CANON_AGENT_TEAMS_MODE` | `off` (default): legacy `drive_flow` path unchanged. `on`: Claude orchestrates natively. |

**Important clarification:** v2's `phase1-01..04` (the 5 static runbook authoring tasks) are abandoned, but **`phase1-05` through `phase1-10` remain required v2 Phase 1 deliverables**. `phase1-08` in particular is the agent-creation work that v2.1 depends on (Gate A). v2.1 builds *on top of* v2 Phase 1; it does not replace it.

**Exit criteria (Gate A):**

- `canon-planner` and `canon-engineer` agent definitions exist and register with the Canon MCP server
- Both validated in ≥ 3 successful runs under `CANON_AGENT_TEAMS_MODE=on`
- CLAUDE.md has orchestration section matching §2 (MCP tool composition, dispatch framework, HITL patterns, completion checklist); v2.1a will amend further per §10.2
- All 5 hook scripts exist, are executable, and register in `hooks/canon-agent-teams/hooks.json`
- Skill preloading validated for at least 3 agent types (spawned agents reference preloaded rules without extra Read tool calls — confirm via transcript inspection)
- `npm run build` and `npm test` pass

**MUST NOT touch:**

- Any file under `mcp-server/src/features/orchestration/`
- Any file under `mcp-server/src/features/prompt-pipeline/`
- Any flow YAML under `flows/`
- Any existing MCP tool implementation

### 10.2 v2.1a — Vocabulary + synthesis (no substrate)

**Entry gate:** Gate A (§10.1 exit criteria met).

**Scope:**

- §5 Vocabulary — 15 canonical step IDs in `skills/canon/references/runbook-vocabulary.md`
- §5 Step schema — `skills:`, `cause:` first-class fields
- §5.3 Synthesis contract — MUST / MAY / MUST NOT rules; iterate-until-approved loop
- `skills/canon/references/planner-brief.md` + `skills/canon/references/runbook-synthesis.md` — two skills the planner loads
- `canon-planner` agent body updated: loads both skills, emits `planning-brief.md` + `runbook.md`, runs the iterate-until-approved loop
- **CLAUDE.md intent-classification amendment (L1)** — per-message re-classification discipline + pre-write gate (§6.4, §6.5)
- **New PreToolUse hook `canon-workspace-check.sh` (L4)** — blocks code-modification tools when no active Canon workspace exists for the current flow. Registered in `hooks/canon-agent-teams/hooks.json`

> **Implementation gate.** Before L4 ships, resolve the architect-review HIGH-1 items: (1) make the allowlist `.gitignore`-based with `git check-ignore` as the oracle; (2) expand intent routing so `principle` / `learn` / any future `docs` intent also route through workspace-creating paths; (3) assert the bootstrap contract so L4 cannot race `init_workspace`. See `docs/agent-teams-migration-plan-v2.1-review.md` §4.1 HIGH-1.

**Explicitly out of scope for v2.1a:**

- No lifecycle persistence (no new tables, no MCP tools beyond what v2 Phase 1 provides)
- No learner role expansion
- No commit trailer family additions
- No structured observation tags on artifacts
- No memory audit/groom/seed
- No embeddings or semantic search

**Exit criteria:**

- `canon-planner` synthesizes runbooks per the rules in `skills/canon/references/runbook-synthesis.md` and passes iterate-until-approved
- At least 5 distinct request types processed end-to-end (bug fix, small feature, refactor, migration, test-gap equivalent)
- L1 + L4 shipped; observed in action against intent-misclassification scenarios
- Runbooks execute per the contract; same artifact quality as pre-synthesis static flows
- **Cold-start friction spike passes** (per review MEDIUM-6): 3 trivial requests (typo fix, small rename, one-line config change) have iteration-0 latency within the documented target

### 10.3 v2.1b — Minimum viable lifecycle persistence

**Entry gate:** v2.1a has shipped and produced ≥ 20 synthesized runbooks in real use.

**Scope:**

- One new table: `lifecycle_workspace_snapshots` (per §8.1 SQL DDL)
- One new MCP tool: `snapshot_workspace({ workspace_id })` — called by `completion-verify.sh` at flow completion
- Three structured tag additions:
  - Review findings: ensure `principle_id` is consistently populated (already in drift-db schema since v1)
  - Fix summary: add `cause`, `root_cause_tag` (genuinely new; prose-to-frontmatter)
  - Implementation summary: add `justified_deviations[]` (genuinely new)
- Extend existing `canon-learner` with one new analysis dimension: principle-refinement from per-flow review data (§3.1 illustrative query → pattern → proposal)

**Explicitly out of scope for v2.1b:**

- No embeddings / semantic search
- No commit trailer family
- No design-decision, research-finding, or test-report tags
- No memory audit/groom/seed; no `memory_cited` tag
- No cross-target analyses
- No weekly digest format (proposals go to `.canon/proposed-learnings/{timestamp}/`; human curator reads weekly per §3.4)
- No retention-tier policy
- No additional learner output dimensions beyond principle refinement

**Exit criteria (Gate B, defined in §15.2):**

- ≥ 1 concrete principle-refinement proposal produced by the learner against real lifecycle data
- Proposal accepted by a human reviewer and applied as an actual edit to a principle file
- End-to-end loop closed: observation → pattern → proposal → accepted refinement
- Schema migration against `drift-schema.ts` executes cleanly and is reversible
- `snapshot_workspace` handles failure cases (workspace already torn down, partial state, etc.)

### 10.4 v2.2 — Surface expansion

**Entry gate:** v2.1b has shipped ≥ 3 principle-refinement proposals, of which ≥ 1 has been accepted and applied.

> **Review note (MEDIUM-1).** The entry gate as specified counts proposals and acceptances but does not measure whether accepted refinements improved anything. Before shipping v2.2, add a qualitative criterion: "the accepted proposal produces a measurable reduction in the corresponding principle's violation rate over the next N flows after application, OR a human reviewer explicitly signs off that the refinement improved principle clarity." See `docs/agent-teams-migration-plan-v2.1-review.md` §4.2 MEDIUM-1.

**Scope (all contingent on v2.1b success):**

- Additional structured tags (design decision, task plan, research finding, test report, HITL events)
- Additional lifecycle tables (`lifecycle_synthesized_runbooks` with iteration tracking, `lifecycle_step_executions`, `lifecycle_hitl_events`, `lifecycle_runbook_deviations`)
- Embeddings + `similar_to` semantic search
- Memory citation tag + audit/groom analyses (memory seeding stays v2.3+)
- Cross-target correlation analyses (bounded per review LOW-3)
- Weekly learning digest format
- Tiered retention policy — only once storage data warrants it
- Storage decision re-examined at this scope (drift-db extension vs. JSONL-first vs. hybrid) per §8.5
- Confidence calibration: with paired outcome data, v2.2 may introduce confidence-driven gating or surface the aggregate scalar; gate eligibility must honor the deterministic/observable-signal rule (see review §4.1 HIGH-2 discussion)

**Explicitly out of scope for v2.2:**

- Memory seeding for new agents (v2.3+ at earliest)
- Agent-prompt refinement targets in §3.3 deferred matrix
- Agent-rule refinement targets in §3.3 deferred matrix
- Vocabulary meta-refinement
- Knowledge graph priors (cut entirely per §3.3)

**Exit criteria:** per-expansion — each new refinement target added under v2.2 must demonstrate a completed observation → refinement cycle before the next target is enabled.

### 10.5 Phase 2 — Validation (no deletions)

**Goal:** Prove that Claude-as-lead with v2.1a + v2.1b produces equivalent or better results than the legacy `drive_flow` path for every flow type.

**Preconditions:** Phase 1 complete. MCP server connected (Canon MCP tools available to the lead session).

**Preconditions:** v2.1a and v2.1b complete. MCP server connected.

**Deliverables** (extended from v2 with synthesis- and learning-specific rows):

| Deliverable | Method | Pass criteria |
|------------|--------|---------------|
| **Synthesis consistency (3 runs)** | Run the same bug-fix task 3 times via planner-synthesized runbook. | All runs produce: implementation summary, review verdict. Artifact structure matches across runs. |
| **Feature flow equivalence (3 runs)** | Run a 4–6 file feature 3 times, including wave dispatch via agent teams. | Shared task list created. Teammates coordinate without file conflicts. Worktrees merged. All artifacts produced. Commit trailers present. |
| **Epic flow end-to-end (1 run)** | Run a multi-wave epic. | Research, design, multi-wave implementation, review, fix cycle all complete. |
| **Iterate-until-approved quality** | Run N flows with planner-user iteration. Measure iteration count per request; manually grade runbook quality on approval. | Iteration count sensible; approval-quality trend good. |
| **Cold-start vs. steady-state friction** | Measure iteration-0 latency for trivial requests during first 5 flows (cold-start) vs. after ≥ 20 flows of the same shape (steady-state). Per review MEDIUM-6. | Steady-state shows material improvement over cold-start; trend attributable to corpus anchoring, not noise. |
| **Learner baseline (Gate B)** | v2.1b's end-to-end loop closes at least once in real use. | ≥ 1 accepted principle-refinement proposal (Gate B met). |
| **Confidence calibration** | Collect paired (per-signal score, human-graded quality) samples across N flows; compute calibration curve per signal. | Per-signal scores correlate with quality rather than uniform high/low. Deterministic signals (domain_coverage, dependency_drift) calibrate first; LLM self-assessment signals tracked separately for v2.2 decision per review §4.1 HIGH-2. |
| **Regression (flag off, 3 flows)** | Run fast-path, feature, and review-only with flag off. | Zero divergence from pre-Phase-1 baseline behavior. |
| **Agent teams MCP validation** | During feature/epic runs, verify teammate MCP access. | Teammates successfully call `get_principles`, `record_agent_metrics`. Principle-grounded output observed. |
| **Skill preloading validation** | Verify agent definitions with `skills` frontmatter receive preloaded content. | Spawned agents reference preloaded rules without Read tool calls. Confirm via transcript inspection. |
| **Integration checklist** | After each run, check every HIGH-severity gap from §9 disposition table. | All 11 HIGH-severity integrations observed functioning in at least one run. Documented per-gap. |
| **Error handling** | Deliberately trigger: agent spawn failure, MCP tool error, snapshot failure. | Lead recovers gracefully. Does not silently drop the step. |
| **maxTurns exhaustion** | Set engineer maxTurns to 10, give a task that needs more. | Lead detects incomplete result, offers to retry with higher budget. Journal shows step as incomplete. |
| **Mid-flow resume** | Start a feature flow, complete 3 steps, end the session. Resume in a new session. | Lead reads journal + snapshot-or-workspace, continues from the right step. |
| **Vocabulary version resume** | Intentionally advance vocab major version mid-flow against a runbook referencing the removed entry. | Planner regenerates with workspace context per §5.1; user re-approves. See also review MEDIUM-4 — decide whether deprecated-vocab continuation is permitted. |

**Exit criteria:**

- All deliverables above pass per-criterion
- 3 successful runs each on synthesis consistency and feature flows
- 1 successful end-to-end epic flow
- Gate B met (≥ 1 accepted principle-refinement proposal)
- Cold-start vs. steady-state friction measurement shows expected learning-loop effect
- Regression: flag off produces byte-identical behavior to baseline across 3 flow types
- All 11 HIGH-severity integration gaps verified functioning (cross-reference §9)
- Error handling validated for at least 3 failure scenarios
- Documented results in `docs/phase-2-validation-results.md` with per-run details
- Phase 2 task plan reviewed and approved before execution

**MUST NOT touch:**

- Any legacy implementation file. Phase 2 is read-only validation.
- Feature flag default (stays `off`).

### 10.6 Phase 3 — Deletion

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

## 11. Parallel Workstream — MCP & Intelligence Roadmap

See **`docs/mcp-intelligence-roadmap.md`** for the full roadmap of MCP tool improvements, KG intelligence enhancements, self-improving skills, and memory architecture.

This workstream is independent of Phases 1–3. All changes are backward-compatible. v2.1 amendments to v2's priority list:

| Priority | Focus | Key deliverable | v2.1 status |
|----------|-------|----------------|-------------|
| **P0** | Reduce tool calls per spawn | `get_context` composite tool (1 call replaces 3-4) | Unchanged from v2. |
| **P1** | Prepare tools for new model | Journal init in `init_workspace`, `report_result` simplification | Unchanged from v2. |
| **P2** | Consolidation and cleanup | 6 `write_*` → 1 `write_artifact`, board/journal merge | Unchanged from v2. |
| **P3** | KG intelligence | `infer_domains`, community detection, confidence-scored edges, design rationale nodes | Unchanged from v2. |
| **P4** | Self-improving skills | Flow outcome tracking, skill effectiveness analysis, graph-structured memory | **PROMOTED** — v2.1's learning system (§3) makes P4 operational. Phase 2 validation explicitly exercises P4 via skill-effectiveness analyses (§10.5 `domain_skills_loaded` + `outcome` correlation). |
| **P5** | Memory architecture | Ebbinghaus decay, 4-tier hierarchy, token budgets | **CUT from v2.1** — memory audit + grooming defer to v2.2; memory seeding to v2.3+. Memory remains future work; v2.1 does not specify it (per §3.3 deferred matrix). |

v2.1 promotes P4 from roadmap to active Phase 2 validation work. P5 is explicitly deferred beyond v2.1 per architect review (automated writes to agent memory are high-risk without a proven base learner; see §3.3 deferral notes).

---

## 12. Validation Strategy

Validation is defined across two sections:

- **Phase-by-phase deliverables** — §10.5 (Phase 2 deliverables table with pass criteria for synthesis consistency, iterate-until-approved quality, cold-start vs. steady-state friction, learner baseline, confidence calibration, HIGH-severity integration coverage, error handling, maxTurns exhaustion, mid-flow resume, vocabulary version resume).
- **Gates controlling ratification and phase transitions** — §15 (Ratification gates A / B / C).

This section summarizes how each phase proves it is complete and documents the rollback path.

### 12.1 How each phase proves it is complete

**v2 Phase 1 (Gate A, §15.1):** agent roster has `canon-planner` and `canon-engineer`; both validated in ≥ 3 runs under `CANON_AGENT_TEAMS_MODE=on`; all 5 hooks registered; skill preloading validated for ≥ 3 agent types; `npm run build` and `npm test` pass.

**v2.1a (§10.2 exit):** planner synthesizes working runbooks per the synthesis contract; L1 + L4 observed to prevent intent misclassification; 5 distinct request types processed end-to-end; cold-start friction spike passes (review MEDIUM-6).

**v2.1b (Gate B, §15.2):** ≥ 1 accepted principle-refinement proposal produced from real lifecycle data; learning loop observably closes; schema migration clean and reversible.

**v2.2 (per-expansion):** each new refinement target lands with a completed observation → refinement cycle before the next is enabled. Review MEDIUM-1 quality criterion applies to the v2.2 entry gate.

**Phase 2 overall (§10.5):** all 15 deliverables pass per-criterion — synthesis consistency, iterate-until-approved quality, cold-start vs. steady-state friction, learner baseline, confidence calibration (per-signal, deterministic-first), regression, integration coverage, error handling, maxTurns exhaustion, mid-flow resume, vocabulary version resume, agent-teams MCP, skill preloading, feature equivalence, epic end-to-end.

**Phase 3 (unchanged from v2):** structural integrity — `npm run build` passes with zero TypeScript errors; `npm test` passes (expected test count drops by ~65 files); zero remaining imports to deleted module paths; `register-orchestration.ts` registers only kept tools; 10 successful flows post-deletion confirming no runtime regressions.

### 12.2 Rollback path

**v2.1a:** revert the CLAUDE.md amendments + remove `canon-workspace-check.sh` (L4) + revert the `canon-planner` agent-body changes. v2 Phase 1 behavior restored.

**v2.1b:** drop `lifecycle_workspace_snapshots` table + revert `snapshot_workspace` MCP tool + remove the three structured tags + revert the learner's principle-refinement dimension. v2.1a stays.

**v2.2:** per-expansion rollback; each v2.2 addition should be independently reversible.

**Phase 2 flag:** `CANON_AGENT_TEAMS_MODE=off` returns to legacy `drive_flow` path throughout all of v2.1 (gated the same way as v2).

**Phase 3a (flag flip):** flip `CANON_AGENT_TEAMS_MODE` default back to `off`. Legacy code is still present.

**Phase 3b (deletion):** `git revert` the deletion commit(s). This is the point of no easy return — all deletion commits must be atomic per-directory to enable targeted reverts. Alternatively, the legacy code exists on main's git history and can be cherry-picked back.

**Phase 3c (flag removal):** no rollback needed — the flag is gone because the legacy path is gone.

---

## 13. Risks

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

## 14. Out of Scope

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
