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

### 2.7 Agent self-serve context (resilience model, unchanged from v2)

In the legacy model, agents were helpless — they received everything from the 9-stage prompt pipeline and couldn't self-serve. If a pipeline stage failed or was misconfigured, the agent operated with incomplete context silently.

In the new model, agents have MCP access and preloaded skills. This creates a **self-healing context chain**:

1. **Lead composes context** (primary path): calls `get_principles`, `get_file_context`, `get_drift_report` and includes results in the spawn prompt. This is what the CLAUDE.md orchestration guidance instructs.
2. **Agent self-serves** (fallback path): if the lead's prompt is missing principles or file context, the agent calls the MCP tools itself. Every agent with Canon MCP tools in its `tools` allowlist can independently call `get_principles(file_path, task_description)` to load matched principles.
3. **Skills guarantee baseline** (hard floor): critical rules and references are preloaded via `skills` frontmatter — they're in agent context regardless of what the lead or agent does. An engineer always has `agent-tdd-required`, a reviewer always has `agent-cold-review`.

A preloaded skill `agent-context-check` is injected into every agent via the `skills` frontmatter. It instructs:

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
6. **Agent definitions work as-is.** All 11 agent defs are valid subagent and teammate types.
7. **Canon's whole stack improves from every interaction** (v2.1 addition). The learning system (§4) is one mechanism — observation → pattern → proposal → refinement — applied across every Canon artifact type. Principles, conventions, synthesis skill, planning brief skill, and templates are the five in-scope v2.1 refinement targets (§4.3); the mechanism is uniform; the learner curates weekly.
8. **Runbooks as data, not files** (v2.1 addition). The 5 static runbook files v2 specified are replaced by 1 vocabulary file + 2 skills; runbooks are synthesized per plan by `canon-planner`. Plan quality becomes learnable where static runbooks couldn't learn.

### 2.9 Orchestration journal (the lead's checklist; amended for v2.1)

CLAUDE.md guidance alone is prompt engineering — Claude reads it, usually follows it, sometimes doesn't. The solution is neither prose nor a separate agent: it's a **lightweight MCP tool that acts as the lead's checklist**.

The orchestration journal provides two MCP tools:

```
log_step({ workspace, step_id, agent_type, artifacts_expected, mcp_tools_called, domain_skills_loaded, outcome })
verify_completion({ workspace }) → { steps_logged, steps_missing, artifacts_missing, flow_outcome }
```

**How it works:**

1. **Flow start:** Lead reads the synthesized runbook and calls `log_step` for each planned step. Creates the checklist.
2. **Before each spawn:** `log_step` with `status: "started"` + expected artifacts.
3. **After each spawn:** `log_step` with `status: "completed"` + actual artifacts.
4. **Skipped steps:** `log_step` with `status: "skipped"` + reason (from synthesized `skip_when`).
5. **Flow end:** `completion-verify.sh` hook calls `verify_completion`. Blocks the lead from declaring done if any step is missing or any expected artifact is missing.
6. **Snapshot** (v2.1b addition): after `verify_completion` clears, the hook calls `snapshot_workspace({ workspace_id })` which materializes the workspace into `lifecycle_workspace_snapshots`. Workspace can then be torn down.

**v2.1 extensions:**

- **`domain_skills_loaded` field** — captures which skills the agent loaded per step. Enables skill-effectiveness analyses (§4, §7 learner dimensions).
- **`outcome` field** — typed per-step outcome (review verdict, fix iterations, test pass rate). Feeds Phase 2 calibration.
- **Snapshot integration** — completion-verify hook extends to invoke `snapshot_workspace` after `verify_completion` clears.

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

### 2.10 Enforcement model — defense-in-depth (amended for v2.1)

The state machine provided determinism through a single hard enforcement layer. v2.1 replaces it with **eight** layers (v2 had seven; v2.1 adds L4 PreToolUse hook):

| Layer | Mechanism | Type | What it guarantees |
|-------|-----------|------|-------------------|
| 1 | CLAUDE.md + vocabulary + synthesis skill | Soft | Step ordering, MCP tool composition, dispatch decisions, **per-message intent re-classification** (v2.1 L1 addition) |
| 2 | Skills preloading | Medium | Critical rules and domain primers always in agent context |
| 3 | Orchestration journal (`log_step` / `verify_completion`) | Medium-hard | Audit trail of steps executed; completion hook blocks if steps missing |
| 4 | Agent definitions (`tools`, `maxTurns`, `permissionMode`) | Hard | Tool access restrictions, effort budgets, write permissions |
| 5 | **`canon-workspace-check.sh` PreToolUse hook (v2.1a L4 addition)** | Hard | Blocks `Edit` / `Write` / `Bash`-that-modifies-code when no active Canon workspace exists for the current flow. Backstops L1 against intent-misclassification drift. |
| 6 | Hooks (`TaskCompleted`, `PostCommit`, `completion-verify.sh`) | Hard | Artifact existence, commit trailers, completion cleanup, lifecycle snapshot |
| 7 | MCP tool contracts (schema validation) | Hard | Input/output shapes for `update_board`, `record_agent_metrics`, `write_*`, `snapshot_workspace` (v2.1b) |
| 8 | Workspace state + lifecycle DB | Hard | Artifacts on disk at known paths while workspace exists; structured record in lifecycle DB surviving workspace cleanup |

**Plus self-healing context (§2.7):** if the lead misses a composition step, agents self-serve via MCP.

**Post-subagent artifact check (in CLAUDE.md guidance):** After each subagent returns, the lead verifies expected artifacts exist at the paths listed in the runbook's `artifacts` field before proceeding to the next step. Compensates for the lack of hook-based enforcement on subagents (`TaskCompleted` and `TeammateIdle` hooks only apply to agent teams teammates, not subagents).

**Completion verification hook** (`completion-verify.sh`): calls `verify_completion` + then `snapshot_workspace` (v2.1b addition). Blocks the lead from declaring done if:
- Any step was logged as "started" but not "completed"
- Any expected artifact is missing from disk
- Board state is not "complete"
- Claims are not released
- Snapshot fails (v2.1b)

**Canon-bypass check hook** (`canon-workspace-check.sh`, v2.1a L4 addition): blocks `Edit` / `Write` / `Bash` code-modification when no active Canon workspace exists for the current flow. Prevents Claude from drifting out of Canon during session transitions (e.g., chat/question session pivoting to build request, lead continuing with native tools rather than re-routing through planner).

**What's genuinely weaker and accepted:**
- Step ordering is not enforced — Claude may reorder steps. Accepted as a feature.
- Context composition quality varies — mitigated by agent self-serve (§2.7) and skills (layer 2).
- The lead can skip `log_step` calls entirely — but CLAUDE.md instructs it, the MCP tool is in its tools list, and the completion hook catches the gap at the end.
- Confidence signals may be miscalibrated initially (LLM overconfidence bias) — mitigations in §7.4; learner calibration in v2.2.

### 2.11 Platform capabilities (unchanged from v2; per [Claude Code documentation](https://code.claude.com/docs/en/sub-agents))

#### Subagent capabilities

| Capability | Documentation quote / summary | Canon application |
|-----------|------------------------------|-------------------|
| **MCP inheritance** | "By default, subagents inherit all tools from the main conversation, including MCP tools." | Subagents call `get_principles`, `record_agent_metrics`, `get_file_context` directly. No lead injection needed. |
| **`tools` allowlist** | Restricts inherited tools when set. | Canon agent defs can restrict per-role tool access. Omitting `tools` inherits everything including Canon MCP. |
| **`mcpServers`** | "Give a subagent access to MCP servers." | Agent defs can reference `canon` MCP server by name for roles that restrict `tools` but still need Canon access. |
| **`skills`** | "Subagents don't inherit skills from the parent conversation; you must list them explicitly." | Preload Canon skills per agent role. |
| **`hooks`** | Per-subagent lifecycle hooks (PreToolUse, etc.) | Tool enforcement scoped to a role. |
| **`memory`** | Persistent directory that "survives across conversations." Scopes: user, project, local. | Native cross-session learning. |
| **`maxTurns`** | "Maximum number of agentic turns before the subagent stops." | Native effort budget. |
| **`permissionMode`** | Per-subagent override. | Per-role permissions. |
| **`isolation: worktree`** | "Run the subagent in a temporary git worktree." Automatic cleanup if no changes. | Native worktree isolation per spawn. |
| **`model`** | Per-subagent model selection. | Route cheap tasks to Haiku, expensive tasks to Opus. |

#### Agent teams capabilities

| Capability | Documentation quote / summary | Canon application |
|-----------|------------------------------|-------------------|
| **MCP access** | "Each teammate loads the same project context as a regular session: CLAUDE.md, MCP servers, and skills." | Teammates have full Canon MCP access. |
| **Mailbox** | Direct teammate-to-teammate messaging. | Replaces custom `post_message` / `get_messages` and flow event channel. |
| **Plan approval** | "The teammate works in read-only plan mode until the lead approves their approach." | Maps directly to Canon's architect approval gate. Native HITL. |
| **Shared task list** | Dependencies auto-unblock. "Task claiming uses file locking to prevent race conditions." | Replaces custom wave task coordination. |
| **`tools` honored** | "The teammate honors that definition's tools allowlist and model." | Canon agent definitions enforce tool scope for teammates. |
| **Graceful shutdown** | The lead sends a shutdown request; teammate can approve or reject. | Partial abort for long-running teammates. |
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

Every interaction contributes observations to a growing corpus. The learner periodically mines that corpus for patterns and emits proposals. Canon maintainer-equivalent curates weekly (§3.4). Accepted proposals land as refinements. Over weeks and months, Canon's principles sharpen, its synthesis skill learns common request shapes, its templates lose dead sections, and its domain skills reflect what actually works.

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

Agent memory is also deferred (audit/groom → v2.2; seeding → v2.3+). Memory-related writes are a new write scope with serious failure modes (groom-away-critical-knowledge, incorrect consolidation, stale-seed calcification) — deferred until trustworthy base learner proven on lower-risk targets first.

**Cut entirely (1 target):**

**Knowledge graph priors** (`knowledge-graph.db`) — cut from the learning system's refinement target set. The KG is its own subsystem with its own confidence story (computed from code structure, semantic neighborhoods, file relationships). Automated KG refinement based on flow-corpus statistics is a separate architectural commitment that doesn't belong in this proposal. If automated KG refinement ever becomes desirable, it is a separate Canon system designed against the KG's own data model and confidence semantics.

### 3.4 Learner-loop curation ownership

**Canon maintainer-equivalent curates weekly.** A human reviewer reads the learner's proposals in `.canon/proposed-learnings/{timestamp}/` once per week, accepts or rejects each, and applies accepted proposals as real edits to the relevant artifact (principle file, skill, template). Rejected proposals are logged with a reason in `.canon/learning.jsonl` and dismissed; the learner reads this log to avoid re-suggesting dismissed items.

- Cadence: weekly (adjustable based on signal volume)
- Review artifact: the existing `.canon/proposed-learnings/{timestamp}/` directory the learner already produces
- Apply mechanism: manual edits by the reviewer (the learner's proposals include structured patches where possible; reviewer applies)
- Dismissal log: `.canon/learning.jsonl` (already exists) records accepted/dismissed decisions

Automation (planner auto-tunes from learner output without human curation) is §11 P5 territory — deferred beyond v2.1 unless the supervised loop proves trustworthy and high-quality for a sustained period first.

### 3.5 Single-target vs. cross-target analyses

Within the 5 in-scope targets, some analyses produce single-target proposals; others correlate across targets:

- **Single-target:** "Principle P's fix-iteration cost is elevated → refine P." Target: principles.
- **Cross-target (v2.2):** observation patterns that suggest connected refinements to synthesis-skill *and* a domain-skill, or template *and* a principle. Cross-target proposals are higher-signal but require more analysis surface; defer to v2.2 once v2.1b's single-target loop is demonstrably working.

Cross-target analyses against the deferred targets (agent defs, vocabulary, etc.) wait for those targets' own ratification.
