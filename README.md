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

## Quick Start

```bash
# In your project directory
/canon:init
```

This creates `.canon/principles/` with 47 starter principles, a `CONVENTIONS.md` template, and integrates with your `CLAUDE.md`. Run `/canon:status` to verify.

## How It Works

Canon operates on a three-tier severity model:

| Severity | Meaning | Enforcement |
|----------|---------|-------------|
| **rule** (4) | Hard constraint | Blocks commits. Reviewer verdict: BLOCKING. |
| **strong-opinion** (28) | Default path | Warns. Deviations require justification via `report` tool. |
| **convention** (15) | Stylistic preference | Noted in reports. Tracked for drift. |

When you write code, Canon automatically loads principles matched to your file's architectural layer and path patterns. Agents self-review against them before presenting output.

## Commands

| Command | What it does |
|---------|-------------|
| `/canon:init` | Set up Canon in your project — auto-detects codebase conventions |
| `/canon:build` | Full pipeline: research → architect & plan → implement → test → security → review |
| `/canon:review` | Review code changes against principles |
| `/canon:status` | Health dashboard — principle counts, review scorecard, actionable suggestions |
| `/canon:learn` | Analyze data to suggest principle and convention improvements |
| `/canon:list` | Browse and filter principles |
| `/canon:explain` | Deep-dive on a principle with real codebase examples |
| `/canon:adopt` | Scan for coverage gaps and produce a remediation plan |
| `/canon:new-principle` | Author a new principle via guided interview |
| `/canon:new-agent-rule` | Author a new agent-rule via guided interview |
| `/canon:edit-principle` | Edit an existing principle — change severity, scope, tags, or body |
| `/canon:test-principle` | Verify a principle is detected during review by generating a violation |
| `/canon:toggle-archive` | Archive or unarchive a principle — archived entries are skipped by the matcher |
| `/canon:doctor` | Diagnose setup issues — broken frontmatter, duplicate IDs, MCP server health |
| `/canon:security` | Standalone security scan |

## The Build Pipeline

`/canon:build` scales dynamically to task size:

```
Small (1-3 files)     →  implement → review → log
Medium (4-10 files)   →  architect & plan → implement → test → review → log
Large (10+ files)     →  research → architect & plan → implement → test → security → review → log
```

Each phase is handled by a specialized agent. The orchestrator stays thin — it spawns agents, passes context, and manages the workflow.

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

Canon exposes 5 tools via its MCP server for agents to use during normal work:

| Tool | Purpose |
|------|---------|
| `get_principles` | Get principles relevant to a file/layer context |
| `list_principles` | Browse the full principle index with filters |
| `review_code` | Get matched principles for a code snippet to evaluate |
| `get_compliance` | Query compliance stats and trend for a specific principle |
| `report` | Log a decision, pattern, or review result for drift tracking and the learning loop |

## Agents

Canon uses 9 specialist agents, each with a focused role:

| Agent | Role |
|-------|------|
| `canon-researcher` | Investigate codebase, architecture, domain, and risk |
| `canon-architect` | Design approach, extract task conventions, break into task plans |
| `canon-implementor` | Write code against plans and principles |
| `canon-tester` | Generate integration tests |
| `canon-security` | Scan for vulnerabilities |
| `canon-reviewer` | Two-stage review: compliance + code quality |
| `canon-refactorer` | Fix violations and improve code |
| `canon-learner` | Analyze patterns and suggest principle refinements |
| `canon-writer` | Create and edit principles, conventions, and agent-rules |

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
├── commands/            15 slash commands
├── agents/              9 specialist agents
├── agent-rules/         8 agent behavior guidelines
├── hooks/               6 automation hooks
├── mcp-server/          TypeScript MCP server (5 tools)
│   └── src/
│       ├── index.ts     Server + tool registration
│       ├── matcher.ts   Principle matching logic
│       ├── parser.ts    Principle parsing and frontmatter extraction
│       ├── schema.ts    Zod input validation schemas
│       ├── tools/       Individual tool implementations
│       ├── drift/       Store, analyzer, reporter
│       └── __tests__/   Tests
└── skills/canon/        Skill definition + references
```

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

Use the guided commands or create files directly:
- `/canon:new-principle` — walks you through authoring a new principle
- `/canon:new-agent-rule` — walks you through authoring a new agent-rule

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

In `.canon/config.json`:

```json
{
  "review": {
    "max_principles_per_review": 10,
    "max_review_principles": 15
  }
}
```

| Key | Default | What it controls |
|-----|---------|-----------------|
| `review.max_principles_per_review` | 10 | Cap for `get_principles` (used during code generation) |
| `review.max_review_principles` | 15 | Cap for `review_code` (used during reviews) |

Run `/canon:doctor` to check for context bloat issues.

## Data Files

All Canon data lives in `.canon/` in your project root:

| File | Purpose | Written by |
|------|---------|-----------|
| `principles/{rules,strong-opinions,conventions}/*.md` | Principle definitions | `/canon:init`, `/canon:new-principle` |
| `CONVENTIONS.md` | Project conventions | `/canon:init` (auto-detected), `/canon:learn --apply`, or edit directly |
| `config.json` | Project configuration | `/canon:init` |
| `reviews.jsonl` | Review results | `report` MCP tool (type=review) |
| `decisions.jsonl` | Intentional deviations | `report` MCP tool (type=decision) |
| `patterns.jsonl` | Observed patterns | `report` MCP tool (type=pattern) |
| `learning.jsonl` | Learning history | `/canon:learn` |
| `LEARNING-REPORT.md` | Latest learning report | `/canon:learn` |
| `plans/*/` | Build artifacts per task | `/canon:build` |
