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
- Node.js 18+ (for the MCP server)

## Cursor-only Setup (no Claude Code plugin)

Canon’s full build/review pipeline can run in Cursor without installing the Claude Code plugin.

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

On first use, Cursor will start Canon’s MCP server and auto-run `npm install` inside `mcp-server/` if dependencies are missing.

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

This creates `.canon/principles/` with 47 starter principles, a `CONVENTIONS.md` template, and integrates with your `CLAUDE.md`. Ask Canon for status to verify.

## How It Works

Canon operates on a three-tier severity model:

| Severity | Meaning | Enforcement |
|----------|---------|-------------|
| **rule** (4) | Hard constraint | Blocks commits. Reviewer verdict: BLOCKING. |
| **strong-opinion** (28) | Default path | Warns. Deviations require justification via `report` tool. |
| **convention** (15) | Stylistic preference | Noted in reports. Tracked for drift. |

When you write code, Canon automatically loads principles matched to your file's architectural layer and path patterns. Agents self-review against them before presenting output.

## Commands & Natural Language

Canon uses a two-tier interface: **natural language** for common workflows and **slash commands** for specialized utilities.

### Natural Language (via Canon Intake)

Just describe what you want. Canon's intake agent classifies your intent and routes to the right agent:

| What you say | What happens |
|-------------|-------------|
| "Add an order creation endpoint with Zod validation" | Build pipeline: triage → tier detection → research → architect → implement → test → review |
| "Review my changes" / "Review PR 42" | Code review against Canon principles (supports staged, branch, PR, or file scoping) |
| "Scan for vulnerabilities" | Security audit flow |
| "What's the status?" | Health dashboard — principle counts, review scorecard, build progress |
| "Create a new principle about error handling" | Interactive principle authoring via canon-writer |
| "Create a new agent-rule" | Interactive agent-rule authoring via canon-writer |
| "Skip tests, this is a small task" | Build with flags parsed from natural language |

Build modifiers can be expressed naturally: "skip research", "just plan don't implement", "this is a large task", "use the quick-fix flow".

### Slash Commands (10 utilities)

| Command | What it does |
|---------|-------------|
| `/canon:init` | Set up Canon in your project — auto-detects codebase conventions |
| `/canon:learn` | Analyze data to suggest principle and convention improvements |
| `/canon:list` | Browse and filter principles |
| `/canon:explain` | Deep-dive on a principle with real codebase examples |
| `/canon:adopt` | Scan for coverage gaps and produce a remediation plan |
| `/canon:edit-principle` | Edit an existing principle — change severity, scope, tags, or body |
| `/canon:test-principle` | Verify a principle is detected during review by generating a violation |
| `/canon:toggle-archive` | Archive or unarchive a principle — archived entries are skipped by the matcher |
| `/canon:doctor` | Diagnose setup issues — broken frontmatter, duplicate IDs, MCP server health |
| `/canon:clean` | Clean up workspace artifacts — optionally archive decisions and notes to project history |

## The Build Pipeline

Canon's build pipeline scales dynamically to task size:

```
Small (1-3 files)     →  implement → review → log
Medium (4-10 files)   →  architect & plan → implement → test → review → log
Large (10+ files)     →  research → architect & plan → implement → test → security → review → log
```

Each phase is handled by a specialized agent. The orchestrator stays thin — it spawns agents, passes context, and manages the workflow.

## Agent Workspaces

Canon agents share context through **branch-scoped workspaces** — structured folders where agents write research, decisions, logs, and plans that other agents can read.

```
.canon/workspaces/{sanitized-branch}/
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

1. When a build starts, the orchestrator creates a workspace for the current branch
2. Each agent reads and writes to scoped areas — the researcher writes to `research/`, the architect writes to `decisions/` and `plans/`, etc.
3. All agents append to `log.jsonl` for a shared activity timeline
4. The architect owns `context.md` — a living document with key decisions and patterns that downstream agents read

### Agent permissions

Agents have scoped read/write access to preserve existing isolation principles:
- **Reviewer never reads research or plans** — cold review is preserved
- **Implementor only reads its own plan** + shared context — fresh context is preserved
- **Researcher never reads other researchers** — scoped research is preserved

### Templates

Standardized output templates in the plugin's `templates/` directory ensure consistent structure:
- `research-finding.md` — structured format for researcher output
- `design-decision.md` — problem/options/chosen/rationale for architectural decisions
- `implementation-log.md` — standardized task summary with compliance declaration
- `review-checklist.md` — structured review report with verdict and scores
- `session-context.md` — living shared context document format

### Lifecycle

Workspaces are ephemeral by default — scoped to a branch's active development:
- **Create**: Automatically when a build starts
- **Archive**: Run `/canon:clean --archive` to save decisions and notes to `.canon/history/`
- **Delete**: Run `/canon:clean` to remove workspace artifacts after branch merge

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

## MCP Tools

Canon exposes 11 tools via its MCP server for agents to use during normal work:

| Tool | Purpose |
|------|---------|
| `get_principles` | Get principles relevant to a file/layer context, enriched with graph metrics |
| `list_principles` | Browse the full principle index with filters |
| `review_code` | Get matched principles for code review — auto-injects graph-derived principles for layer violations and cycles |
| `get_compliance` | Query compliance stats and trend for a specific principle |
| `report` | Log a decision, pattern, or review result for drift tracking and the learning loop |
| `get_pr_review_data` | Get PR file list, layers, and graph-aware priority scores |
| `codebase_graph` | Generate dependency graph with compliance overlay, insights, and reverse-dep index |
| `get_file_context` | Get file content, imports, dependents, violations, and graph metrics (fan-in, hub status, cycles) |
| `store_summaries` | Persist file summaries incrementally for dashboard display |
| `get_dashboard_selection` | Get selected node context with graph metrics and downstream impact |

## Agents

Canon uses 10 specialist agents, each with a focused role:

| Agent | Role |
|-------|------|
| `canon-researcher` | Investigate codebase, architecture, domain, and risk |
| `canon-architect` | Design approach, graph-informed wave assignment, break into task plans |
| `canon-implementor` | Write code against plans and principles |
| `canon-tester` | Generate integration tests |
| `canon-security` | Scan for vulnerabilities |
| `canon-reviewer` | Two-stage review: compliance + graph-aware code quality |
| `canon-refactorer` | Fix violations using graph-aware caller discovery |
| `canon-learner` | Analyze patterns and suggest principle refinements |
| `canon-writer` | Create and edit principles, conventions, and agent-rules |

### Graph-Aware Agents

The reviewer, refactorer, and architect agents are graph-aware — they use the codebase dependency graph to make better decisions:

- **Reviewer**: When `review_code` returns `graph_context`, the reviewer factors in fan-in (blast radius), cycle membership, and layer boundary violations. Violations in hub files are flagged as higher-impact.
- **Refactorer**: Calls `get_file_context` to discover callers via the dependency graph before refactoring. High fan-in files get extra caution — prefer internal-only changes that preserve the external API.
- **Architect**: Uses `get_file_context` to verify wave assignments against the real dependency graph. Files in dependency cycles are placed in the same wave.

## Hooks

Canon includes 6 automation hooks:

- **Pre-commit secrets check** — Blocks commits containing hardcoded secrets (API keys, private keys, connection strings)
- **Pre-push review guard** — Warns before pushing if no Canon review covers the unpushed commits
- **Large file guard** — Warns before writing or editing files that exceed a line threshold (default 500, configurable via `max_file_lines` in `.canon/config.json`)
- **Compaction check** — Warns when `.jsonl` data files or `CONVENTIONS.md` grow past thresholds
- **Learn nudge** — Suggests `/canon:learn` after 10+ reviews accumulate
- **Principle loading** — Ensures Canon principles are loaded before code generation tasks

## Project Structure

```
canon/
├── principles/          47 engineering principles organized by severity
│   ├── rules/           Hard constraints (4 principles)
│   ├── strong-opinions/ Default path (28 principles)
│   └── conventions/     Stylistic preferences (15 principles)
├── commands/            10 slash commands
├── agents/              10 specialist agents
├── agent-rules/         10 agent behavior guidelines
├── templates/           5 standardized output templates for agent artifacts
├── hooks/               6 automation hooks
├── flows/               5 predefined workflow YAML files
├── mcp-server/          TypeScript MCP server (11 tools)
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

## The Canon Template

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
| `tags` | no | Freeform labels for filtering and grouping (e.g. `security`, `testing`, `agent-behavior`). Used by `/canon:list` and the `list_principles` MCP tool. |
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
- Ask Canon to create a new principle — intake spawns the canon-writer in new-principle mode
- Ask Canon to create a new agent-rule — intake spawns the canon-writer in new-agent-rule mode

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

## Privacy

Canon itself does not collect, transmit, or share any data. There is no telemetry, no analytics, and no background network calls to external services from Canon. All data — principles, reviews, decisions, and patterns — is stored locally in your project's `.canon/` directory and never leaves your machine. Optional workflows that you run alongside Canon (for example, using `gh pr diff` via the GitHub CLI for PR review) may make their own network requests according to those tools' behavior.

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
| `history/{branch}/` | Archived workspace artifacts (decisions, notes, summary) | `/canon:clean --archive` |
| `graph-data.json` | Codebase dependency graph with insights | `codebase_graph` MCP tool |
| `reverse-deps.json` | Reverse dependency index (who imports each file) | `codebase_graph` MCP tool |
| `summaries.json` | One-line file summaries for dashboard tooltips | `store_summaries` MCP tool |
| `pr-reviews.jsonl` | PR review history | `get_pr_review_data` MCP tool |
| `dashboard-state.json` | Dashboard selection state (ephemeral) | Canon Dashboard extension |
