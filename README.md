# Canon

Engineering principles as code. Canon gives Claude Code a structured set of principles that are loaded before code generation, enforced during review, and refined through a data-driven learning loop.

> **Note:** Canon is a work in progress. The core enforcement loop, learning system, and MCP tools are functional, but rough edges remain. Principle coverage is opinionated and likely needs tuning for your stack. Expect breaking changes as the plugin format and MCP protocol evolve. Feedback and contributions welcome — open an issue or PR.

## Installation

Canon is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins). Install it directly from GitHub:

```bash
# Install the plugin
claude plugin add micherra/canon

# Then initialize in your project
/canon:init
```

Or clone and install locally:

```bash
git clone https://github.com/micherra/canon.git
claude plugin add ./canon
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
| `/canon:init` | Set up Canon in your project |
| `/canon:build` | Full pipeline: research → architect & plan → implement → test → security → review |
| `/canon:review` | Review code changes against principles |
| `/canon:status` | Health dashboard — principle counts, review stats, actionable suggestions |
| `/canon:drift` | Compliance trends and analytics from review history |
| `/canon:learn` | Analyze data to suggest principle and convention improvements |
| `/canon:list` | Browse and filter principles |
| `/canon:check` | Quick inline principle check for a file |
| `/canon:explain` | Deep-dive on a principle with real codebase examples |
| `/canon:conventions` | View and manage project conventions |
| `/canon:adopt` | Scan for coverage gaps and produce a remediation plan |
| `/canon:new-principle` | Author a new principle via guided interview |
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
| `canon-principle-writer` | Author new principles via guided interview |

## Hooks

Canon includes 3 automation hooks:

- **Pre-commit secrets check** — Blocks commits containing hardcoded secrets (API keys, private keys, connection strings)
- **Learn nudge** — Suggests `/canon:learn` after 10+ reviews accumulate
- **Skill activation** — Ensures Canon loads before code generation tasks

## Project Structure

```
canon/
├── principles/          47 engineering principles (rule / strong-opinion / convention)
├── commands/canon/      13 slash commands
├── agents/              9 specialist agents
├── agent-rules/         8 agent behavior guidelines
├── hooks/               3 automation hooks
├── mcp-server/          TypeScript MCP server (5 tools)
│   └── src/
│       ├── index.ts     Server + tool registration
│       ├── matcher.ts   Principle matching logic
│       ├── tools/       Individual tool implementations
│       └── drift/       Store, analyzer, reporter
└── skills/canon/        Skill definition + references
```

## Principles

Each principle is a markdown file with YAML frontmatter:

```yaml
---
id: validate-at-trust-boundaries
title: Validate at Trust Boundaries
severity: rule
scope:
  layers: [api]
tags: [security, validation]
---
```

Principles are matched to your code by architectural layer (inferred from file path) and file patterns. Rules are loaded first, then strong-opinions, then conventions — max 10 per context.

## Data Files

All Canon data lives in `.canon/` in your project root:

| File | Purpose | Written by |
|------|---------|-----------|
| `principles/*.md` | Principle definitions | `/canon:init`, `/canon:new-principle` |
| `CONVENTIONS.md` | Project conventions | `/canon:conventions`, `/canon:learn --apply` |
| `config.json` | Project configuration | `/canon:init` |
| `reviews.jsonl` | Review results | `report` MCP tool (type=review) |
| `decisions.jsonl` | Intentional deviations | `report` MCP tool (type=decision) |
| `patterns.jsonl` | Observed patterns | `report` MCP tool (type=pattern) |
| `learning.jsonl` | Learning history | `/canon:learn` |
| `LEARNING-REPORT.md` | Latest learning report | `/canon:learn` |
| `plans/*/` | Build artifacts per task | `/canon:build` |

## Roadmap

Canon is under active development. Here's what's working and what's next:

**Working now:**
- Principle matching by architectural layer and file patterns
- Full build pipeline with 9 specialist agents
- Review enforcement with three-tier severity
- Drift tracking and compliance analytics
- Learning loop with six analysis dimensions
- 5 MCP tools for agent integration
- 3 automation hooks (secrets detection, learn nudge, skill activation)

**Coming soon:**
- Interactive `--apply` mode for learning suggestions
- Principle dependency graph (e.g., "if you adopt X, also consider Y")
- Per-team principle overrides for monorepos
- CI integration (run Canon reviews in GitHub Actions)
- Shareable principle packs (import curated sets for React, Go, etc.)

**Known limitations:**
- Principle matching relies on file path heuristics for architectural layer detection — may need tuning for non-standard project structures
- The MCP server runs via `tsx` from TypeScript source — no build step needed during development
- Learning suggestions require sufficient data (10+ reviews) to be meaningful
- Hook scripts assume bash — Windows support is untested

If you run into issues or have ideas, [open an issue](https://github.com/micherra/canon/issues).
