# Canon

Engineering principles as code. Canon gives Claude Code a structured set of principles that are loaded before code generation, enforced during review, and refined through a data-driven learning loop.

> **Note:** Canon is a work in progress. The core enforcement loop, learning system, and MCP tools are functional, but rough edges remain. Principle coverage is opinionated and likely needs tuning for your stack. Expect breaking changes as the plugin format and MCP protocol evolve. Feedback and contributions welcome — open an issue or PR.

## Installation

Canon is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins). Install it from GitHub:

```bash
# Add the marketplace
/plugin marketplace add micherra/canon

# Install the plugin
/plugin install canon@micherra-canon

# Then initialize in your project
/canon:init
```

Or add from a local clone:

```bash
git clone https://github.com/micherra/canon.git
/plugin marketplace add ./canon
/plugin install canon@canon
```

After installing, Canon's slash commands, agents, hooks, and MCP tools are available in any Claude Code session within your project.

### Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 24+ (for the MCP server; matches CI and release workflows)

## Cursor-only Setup (no Claude Code plugin)

Canon's full build/review pipeline can run in Cursor without installing the Claude Code plugin.

1. In your project repo, run:
```bash
npx -y canon-cursor
```
This installs Cursor configuration and the Cursor-side runner into the repo (including `.cursor/mcp.json` and `AGENTS.md`).

2. Restart Cursor.

3. Trigger Canon in chat, for example:
- `Review my changes`
- `Security scan for vulnerabilities`
- `Add an auth-protected dashboard with Zod validation`

On first use, Cursor will start Canon's MCP server and auto-run `npm install` inside `mcp-server/` if dependencies are missing.

### Claude Max users

Opus 4.6 uses a 1M context window which requires **extra usage** on Claude Max. If you see `"Extra usage is required for long context requests"`:

1. Enable extra usage in your Claude account settings
2. Set a monthly spend limit (e.g. $5)
3. Buy extra usage balance — even a few dollars is enough for testing

Canon commands specify the right model tier for each task (haiku for simple ops, sonnet for code work, opus for architecture), so extra usage costs are minimized.

If you don't want to enable extra usage, launch with Sonnet instead:

```bash
claude --model sonnet
```

We also recommend enabling tool search to reduce context usage from MCP tools:

```json
// ~/.claude/settings.json
{
  "env": {
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

## Quick Start

```bash
# In your project directory
/canon:init
```

This creates `.canon/principles/` with 59 starter principles, a `CONVENTIONS.md` template, and integrates with your `CLAUDE.md`. Ask Canon for status to verify.

## How It Works

Canon operates on a three-tier severity model:

| Severity | Meaning | Enforcement |
|----------|---------|-------------|
| **rule** (4) | Hard constraint | Blocks commits. Reviewer verdict: BLOCKING. |
| **strong-opinion** (36) | Default path | Warns. Deviations require justification via `report` tool. |
| **convention** (19) | Stylistic preference | Noted in reports. Tracked for drift. |

When you write code, Canon automatically loads principles matched to your file's architectural layer and path patterns. Agents self-review against them before presenting output.

## Commands & Natural Language

Canon uses a two-tier interface: **natural language** for common workflows and **slash commands** for specialized utilities.

### Natural Language

Just describe what you want. Canon classifies your intent and routes to the right agent:

| What you say | What happens |
|-------------|-------------|
| "Add an order creation endpoint with Zod validation" | Build pipeline: auto-detects scope → research → architect → implement → test → review → ship |
| "The login page is broken" | Hotfix or quick-fix flow depending on urgency |
| "Refactor the auth middleware" | Refactor flow: analyze scope → implement with continuous test verification → review |
| "Migrate from Express to Hono" | Migration flow: research scope + rollback plan → staged implementation → security → review |
| "How does the payment system work?" | Explore flow: parallel research → synthesized analysis report |
| "Improve test coverage for the API layer" | Test-gap flow: scan coverage → write tests → fix bugs tests reveal → review |
| "Review my changes" / "Review PR 42" | Code review against Canon principles (supports staged, branch, PR, or file scoping) |
| "Scan for vulnerabilities" | Security audit flow |
| "What's the status?" | Health dashboard — principle counts, review scorecard, build progress |
| "Create a new principle about error handling" | Interactive principle authoring via canon-writer |
| "Skip tests, this is a small task" | Build with flags parsed from natural language |

Build modifiers can be expressed naturally: "skip research", "just plan don't implement", "this is a large task", "use the quick-fix flow".

### Slash Commands

| Command | What it does |
|---------|-------------|
| `/canon:init` | Set up Canon in your project — auto-detects codebase conventions |
| `/canon:learn` | Analyze data to suggest principle and convention improvements |
| `/canon:adopt` | Scan for coverage gaps, produce a remediation plan, optionally auto-fix rule violations |
| `/canon:check` | Lightweight pre-commit principle compliance check on staged or specified files |
| `/canon:pr-review` | Review a PR or branch against principles with layer-parallel fan-out |
| `/canon:edit-principle` | Edit an existing principle — change severity, scope, tags, or body |
| `/canon:test-principle` | Verify a principle is detected during review by generating a violation |
| `/canon:toggle-archive` | Archive or unarchive a principle — archived entries are skipped by the matcher |
| `/canon:doctor` | Diagnose setup issues — broken frontmatter, duplicate IDs, MCP server health |
| `/canon:clean` | Clean up workspace artifacts — optionally archive decisions and notes to project history |
| `/canon:create-flow` | Create a new flow definition |
| `/canon:create-overlay` | Create a new role overlay |
| `/canon:workspaces` | List and manage Canon workspaces |

## The Build Pipeline

Canon auto-selects the right pipeline based on what you're doing:

| Flow | When | Pipeline |
|------|------|----------|
| **hotfix** | Production incidents, urgent fixes | implement → verify → ship (3 states, no review loop) |
| **quick-fix** | Small bug fixes (1-3 files) | implement → verify → review → ship |
| **refactor** | Restructuring, renaming, extracting | analyze scope → **checkpoint** → implement (waves, test gate per wave) → verify → review → ship |
| **feature** | New features (4-10 files) | design → **checkpoint** → implement → test → review → ship |
| **migrate** | Upgrades, migrations, version bumps | research (scope + rollback) → design → **checkpoint** → implement → verify → security → review → ship |
| **deep-build** | Large cross-cutting changes (10+ files) | research → design → **checkpoint** → implement (waves + consultations) → test → security → review → ship |
| **explore** | Research questions, investigations | research (parallel) → synthesize → report (no implementation) |
| **test-gap** | Coverage improvement | scan gaps → write tests → fix revealed bugs → review |
| **review-only** | Review existing changes | review with layer-parallel fan-out for large diffs |
| **security-audit** | Security scanning | security scan → principle compliance review |
| **adopt** | Onboarding Canon to a repo | scan violations → auto-fix → rescan |

Each phase is handled by a specialized agent. The top-level Claude acts as the orchestrator — it calls MCP harness tools to manage state and spawns specialist agents as leaf workers. No intermediate orchestrator subagent is needed. Shared patterns (test-fix loops, review-fix loops, user checkpoints, shipping) are defined as **composable fragments** that flows include and wire together, eliminating duplication across pipelines.

**User checkpoints** pause the pipeline after planning to present a summary of what's planned and collect your feedback. Approve to proceed, or share thoughts — the agent classifies your response semantically (no magic keywords) and routes revisions back to the planning phase with your notes attached.

For wave-based implementation (multi-task parallel builds), the orchestrator runs **consultation fragments** at three breakpoints:
- **Before wave**: Architect reviews upcoming plans, pre-answers likely questions, flags conflicts between parallel tasks
- **Between waves**: Architect checks for pattern drift, security agent does a quick scan — outputs feed into the next wave's briefing
- **After waves**: Architect produces an implementation overview artifact for downstream test, security, and review agents

## Principles

Principles, rules, and agent-rules all share the same markdown-with-YAML-frontmatter format. This is Canon's core building block — understanding it lets you extend Canon for your own projects and workflows.

```yaml
---
id: validate-at-trust-boundaries
title: Validate at Trust Boundaries
severity: rule
scope:
  layers: [api]
  file_patterns: ["src/routes/**", "**/*.controller.ts"]
tags: [security, validation]
---

Body goes here — rationale, examples, and anti-patterns.
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique kebab-case identifier. Used for deduplication — a project-local entry with the same `id` overrides the built-in one. |
| `title` | yes | Human-readable name shown in review output and dashboards. |
| `severity` | yes | One of `rule`, `strong-opinion`, or `convention`. Controls enforcement level (see severity table above). |
| `scope.layers` | no | Architectural layers this entry applies to. Recognized layers: `api`, `ui`, `domain`, `data`, `infra`, `shared`. Canon infers layers from file paths (e.g. `src/routes/` → `api`, `src/components/` → `ui`). An empty list means it applies to all layers. |
| `scope.file_patterns` | no | Glob patterns to match specific files (e.g. `"**/*.tf"`, `"src/db/**"`). When set, the entry only activates for matching paths. |
| `tags` | no | Freeform labels for filtering and grouping (e.g. `security`, `testing`, `agent-behavior`). Used by the `list_principles` MCP tool and when browsing principles via natural language. |
| `archived` | no | Set to `true` to disable this entry without deleting it. Archived entries are skipped by the matcher and won't appear in reviews. |

### Where the template is used

| Location | What lives there | Examples |
|----------|-----------------|----------|
| `principles/rules/` | Hard constraints that block commits | `secrets-never-in-code`, `fail-closed-by-default` |
| `principles/strong-opinions/` | Default paths that warn on deviation | `prefer-composition`, `explicit-error-handling` |
| `principles/conventions/` | Stylistic preferences tracked for drift | `consistent-naming`, `file-length-limit` |
| `agent-rules/` | Behavioral guidelines for Canon's agents | `agent-cold-review`, `agent-design-before-code` |

Agent-rules use the same frontmatter fields but target agent behavior rather than application code. For example, `agent-cold-review` ensures the reviewer agent evaluates code without seeing prior feedback.

### How matching works

When you edit a file, Canon infers its architectural layer from the path and selects entries whose `scope.layers` and `scope.file_patterns` match. Entries are loaded in severity order — rules first, then strong-opinions, then conventions — capped at `max_principles_per_review` per context (default 10, configurable in `.canon/config.json`). An entry with no `layers` and no `file_patterns` matches everything.

### Adding your own

Place your file in the appropriate directory under `.canon/` (for project-local) or contribute directly to the Canon plugin:

```
.canon/
├── principles/
│   ├── rules/              # Hard constraints — block commits
│   ├── strong-opinions/    # Default path — warn on deviation
│   └── conventions/        # Stylistic preferences — tracked for drift
└── agent-rules/            # Behavioral constraints for Canon agents
```

Use guided authoring or create files directly:
- Ask Canon to create a new principle — the orchestrator spawns canon-writer in new-principle mode
- Ask Canon to create a new agent-rule — the orchestrator spawns canon-writer in new-agent-rule mode

## The Learning Loop

Canon doesn't just enforce — it learns. As you review code, log decisions, and run builds, Canon accumulates data:

```
reviews.jsonl      ← review results (violations, honored, scores, verdict)
decisions.jsonl    ← intentional deviations with justifications
patterns.jsonl     ← agent-observed codebase patterns
learning.jsonl     ← learning history (suggestions, actions, dismissals)
```

Run `/canon:learn` to analyze this data across six dimensions:

1. **Pattern inference** — Find repeated codebase patterns not yet captured as conventions
2. **Drift-driven severity** — Suggest promotions and demotions based on compliance data
3. **Task convention promotion** — Promote recurring task conventions to project level
4. **Decision clustering** — Find patterns in why principles get overridden
5. **Convention graduation** — Identify mature conventions ready to become principles
6. **Staleness detection** — Flag conventions the codebase no longer follows

Use `--apply` to walk through suggestions interactively.

## The Codebase Graph

Canon builds a dependency graph of your codebase to power structural analysis:

```bash
# Generated automatically when the dashboard opens, or manually:
# Call codebase_graph MCP tool
```

The graph includes:
- **Nodes**: Every source file with layer, violation count, changed status
- **Edges**: Import/dependency relationships
- **Insights**: Most connected files, orphans, circular dependencies, layer boundary violations
- **Reverse index**: Which files depend on each file (persisted as `reverse-deps.json`)

Graph data enriches the entire review pipeline:
- `review_code` auto-injects `bounded-context-boundaries` for files with layer violations
- `review_code` auto-injects `architectural-fitness-functions` for files in cycles
- `get_file_context` returns fan-in, fan-out, hub status, cycle membership, and impact score
- Violations carry optional `impact_score` — higher score = more dependents affected
- The Canon Dashboard visualizes the graph with D3 force layout

## Canon Dashboard

The Canon Dashboard is a VS Code / Cursor extension that brings the codebase graph to life as an interactive visualization. It activates automatically when a `.canon` directory is detected in your workspace.

**What it shows:**

- **Interactive dependency graph** — D3 force-directed layout with nodes colored by architectural layer (api, ui, domain, data, infra, shared)
- **Git overlay** — Changed files pulse on the graph so you can see what's in flux
- **Violation context** — Violations enriched with fan-in, hub status, cycle membership, and impact scores
- **Search and filter** — Find files by name, filter by layer, changed status, violations, or PR review scope

**How it connects to Canon:**

When you click a node in the graph, the selection is persisted to `.canon/dashboard-state.json`. The `get_dashboard_selection` MCP tool reads this state, so when you start a conversation Canon already knows which file you're focused on — along with its dependencies, matched principles, and graph metrics.

**Commands:**

| Command | Description |
|---------|-------------|
| `Canon: Open Dashboard` | Open the codebase graph visualization |
| `Canon: Refresh Graph` | Regenerate and push updated graph data |

**Install from a pre-built `.vsix`:**

```bash
code --install-extension canon-dashboard-0.1.0.vsix
```

Or build from source in `cursor-extension/`:

```bash
npm install && npm run build && npm run package
```

## The Agent Harness

The agent harness is Canon's orchestration runtime — the set of MCP tools and state machine logic that the top-level Claude (the orchestrator) uses to drive multi-agent builds. The orchestrator calls these tools directly; it never writes code or produces artifacts itself.

### The execution loop

For each build, the orchestrator runs this cycle:

1. **`load_flow`** — Parse the flow definition: states, transitions, fragments, and spawn instructions
2. **`init_workspace`** — Create a workspace for the task (`board.json` tracking state, `session.json` with metadata)
3. For each state:
   - **`check_convergence`** — Verify the loop hasn't exceeded its iteration limit
   - **`update_board`** — Enter the state (record start time, mark active)
   - **`get_spawn_prompt`** — Resolve the spawn prompt with variable substitution, overlays, and wave context
   - **Spawn agent** — The orchestrator spawns the specialist agent (implementor, reviewer, etc.) as a subagent
   - **`report_result`** — Record the agent's result, evaluate transition conditions, get `next_state`
4. On terminal state: **`update_board(complete_flow)`** — Mark the flow done

### Harness tools

| Tool | Purpose |
|------|---------|
| `load_flow` | Parse a flow definition — resolves fragment includes, validates state graph |
| `init_workspace` | Create or resume a workspace (`board.json`, `session.json`) |
| `update_board` | Mutate board state: enter/skip/block/unblock states, complete flow, set wave progress |
| `get_spawn_prompt` | Resolve spawn prompt for a state (variable substitution, overlays, wave context) |
| `report_result` | Record agent result, evaluate transitions, check stuck detection; returns `next_state` |
| `check_convergence` | Check iteration limits before re-entering a looping state |
| `list_overlays` | List available role overlays (expertise lenses injected into prompts) |
| `post_wave_bulletin` | Post inter-agent message during parallel wave execution |
| `get_wave_bulletin` | Read wave bulletin messages from other agents in the same wave |
| `validate_flows` | Validate flow definitions (parse, fragment resolution, reachability) |

### State types

Flows are composed of states, each with a type that controls how agents are spawned:

| Type | Behavior |
|------|----------|
| `single` | One agent runs to completion, then transitions |
| `parallel` | Multiple agents run concurrently; all must complete before transitioning |
| `wave` | Parallel agents in isolated git worktrees, with gate checks between waves |
| `parallel-per` | Fan-out: one agent per item produced by the previous state |

### Convergence and stuck detection

Looping states (test-fix loops, review-fix loops) have a maximum iteration count. Before re-entering a loop, `check_convergence` verifies the limit hasn't been hit. If an agent produces the same result across multiple iterations — indicating it's not making progress — stuck detection triggers and the pipeline blocks for human input.

### HITL (Human-in-the-Loop)

When the pipeline blocks — due to stuck detection, a gate failure, or an explicit checkpoint — the orchestrator surfaces the situation to you with options:

- **Retry** — Re-run the current state (e.g. after manually fixing something)
- **Skip** — Move past the blocking state
- **Rollback** — Revert to a prior state in the flow
- **Abort** — Stop the build entirely
- **Manual fix** — Apply a fix yourself, then resume

See `agents/canon-orchestrator.md` for the full orchestrator protocol.

## MCP Tools

Canon exposes 14 tools via its MCP server for agents to use during normal work:

| Tool | Purpose |
|------|---------|
| `get_principles` | Get principles relevant to a file/layer context, enriched with graph metrics |
| `list_principles` | Browse the full principle index with filters |
| `review_code` | Get matched principles for code review — auto-injects graph-derived principles for layer violations and cycles |
| `get_compliance` | Query compliance stats and trend for a specific principle |
| `report` | Log a decision, pattern, or review result for drift tracking and the learning loop |
| `get_drift_report` | Get drift report — compliance rates, violations, hotspots, and trends |
| `get_decisions` | Query logged decisions for a principle or file |
| `get_patterns` | Query observed codebase patterns |
| `get_pr_review_data` | Get PR file list, layers, and graph-aware priority scores |
| `codebase_graph` | Generate dependency graph with compliance overlay, insights, and reverse-dep index |
| `get_file_context` | Get file content, imports, dependents, violations, and graph metrics (fan-in, hub status, cycles) |
| `store_summaries` | Persist file summaries incrementally for dashboard display |
| `store_pr_review` | Store a PR review result for drift tracking |
| `get_dashboard_selection` | Get selected node context with graph metrics and downstream impact |

## Agents

Canon uses 13 specialist agents, each with a focused role. The top-level Claude acts as the orchestrator (using MCP harness tools), spawning these agents as leaf workers:

| Agent | Role |
|-------|------|
| `canon-researcher` | Investigate codebase patterns, architecture, and risk |
| `canon-architect` | Design approach, graph-informed wave assignment, break into task plans |
| `canon-implementor` | Write code against plans and principles |
| `canon-tester` | Generate integration tests |
| `canon-security` | Scan for vulnerabilities |
| `canon-reviewer` | Two-stage review: compliance + graph-aware code quality |
| `canon-fixer` | Fix test failures and violations using graph-aware caller discovery |
| `canon-learner` | Analyze patterns and suggest principle refinements |
| `canon-writer` | Create and edit principles, conventions, and agent-rules |
| `canon-shipper` | Post-build PR description, changelog, and optional PR creation |
| `canon-scribe` | Post-implementation documentation sync (CLAUDE.md, context.md, CONVENTIONS.md) |
| `canon-guide` | Answer questions, browse principles, show status |
| `canon-inspector` | Analyze completed builds, produce cost/bottleneck reports |

### Graph-Aware Agents

The reviewer, fixer, and architect agents are graph-aware — they use the codebase dependency graph to make better decisions:

- **Reviewer**: When `review_code` returns `graph_context`, the reviewer factors in fan-in (blast radius), cycle membership, and layer boundary violations. Violations in hub files are flagged as higher-impact.
- **Fixer**: Calls `get_file_context` to discover callers via the dependency graph before fixing. High fan-in files get extra caution — prefer internal-only changes that preserve the external API.
- **Architect**: Uses `get_file_context` to verify wave assignments against the real dependency graph. Files in dependency cycles are placed in the same wave.

## Agent Workspaces

Canon agents share context through **task-scoped workspaces** — structured folders where agents write research, decisions, logs, and plans that other agents can read. Multiple tasks can run independently on the same branch, each in its own workspace.

```
.canon/workspaces/{sanitized-branch}/{task-slug}/
├── session.json              # Session metadata (branch, task, tier, status)
├── log.jsonl                 # Chronological agent activity log
├── context.md                # Living shared context (architect-owned)
├── research/                 # Research findings (one per dimension)
├── decisions/                # Design decisions with rationale
├── plans/                    # Task plans and build artifacts
│   └── {task-slug}/
├── reviews/                  # Review outputs
└── notes/                    # Freeform notes
```

### How it works

1. When a build starts, the orchestrator creates a workspace for the task (scoped by branch + task slug)
2. Each agent reads and writes to scoped areas — the researcher writes to `research/`, the architect writes to `decisions/` and `plans/`, etc.
3. All agents append to `log.jsonl` for a shared activity timeline
4. The architect owns `context.md` — a living document with key decisions and patterns that downstream agents read

### Agent permissions

Agents have scoped read/write access to preserve existing isolation principles:
- **Reviewer never reads research or plans** — cold review is preserved
- **Implementor only reads its own plan** + shared context — fresh context is preserved
- **Researcher never reads other researchers** — scoped research is preserved

### Templates

Standardized output templates in the plugin's `templates/` directory ensure consistent structure. Each template declares which agents produce it (`used-by`), which agents consume it (`read-by`), and where the artifact is saved (`output-path`).

| Template | Produced by | Consumed by | Output path |
|----------|-------------|-------------|-------------|
| `research-finding.md` | canon-researcher | canon-architect | orchestrator-provided |
| `design-decision.md` | canon-architect | canon-implementor | `${WORKSPACE}/decisions/` |
| `implementation-log.md` | canon-implementor, canon-fixer | canon-tester, canon-reviewer, canon-scribe, canon-shipper | `${WORKSPACE}/plans/${slug}/SUMMARY.md` |
| `review-checklist.md` | canon-reviewer | canon-shipper | `${WORKSPACE}/reviews/` |
| `session-context.md` | canon-architect | canon-implementor | `${WORKSPACE}/context.md` |
| `security-assessment.md` | canon-security | canon-shipper | `${WORKSPACE}/plans/${slug}/SECURITY.md` |
| `context-sync-report.md` | canon-scribe | canon-shipper | `${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md` |
| `test-report.md` | canon-tester | canon-shipper | `${WORKSPACE}/plans/${slug}/TEST-REPORT.md` |
| `wave-briefing.md` | canon-orchestrator | canon-implementor | injected as `${wave_briefing}` |
| `claudemd-template.md` | canon-scribe | — | project root `CLAUDE.md` |

### Lifecycle

Workspaces are ephemeral by default — scoped to a branch's active development:
- **Create**: Automatically when a build starts
- **Archive**: Run `/canon:clean --archive` to save decisions and notes to `.canon/history/`
- **Delete**: Run `/canon:clean` to remove workspace artifacts after branch merge

## Hooks

Canon includes 9 automation hooks:

- **Pre-commit secrets check** — Blocks commits containing hardcoded secrets (API keys, private keys, connection strings)
- **Pre-push review guard** — Warns before pushing if no Canon review covers the unpushed commits
- **Large file guard** — Warns before writing or editing files that exceed a line threshold (default 500, configurable via `max_file_lines` in `.canon/config.json`)
- **Compaction check** — Warns when `.jsonl` data files or `CONVENTIONS.md` grow past thresholds
- **Learn nudge** — Suggests `/canon:learn` after 10+ reviews accumulate
- **Principle injection** — Injects relevant Canon principles into context before Write/Edit operations
- **Agent cost tracker** — Logs every agent spawn to `.canon/agent-costs.jsonl` for cost observability
- **Destructive git guard** — Blocks destructive git operations (reset --hard, clean -f, checkout --, branch -D) for user confirmation
- **Workspace lock guard** — Warns before git commit/merge if the workspace has an active lock from another session

## Context Management

As your project grows — more principles, more reviews, more conventions — Canon manages context consumption to prevent rot:

| Mechanism | What it does |
|-----------|-------------|
| **Principle cap** | `get_principles` returns at most `max_principles_per_review` entries (default 10, configurable in `.canon/config.json`). Rules are always prioritized. |
| **Review cap** | `review_code` always includes every matched rule (they block commits and are never dropped), then fills remaining budget with strong-opinions and conventions up to `max_review_principles` (default 15, configurable). Total may exceed the cap when many rules match. |
| **Summary-only mode** | `get_principles` accepts `summary_only: true` to return just the first paragraph (~60% less context) instead of full rationale/examples. |
| **Data rotation** | `.jsonl` files auto-rotate at 500 entries — older entries move to `*.archive.jsonl`, keeping the active file lean. |
| **Principle archiving** | Add `archived: true` to a principle's frontmatter to disable it without deleting. Archived principles are skipped by the matcher. |
| **Compaction hook** | Warns after commits if data files or `CONVENTIONS.md` have grown past thresholds. |

### Configuration

All configuration lives in `.canon/config.json` in your project root. Every key is optional — Canon uses sensible defaults when a key is missing.

```json
{
  "source_dirs": ["src", "lib"],
  "max_file_lines": 500,
  "layers": {
    "api": ["api", "routes", "controllers"],
    "ui": ["app", "components", "pages", "views"],
    "domain": ["services", "domain", "models"],
    "data": ["db", "data", "repositories", "prisma"],
    "infra": ["infra", "deploy", "terraform", "docker"],
    "shared": ["utils", "lib", "shared", "types"]
  },
  "review": {
    "max_principles_per_review": 10,
    "max_review_principles": 15
  }
}
```

| Key | Default | What it controls |
|-----|---------|-----------------|
| `source_dirs` | — | Directories to scan for the codebase graph. When not set, tools require an explicit `source_dirs` or `root_dir` parameter. |
| `max_file_lines` | 500 | Line threshold for the large file guard hook. Files exceeding this trigger a warning on write/edit. |
| `layers` | See defaults above | Maps layer names to directory patterns for architectural layer inference. Files in matching directories are assigned that layer. Override to match your project's structure. |
| `review.max_principles_per_review` | 10 | Cap for `get_principles` (used during code generation). Rules are always included first. |
| `review.max_review_principles` | 15 | Cap for `review_code` (used during reviews). Rules are never dropped — the total may exceed this cap when many rules match. |

Run `/canon:doctor` to check for configuration issues.

## Project Structure

```
canon/
├── principles/          59 engineering principles organized by severity
│   ├── rules/           Hard constraints (4 principles)
│   ├── strong-opinions/ Default path (36 principles)
│   └── conventions/     Stylistic preferences (19 principles)
├── commands/            13 slash command specs
├── agents/              14 specialist agent prompts
├── agent-rules/         13 agent behavior guidelines
├── templates/           10 standardized output templates for agent artifacts
├── hooks/               9 automation hooks
├── flows/               11 workflow definitions + 12 reusable fragments
│   └── fragments/       Composable state groups + consultation fragments
├── mcp-server/          TypeScript MCP server (24 tools)
│   └── src/
│       ├── index.ts     Server + tool registration
│       ├── constants.ts Shared constants (layer centrality, extensions, extractSummary)
│       ├── matcher.ts   Principle matching logic
│       ├── parser.ts    Principle parsing and frontmatter extraction
│       ├── schema.ts    Zod input validation schemas
│       ├── tools/       Individual tool implementations
│       ├── graph/       Dependency graph: scanner, import/export parsers, insights, query cache, priority scoring
│       ├── drift/       JSONL stores, analyzer, PR tracking
│       ├── utils/       Atomic writes, config loader, error helpers, ID generation
│       └── __tests__/   Tests
├── cursor-extension/    VS Code / Cursor extension (Canon Dashboard)
│   └── src/
│       ├── extension.ts       Extension activation, active file tracking
│       ├── constants.ts       Shared paths and timeouts
│       ├── messages.ts        Typed extension ↔ webview message protocol
│       ├── dashboard-panel.ts Webview panel, message-based data push, file watching
│       ├── services/          Graph data loading, git integration
│       ├── webview/           Svelte app: stores, components, D3 graph, filters
│       └── __tests__/         Tests
└── skills/canon/        Skill definition + references
```

## Data Files

All Canon data lives in `.canon/` in your project root:

| File | Purpose | Written by |
|------|---------|-----------|
| `principles/{rules,strong-opinions,conventions}/*.md` | Principle definitions | `/canon:init`, canon-writer agent |
| `CONVENTIONS.md` | Project conventions | `/canon:init` (auto-detected), `/canon:learn --apply`, or edit directly |
| `config.json` | Project configuration | `/canon:init` |
| `reviews.jsonl` | Review results | `report` MCP tool (type=review) |
| `decisions.jsonl` | Intentional deviations | `report` MCP tool (type=decision) |
| `patterns.jsonl` | Observed patterns | `report` MCP tool (type=pattern) |
| `learning.jsonl` | Learning history | `/canon:learn` |
| `LEARNING-REPORT.md` | Latest learning report | `/canon:learn` |
| `workspaces/{branch}/` | Branch-scoped agent workspace (research, decisions, plans, logs) | Build pipeline (orchestrator) |
| `plans/{task-slug}/` | Task plans and build artifacts inside the workspace | Build pipeline |
| `history/{branch}/` | Archived workspace artifacts (decisions, notes, summary) | `/canon:clean --archive` |
| `graph-data.json` | Codebase dependency graph with insights | `codebase_graph` MCP tool |
| `reverse-deps.json` | Reverse dependency index (who imports each file) | `codebase_graph` MCP tool |
| `summaries.json` | One-line file summaries for dashboard tooltips | `store_summaries` MCP tool |
| `pr-reviews.jsonl` | PR review history | `get_pr_review_data` MCP tool |
| `dashboard-state.json` | Dashboard selection state (ephemeral) | Canon Dashboard extension |

## Privacy

Canon itself does not collect, transmit, or share any data. There is no telemetry, no analytics, and no background network calls to external services from Canon. All data — principles, reviews, decisions, and patterns — is stored locally in your project's `.canon/` directory and never leaves your machine. Optional workflows that you run alongside Canon (for example, using `gh pr diff` via the GitHub CLI for PR review) may make their own network requests according to those tools' behavior.
