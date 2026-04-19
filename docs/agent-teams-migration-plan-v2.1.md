# Canon → Agent Teams Migration Plan v2.1

**Status:** DRAFT — proposed revision of v2
**Supersedes:** `docs/agent-teams-migration-plan-v2.md` (v2, 2026-04-12)
**Last updated:** 2026-04-19
**Origin:** `docs/runbook-synthesis-proposal.md` (PR #115; three architect review cycles)
**Ratification gates:** see §15

---

## 1. Context

### 1.1 What v1 got right

The v1 plan correctly identified six durable ideas, all of which still hold in v2.1:

1. **Runbooks as data-over-code.** Linear playbooks describing step sequences are simpler than a state-machine runtime. (v2.1 takes this further: runbooks are *synthesized per plan* from a canonical step vocabulary, not hardcoded files.)
2. **Hook-based artifact enforcement.** `TaskCompleted` + `TeammateIdle` hooks with workspace-local state files is a clean enforcement channel.
3. **Pinned task list for cross-session resume.** `CLAUDE_CODE_TASK_LIST_ID` + `~/.claude/tasks/<id>/` as the durable work-unit substrate.
4. **Feature-flag gating.** `CANON_AGENT_TEAMS_MODE=off` must remain byte-identical to the legacy `drive_flow` path throughout the migration.
5. **Phased rollout with scoped boundaries.** One migration step at a time, each independently verifiable.
6. **Principles and artifacts as the engine's product.** Canon's differentiation lives in those two layers; the coordination layer is commodity scheduling.

### 1.2 What v2 got right

v2's core insight superseded v1's scope:

- **Claude orchestrates natively.** Everything `drive_flow` coordinates (sequencing, conditionals, HITL gates, parallel dispatch, convergence, skip conditions, effects) is native Claude capability. The custom state machine was built before Claude Code had multi-agent coordination; now that it does, the custom scheduler is overhead.
- **Canon's value stays as MCP tools.** Principle-grounded context, drift tracking, knowledge graph queries, artifact contracts, commit provenance, file claims, enrichment — these are MCP tools, not coordination plumbing. They stay.
- **Agent definitions work as-is.** All 11 agent types are valid as subagents and agent-team teammates. The `tools` allowlist, `skills` frontmatter, `permissionMode`, `memory`, `maxTurns` — all native Claude Code capabilities.
- **Lead handles HITL natively.** No custom breakpoint vocabulary; Claude's conversational HITL is richer than fixed shapes.

### 1.3 What v2.1 changes

Two architectural additions on top of v2:

**Canon's learning loop as the unified quality-up mechanism.** v2 preserves principles, drift, and commit provenance as MCP tools but doesn't articulate how Canon's whole stack (principles, synthesis patterns, templates, domain skills, agent prompts) improves from every interaction. v2.1 makes this explicit: observation → pattern → proposal → refinement is one mechanism applied across every Canon refinement target. The learner's role expands accordingly. (See §4.)

**Synthesis replaces static runbooks.** v2 specified 5 hardcoded runbook files (fast-path / feature / epic / migrate / test-gap). v2.1 replaces these with:

- A canonical step vocabulary (15 IDs) — the stable analytic Schelling point
- A `runbook-synthesis.md` skill that defines how the planner composes a runbook from the vocabulary
- A `planner-brief.md` skill that defines how the planner produces the strategic brief
- An iterate-until-approved loop where `canon-planner` proposes a runbook, the user iterates, and approval triggers execution

Static runbooks don't learn — whoever wrote them wrote them once. Synthesis is what makes plan quality learnable alongside principle quality. (See §§5-6.)

Everything in v2.1 preserves v2's additive-phase discipline except for one deliberate enforcement addition (L4 — see §6.2 and §10.2): a new PreToolUse hook that blocks code modification when no active Canon workspace exists for the current flow. Justified by the intent-misclassification drift concern — L1 (CLAUDE.md re-classification rule) alone is prompt discipline; L4 is the hard backstop.

### 1.4 What does not change from v2

Most of v2 stays intact:

- Integration disposition table (see §9)
- Phase 2 (Validation) and Phase 3 (Deletion) structure
- Agent roster (11 types, same as v2)
- Canon MCP tools (unchanged)
- Workspace storage layout (`.canon/workspaces/<id>/`)
- Hooks model (TaskCompleted, PostCommit, SessionStart, SubagentStop)
- Permission model (`plan` for read-only roles; `acceptEdits` for writers)

v2.1 is additive against v2 for everything outside the synthesis and learning-loop additions.

---

## 2. Target Architecture

### 2.1 The core insight (unchanged from v2)

The v1 plan asked "how do we replace drive_flow with runbooks?" The v2 draft asked "how do we replace drive_flow with a hybrid of subagents and agent teams?" Both questions assumed the state machine needed a replacement. The right question is: **does Canon's state machine provide anything Claude can't do natively?**

The answer, after 18 experiments and a documentation review, is no. Everything `drive_flow` coordinates — sequencing, conditionals, HITL gates, parallel dispatch, convergence, skip conditions, effects — is native Claude capability. The state machine was built before Claude Code had multi-agent coordination. Now that it does, the custom scheduler is overhead.

What the state machine does NOT provide is Canon's actual value: principle-grounded context, drift tracking, knowledge graph queries, artifact contracts, commit provenance, file claims, enrichment. Those are MCP tools. They stay.

### 2.2 The architecture: Canon as Claude's toolkit (amended)

```
User request
  → Claude (lead) reads CLAUDE.md + agent defs
  → Classifies intent (per-message; §10.2 L1 rule)
  → Build intent: spawns canon-planner
      → Planner emits planning-brief.md + runbook.md
      → Iterates with user until approval (§6, §10.5)
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
| **Agent definitions** | 11 types in `agents/*.md` (Phase 1: delete implementor + fixer + guide + chat, add engineer + planner) | Valid as both subagent types and agent team teammate types. Per docs: subagents "inherit all tools from the main conversation, including MCP tools" by default. Definitions support `skills` (preload rules + domain primers), `maxTurns` (effort budget), `permissionMode`, `memory` (cross-session learning). Six agents get `memory: project`: planner (feature history), engineer (fix patterns), researcher (codebase topology), architect (design history), scribe (doc landscape), learner (pattern mining). Reviewer excluded per `agent-cold-review` rule. Guide and chat removed — lead handles these natively via MCP tools and conversation. Each agent includes `agent-context-check` skill for self-serve context verification. |
| **Orchestration journal** | `log_step`, `verify_completion` MCP tools | The lead's checklist. Records steps executed, artifacts expected. Completion hook verifies. Not a state machine — no scheduling, no forced ordering. |
| **Domain skills** | 12 skill files in `skills/canon/references/` (6 existing primers + 6 new) | Domain expertise loaded on-demand by the lead based on task scope — NOT preloaded into agent frontmatter. Lead reads relevant skills and includes in spawn prompt. Agents can also self-serve. |
| **Hooks** | `TaskCompleted`, `TeammateIdle`, `PostCommit`, `SessionStart`, `SubagentStop`, `completion-verify.sh`, `canon-workspace-check.sh` (new in v2.1a — L4) | Artifact enforcement, trailer enforcement, doc staleness detection, scribe queuing, completion verification, Canon-bypass detection. |
| **Workspace storage** | `.canon/workspaces/<id>/` | Artifact storage, progress tracking, workspace metadata. Ephemeral — snapshotted to lifecycle DB at completion, then torn down. |
| **Lifecycle DB** (v2.1b) | `.canon/drift-db.sqlite` with `lifecycle_workspace_snapshots` table | Durable per-flow record surviving workspace cleanup. Substrate for the learning system (§4). |
| **Shared libraries** | `commit-trailers.ts`, `file-claims.ts`, `matcher.ts` | Principle matching, commit provenance, file ownership — used by MCP tools and available to the lead. |
| **Step vocabulary + synthesis skill** (v2.1a, replaces static runbooks) | `skills/canon/references/runbook-vocabulary.md`, `skills/canon/references/runbook-synthesis.md`, `skills/canon/references/planner-brief.md` | The canonical set of step IDs Canon knows + the rules the planner follows to compose a runbook from them. Replaces the 5 hardcoded runbook files v2 specified. Runbooks are now synthesized per plan by `canon-planner`. |
| **Runbook output format** | `templates/runbook-template.md`, `skills/canon/runbooks/README.md` | The shape a synthesized runbook takes. Already landed on PR #115 (phase1-00). |

**What goes (the custom coordination layer, unchanged from v2):**

| Component | File(s) | Why it's deletable |
|-----------|---------|-------------------|
| State machine runtime | `drive-flow.ts`, `drive-flow-helpers.ts`, `drive-flow-wave.ts`, `drive-flow-wave-lifecycle.ts` | Claude sequences steps natively. |
| 9-stage prompt pipeline | `features/prompt-pipeline/` (all stages) | Claude calls MCP tools directly to compose context before spawning. Each MCP tool is a standalone capability, not a pipeline stage. |
| Flow YAML runtime | Parser, validator, fragment inclusion, transition matcher | Claude reads vocabulary + synthesis skill for guidance; no executable state machine needed. |
| Wave event plumbing | `inject_wave_event`, `resolve_wave_event`, flow event channel | Agent teams' native Mailbox + task list replace custom wave coordination. |
| Custom HITL vocabulary | Five breakpoint shapes, convergence exhausted, gate failure | Claude handles HITL natively. Agent teams' plan approval mode covers architect gates. |
| Message channel | `post_message`, `get_messages` | Agent teams' Mailbox replaces this. |
| Session continuation | `applySessionContinuation` | Claude includes context summaries in spawn prompts naturally. |
| Consultation executor | `consultation-executor.ts` | Claude can spawn an advisory subagent and inject its output — no special mechanism needed. |

### 2.3 Pre-build gate — canon-planner (expanded for v2.1)

Claude defaults to action — "add dark mode" → starts building. Canon needs to be smarter. Before committing to any build flow, the lead evaluates whether the request is ready to build:

- Is the problem clearly defined?
- Are acceptance criteria explicit?
- Have alternatives been considered?
- Is the value proportional to the effort?

If any answer is no, the lead surfaces the brief with open questions and iterates with the user. v2.1 goes further: **every build request routes through `canon-planner`**, not just vague ones. The planner produces two artifacts per build and iterates with the user until approval.

**canon-planner v2.1 responsibilities:**

1. **Clarifies requirements** — "What problem are you solving? Who benefits?"
2. **Challenges assumptions** — "You're assuming users need X. What if Y is the actual need?"
3. **Evaluates alternatives** — "You could build this, or configure the existing system to do 80% of it."
4. **Assesses value** — "This would take ~4 agents across 2 waves. Is the value proportional?"
5. **Produces a planning brief** — `plans/${slug}/planning-brief.md`: problem statement, target users, acceptance criteria, alternatives considered, recommended approach, open questions
6. **Synthesizes a runbook** — `plans/${slug}/runbook.md`: step sequence composed from the canonical vocabulary (§5.1) per the synthesis contract (§5.3)
7. **Iterates with the user** until approval — conversational mechanism; intermediate iterations persisted to lifecycle DB for analytics (§6, §8)

Agents are asymmetric by design:
- **Strategic (brief):** value assessment, alternatives, clarifying questions
- **Mechanical (synthesis):** vocabulary-based step composition, HITL posture, artifact paths

These are distinct mental modes. v2.1 captures them as two skill files — `planner-brief.md` and `runbook-synthesis.md` — that the planner loads. The agent body shrinks to: load these skills, emit both artifacts, run the iterate-until-approved loop.

**Agent definition (v2.1 updated):**
- `model: opus` (judgment-heavy, not speed-critical)
- `permissionMode: plan` (read-only — produces a brief + runbook, not code)
- `maxTurns: 40` (iteration loop may take several rounds)
- `memory: project` (remembers what features have been built, which were successful, patterns of over-engineering)
- `skills: planner-brief, runbook-synthesis, agent-surface-assumptions, agent-evidence-over-intuition, agent-context-check, status-protocol`
- Tools: `Read, Glob, Grep, WebFetch, mcp__canon__get_principles, mcp__canon__get_file_context, mcp__canon__graph_query, mcp__canon__semantic_search`

This is not the chat agent (brainstorms, removed in v2) or the researcher (discovers facts). The planner's job is to **push back constructively** — "I could build this, but should I? Here's the plan and the questions."

### 2.4 How Claude orchestrates a Canon flow (amended — iterate-until-approved)

A concrete example of a medium build — "add dark mode to the settings page":

1. **User says** "add dark mode to the settings page" to the Canon lead session.
2. **Claude classifies intent** (per-message; §10.2 L1 rule). This is a build request → routes to `canon-planner`.
3. **Claude spawns `canon-planner`.** Planner loads `planner-brief` and `runbook-synthesis` skills. Reads user request; calls `get_principles` with target-file scope; calls `get_file_context` for KG summaries. Produces `planning-brief.md` + initial `runbook.md` + confidence score with signals.
4. **Claude presents** the brief + proposed runbook to the user with its confidence signals. User reviews.
5. **User iterates** — maybe requests clarification ("what about the mobile view?"), redirects ("skip the design step — it's a simple CSS change"), modifies ("use theme variable X, not Y"). Each iteration re-spawns the planner with workspace context; planner re-scores confidence; new runbook row persisted to lifecycle DB.
6. **User approves** the final runbook. Lead calls `approve_runbook` internally; `lifecycle_synthesized_runbooks.stage` transitions to `approved`.
7. **Claude calls** `init_workspace` to create the workspace per `lifecycle_workspace_snapshots.workspace_id`.
8. **Claude executes the approved runbook step by step.** For each step: calls MCP tools to compose context per the step's `mcp_tools` field; spawns the step's declared `agent` via `dispatch: subagent` or `team`; verifies artifacts exist at declared paths before proceeding.
9. **Agents do the work.** Both subagents and teammates have Canon MCP access; they call `get_principles`, `get_file_context`, `graph_query` directly.
10. **Claude handles HITL** at declared step postures (`approval` / `checkpoint` / `on_failure`). Confidence doesn't modify HITL; it's advisory only (§7.2).
11. **Review + fix loop** if the runbook includes it. Fix is a step with `cause:` set — see §5.2.
12. **Claude calls** `update_board({ operation: "complete_flow" })`, releases file claims, records metrics. `completion-verify.sh` fires, calls `verify_completion` and then `snapshot_workspace({ workspace_id })`. Workspace gets torn down after snapshot. Done.

For a **trivial bug fix** (lightweight proposal — §6.2):
- Steps 1-6 still happen, but the planner synthesizes a 1-step runbook with a one-line overview; user approves in seconds with "go"
- Steps 7-12 run against that minimal runbook

Thin-gate-no-skip pattern: every build goes through planner, but trivial work produces trivial plans that clear quickly.

### 2.5 Subagent capabilities (unchanged from v2; per [Claude Code docs](https://code.claude.com/docs/en/sub-agents))

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

### 2.6 Dispatch framework (unchanged from v2)

| Step pattern | Primitive | Rationale |
|-------------|-----------|-----------|
| Single agent, focused task, artifact goes to next step | **Subagent** | Fast, focused, returns result to lead. Has full MCP access. |
| Sequential pipeline (research → design → implement → review) | **Subagents** (chained) | Each step is independent; only the artifact connects them. Each subagent has its own MCP context. |
| Parallel implementation across files (wave tasks) | **Agent team** | Teammates coordinate via Mailbox, shared task list, file locking. |
| Debate / competing hypotheses | **Agent team** | Teammates challenge each other's findings directly. |
| Consultation (advisory, non-blocking) | **Subagent** | Quick opinion, result returns to lead. |
| Background housekeeping (janitor, learner) | **Subagent** (background + `memory: project`) | Persistent learning across sessions via memory frontmatter. |
