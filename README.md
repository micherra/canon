# Canon

Canon is an engineering principles system and multi-agent build harness for Claude Code. You describe what you want in natural language — Canon classifies your intent, picks the right workflow, and runs specialist agents to research, design, implement, test, review, and ship. Your principles are loaded and enforced throughout. Canon is invisible; from your perspective, you just talk to Claude.

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

### Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 24+

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

This scans your source files to auto-detect project conventions, creates `.canon/principles/` with 59 starter principles, generates a `CONVENTIONS.md` pre-populated for your stack, and integrates with your `CLAUDE.md`.

## How It Works

You describe what you want. Canon classifies your intent, picks the appropriate workflow, and runs specialist agents to get it done — research, design, implement, test, review, ship. Principles are loaded and enforced at each phase. Your Claude session acts as the orchestrator; Canon never spawns a separate orchestrator subagent.

### Severity model

Canon principles operate on three enforcement levels:

| Severity | Meaning | Enforcement |
|----------|---------|-------------|
| **rule** (4) | Hard constraint | Blocks commits. Reviewer verdict: BLOCKING. |
| **strong-opinion** (36) | Default path | Warns. Deviations require justification. |
| **convention** (19) | Stylistic preference | Noted in reports. Tracked for drift. |

Principles are matched to files by architectural layer and path pattern. Rules are always loaded first; agents self-review against matched principles before presenting output.

## Using Canon

### Natural language

Just describe what you want. Canon classifies your intent and routes to the right workflow:

| What you say | What happens |
|-------------|-------------|
| "Add an order creation endpoint with Zod validation" | Feature workflow: research → design → implement → test → review → ship |
| "The login page is broken" | Hotfix or quick-fix depending on urgency |
| "Refactor the auth middleware" | Refactor workflow: analyze → implement with test verification → review → ship |
| "Migrate from Express to Hono" | Migration workflow: research → design → staged implementation → security → review → ship |
| "How does the payment system work?" | Explore workflow: parallel research → synthesized analysis report |
| "Improve test coverage for the API layer" | Test-gap workflow: scan coverage → write tests → fix revealed bugs → review |
| "Review my changes" | Code review against Canon principles |
| "Scan for vulnerabilities" | Security audit workflow |
| "What's the status?" | Health dashboard: principle counts, review scorecard, build progress |
| "Create a new principle about error handling" | Interactive principle authoring |

Build modifiers can be expressed naturally: "skip research", "just plan don't implement", "this is a large task", "use the quick-fix flow".

### Slash commands

| Command | What it does |
|---------|-------------|
| `/canon:init` | Set up Canon in your project — scans source files to auto-detect conventions |
| `/canon:learn` | Analyze review data to suggest principle and convention improvements |
| `/canon:adopt` | Scan for coverage gaps, produce a remediation plan, optionally auto-fix rule violations |
| `/canon:check` | Lightweight pre-commit principle compliance check on staged or specified files |
| `/canon:pr-review` | Review a PR or branch against principles with layer-parallel fan-out |
| `/canon:edit-principle` | Edit an existing principle — change severity, scope, tags, or body |
| `/canon:test-principle` | Verify a principle is detected during review by generating a violation |
| `/canon:doctor` | Diagnose setup issues — broken frontmatter, duplicate IDs, MCP server health (11 checks) |
| `/canon:clean` | Clean up workspace artifacts — optionally archive decisions and notes to project history |

## Workflows

Canon auto-selects the right workflow based on what you're doing. You can also steer it: "use the quick-fix flow", "this is a large task".

| Workflow | When to use |
|----------|------------|
| **hotfix** | Production incidents, urgent fixes |
| **quick-fix** | Small bug fixes (1-3 files) |
| **refactor** | Restructuring, renaming, extracting |
| **feature** | New features (4-10 files) |
| **migrate** | Upgrades, library swaps, version bumps |
| **deep-build** | Large cross-cutting changes (10+ files) |
| **explore** | Research questions, investigations (no implementation) |
| **test-gap** | Coverage improvement |
| **review-only** | Review existing changes or a PR |
| **security-audit** | Dedicated security scanning |
| **adopt** | Onboard Canon to a repo — scan violations and auto-fix |

**User checkpoints** pause after planning to show you what's planned and collect your feedback. Approve to proceed, or share thoughts — Canon classifies your response semantically (no magic keywords needed) and routes revisions back to the planning phase with your notes attached.

## Principles

Principles are Canon's core building block. They're markdown files with YAML frontmatter that tell agents what rules, preferences, and conventions to apply.

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
| `id` | yes | Unique kebab-case identifier. A project-local entry with the same `id` overrides the built-in one. |
| `title` | yes | Human-readable name shown in review output and dashboards. |
| `severity` | yes | One of `rule`, `strong-opinion`, or `convention`. |
| `scope.layers` | no | Architectural layers this applies to: `api`, `ui`, `domain`, `data`, `infra`, `shared`. Inferred from file paths. Empty = all layers. |
| `scope.file_patterns` | no | Glob patterns to restrict to specific files (e.g. `"**/*.tf"`, `"src/db/**"`). |
| `tags` | no | Labels for filtering and grouping (e.g. `security`, `testing`). |
| `archived` | no | Set `true` to disable without deleting. Archived entries are skipped by the matcher. |

### How matching works

When you edit a file, Canon infers its architectural layer from the path (e.g. `src/routes/` → `api`, `src/components/` → `ui`) and loads principles whose `scope.layers` and `scope.file_patterns` match. Results are sorted rules-first, then strong-opinions, then conventions — capped at `max_principles_per_review` per context (default 10). Project-local principles in `.canon/principles/` override plugin principles with the same ID.

### Where principles live

| Location | What lives there |
|----------|-----------------|
| `principles/rules/` | Hard constraints that block commits |
| `principles/strong-opinions/` | Default paths that warn on deviation |
| `principles/conventions/` | Stylistic preferences tracked for drift |
| `agent-rules/` | Behavioral guidelines for Canon's agents (not application code) |

### Writing your own

Place files under `.canon/principles/{rules,strong-opinions,conventions}/` for project-local principles. Use guided authoring or create files directly:

- "Create a new principle about error handling" — Canon spawns an interactive author agent
- "Create a new agent-rule about code review behavior" — same flow, agent-rule mode

## The Learning Loop

Canon learns from your builds. As workflows run, drift data is persisted automatically via **flow effects** — declarative hooks on flow states that parse agent artifacts and write to `.canon/`:

```
reviews.jsonl      — review results (violations, honored, scores, verdict)
```

Review results are captured each time a review state completes. No manual logging needed — the data accumulates as you build.

Run `/canon:learn` to analyze this data across four dimensions:

1. **Drift-driven severity** — Suggest promotions and demotions based on compliance data
2. **Task convention promotion** — Promote recurring task conventions to project level
3. **Convention graduation** — Identify mature conventions ready to become principles
4. **Staleness detection** — Flag conventions the codebase no longer follows

Use `--apply` to walk through suggestions interactively. Dismissed suggestions are permanently suppressed — Canon won't re-suggest them.

## Canon Dashboard

The Canon Dashboard is an interactive dependency graph visualization served as an MCP App. It is supported in Claude Desktop and other MCP App-compatible clients.

**What it shows:**

- **Interactive dependency graph** — Sigma.js/WebGL force-directed layout with nodes colored by architectural layer
- **Git overlay** — Changed files pulse on the graph so you can see what's in flux
- **Violation context** — Violations enriched with fan-in, hub status, cycle membership, and impact scores
- **Search and filter** — Find files by name; filter by layer, changed status, violations, or PR review scope

## Configuration

All configuration lives in `.canon/config.json`. Every key is optional — Canon uses sensible defaults.

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
| `source_dirs` | — | Directories to scan for the codebase graph. |
| `max_file_lines` | 500 | Line threshold for the large file guard. Files exceeding this trigger a warning on write/edit. |
| `layers` | See above | Maps layer names to directory patterns for architectural layer inference. Override to match your project's structure. |
| `review.max_principles_per_review` | 10 | Cap for principles loaded during code generation. Rules are always included first. |
| `review.max_review_principles` | 15 | Cap for principles loaded during reviews. Rules are never dropped — total may exceed cap when many rules match. |

Run `/canon:doctor` to check for configuration issues.

**Automation hooks:** Canon includes 8 hooks that run automatically: secrets checking on pre-commit, a review guard before push, large file warnings, data file compaction checks, a nudge to run `/canon:learn` after reviews accumulate, principle injection before edits, a destructive git guard, and a workspace lock guard. All are configurable.

## Data & Privacy

All Canon data lives in `.canon/` in your project root:

| File | Purpose | Written by |
|------|---------|-----------|
| `principles/{rules,strong-opinions,conventions}/*.md` | Principle definitions | `/canon:init`, canon-writer agent |
| `CONVENTIONS.md` | Project conventions | `/canon:init`, `/canon:learn --apply`, or edit directly |
| `config.json` | Project configuration | `/canon:init` |
| `reviews.jsonl` | Review results (violations, scores, verdicts) | Flow effects (review states) |
| `LEARNING-REPORT.md` | Latest learning report | `/canon:learn` |
| `workspaces/{branch}/` | Branch-scoped agent workspace (research, decisions, plans, logs) | Build pipeline |
| `history/{branch}/` | Archived workspace artifacts | `/canon:clean --archive` |
| `graph-data.json` | Codebase dependency graph | Dashboard / `codebase_graph` MCP tool |
| `reverse-deps.json` | Reverse dependency index | `codebase_graph` MCP tool |
| `summaries.json` | File summaries for dashboard tooltips | `store_summaries` MCP tool |
| `dashboard-state.json` | Dashboard selection state (ephemeral) | Canon Dashboard (MCP App) |

**Privacy:** Canon does not collect, transmit, or share any data. There is no telemetry, no analytics, and no background network calls to external services from Canon. All data — principles, reviews, decisions, and patterns — is stored locally in your project's `.canon/` directory and never leaves your machine. Optional workflows you run alongside Canon (for example, using `gh pr diff` via the GitHub CLI) may make their own network requests according to those tools' behavior.

## Architecture

Canon uses 13 specialist agents (researcher, architect, implementor, tester, reviewer, security, fixer, learner, writer, shipper, scribe, guide, inspector) orchestrated by your Claude session. Your Claude session IS the orchestrator — not a separate subagent. Builds run as state machines defined in flow files, with shared state in `.canon/workspaces/`. Canon uses MCP tools under the hood to manage workflow state, load principles, and track drift.

For details on the orchestration protocol, see `agents/canon-orchestrator.md`. For contributing, see the project structure in `CONTRIBUTING.md`.
