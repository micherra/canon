# Canon

Canon is a Claude Code plugin that turns Claude Code into an orchestrated, multi-agent build system governed by engineering principles. You describe what you want — Canon classifies your intent, selects the right workflow, coordinates specialist agents through research, design, implementation, testing, and review, and enforces your principles throughout. From your side, you just talk to Claude.

---

## Why Canon

Most AI coding workflows are capable but unstructured. Without Canon, common patterns emerge:

- **Agents don't follow your standards.** Without explicit principles, agents generate code that works but doesn't match your team's patterns or quality bar. Every conversation starts from scratch.
- **Complex tasks get one shot.** Ask an agent to "refactor the auth system" and you get a single attempt — no research, no design review, no plan approval before code is written.
- **Reviews happen too late.** Code is written first, reviewed after. Violations are fixed reactively instead of prevented during implementation.
- **Knowledge doesn't accumulate.** Conversations are stateless. Decisions, conventions, and review findings disappear between sessions.
- **One approach for everything.** A quick bug fix and a large migration get the same treatment: one prompt, one agent, one shot.

Canon addresses each of these. You define principles — rules, opinions, and conventions — and Canon loads the relevant ones automatically for every task. Complex work is broken into phases (research → design → implement → test → review) with specialist agents at each step. Principles are enforced during implementation, not just at review. Review findings accumulate across sessions, and `/canon:learn` surfaces improvements. Workflows scale from a quick fast-path to a multi-wave epic, selected automatically based on task scope.

---

## Installation

Canon is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins). Install it from GitHub:

```bash
# Add the marketplace source
/plugin marketplace add micherra/canon

# Install the plugin
/plugin install canon@micherra-canon
```

Or install from a local clone:

```bash
git clone https://github.com/micherra/canon.git
/plugin marketplace add ./canon
/plugin install canon@canon
```

### Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

---

## Initialization

Run this once inside your project:

```bash
/canon:init
```

Canon creates a `.canon/` directory with:

- **Principles** — a starter set of 56 built-in principles across three severity tiers, ready to customize
- **CONVENTIONS.md** — project conventions file for implementors to read
- **config.json** — layer mappings and configuration with sensible defaults

After setup, Canon runs an adoption scan to find any existing principle violations in your codebase. Pass `--no-scan` to skip the scan if you'd rather run it later.

From this point on, Canon loads relevant principles automatically whenever you build, review, or check code.

---

## Principles

Principles are the core of Canon. They are markdown files that tell agents what rules, preferences, and conventions to apply. Canon ships with 56 built-in principles (5 rules, 34 strong-opinions, 17 conventions) covering security, architecture, testing, and code design. After init, your project's active principles live in `.canon/principles/`.

A principle looks like this:

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

All external input must be validated at trust boundaries — API routes, webhook
handlers, queue consumers. Reject invalid input early; never pass unvalidated
data deeper into the system.
```

### Severity levels

| Severity | Meaning |
|----------|---------|
| `rule` | Hard constraint. Violations in reviews are BLOCKING. |
| `strong-opinion` | Default path. Deviations require justification. |
| `convention` | Stylistic preference. Tracked for drift, doesn't block. |

### Creating and editing principles

Just ask:

> "Create a new principle about error handling"

Canon spawns an interactive author agent that walks you through it. You can also run `/canon:edit-principle` to modify an existing one, or edit the markdown files directly under `.canon/principles/`.

Principles are matched to files by architectural layer and path pattern. When you touch `src/routes/orders.ts`, Canon loads principles scoped to the `api` layer — plus any that match the file path — rules first, then strong-opinions, then conventions.

Project-local principles (in `.canon/`) override any built-in principle with the same `id`.

---

## Your First Build

Once Canon is initialized, just describe what you want:

> "Add an order creation endpoint with Zod validation"

Canon classifies your intent, picks an appropriate workflow, and drives specialist agents through research, design, implementation, testing, and review. You see progress updates in plain language. Before code is written, Canon pauses at a user checkpoint to show you what's planned and get your approval.

No flags, no flow names, no configuration needed. Canon auto-detects the right approach based on scope.

### Examples

| What you say | What happens |
|-------------|-------------|
| "The login page is broken" | Fast-path: implement, verify, done |
| "Refactor the auth middleware" | Refactor flow: restructure with test verification and review |
| "Migrate from Express to Hono" | Migrate flow: research, staged migration with rollback planning, security check, review |
| "Rebuild the notification system" | Epic flow: parallel research, adaptive wave implementation, test, security, review |
| "How does the payment system work?" | Explore flow: research and synthesize — no code changes |
| "Improve test coverage for the API layer" | Test-gap flow: scan coverage gaps, write tests, review |

You can steer Canon naturally: "skip research", "just plan, don't implement", "use a quick fix".

---

## How It Works

### The Orchestrator

Canon's entry point is a Claude Code skill (`skills/canon/`) that activates for every user message. It acts as a pure dispatcher: it never writes code, runs tests, or produces artifacts itself. It classifies intent, selects a flow, and drives the state machine by calling Canon's MCP tools.

### Flows and State Machines

A flow is a YAML-defined state machine. Each state names an agent to spawn and a set of transitions to other states. The orchestrator walks the graph — calling `load_flow`, then `init_workspace`, then repeatedly calling `drive_flow` to advance one step at a time.

**Available flows:**

| Flow | Tier | When Canon picks it |
|------|------|---------------------|
| `fast-path` | Small | Bug fix, small change, 1–3 files |
| `feature` | Medium | New feature, 4–10 files |
| `refactor` | Medium | Behavior-preserving restructuring |
| `migrate` | Medium | Dependency migration, "move to X" |
| `epic` | Large | Cross-cutting change, 10+ files; uses adaptive waves |
| `explore` | Research | "How does X work?" — no code changes |
| `test-gap` | Testing | Analyze coverage gaps, write tests |
| `review-only` | Review | Review a PR or branch without implementing |
| `security-audit` | Security | Dedicated security audit |
| `adopt` | Adoption | Scan for violations and auto-fix (invoked by `init`) |

Flows are composed from reusable state groups called **fragments** (`flows/fragments/`): `context-sync`, `review-fix-loop`, `implement-verify`, `verify-fix-loop`, `security-scan`, `user-checkpoint`, `plan-review`, `pattern-check`, `early-scan`, `impl-handoff`, `targeted-research`, `test-fix-loop`, `pre-launch-check`, `ship-done`.

### Agents

Each state spawns a specialist agent in its own isolated git worktree. Agents receive relevant principles loaded for their task and produce structured artifacts that feed the next state.

**Specialist agents:**

| Agent | Role |
|-------|------|
| Researcher | Codebase analysis, risk assessment, investigation |
| Architect | Design decisions, task plans, technical direction |
| Implementor | Code changes, tests, self-review |
| Tester | Test coverage analysis, test writing, verification |
| Reviewer | Principle-based code review, compliance scoring |
| Security | Vulnerability assessment, threat modeling |
| Fixer | Targeted fixes for failing tests or review violations |
| Scribe | Context sync — updates CLAUDE.md and documentation |
| Shipper | Merge, PR creation, deployment prep |
| Chat | Design discussions, brainstorming, ideas |
| Guide | Questions, status checks, how-does-this-work |
| Writer | Principle authoring and editing |
| Learner | Review data analysis, principle improvement suggestions |

### User Checkpoints

Canon pauses at key moments to show you what's planned and get your approval. These **HITL breakpoints** happen after design (before code is written) and after review (if violations need a decision). You can approve, ask for revisions, or steer the flow. Canon never proceeds through a design without your sign-off.

### Worktree Isolation

Each specialist agent runs in its own git worktree — a lightweight, separate working directory on your branch. This means multiple agents can work in parallel without interfering with each other, and the main worktree stays clean throughout.

### Hooks

Canon installs tool-use interceptors that run automatically:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `pre-commit-check.sh` | Before `git commit` | Detect secrets, validate principle compliance |
| `destructive-guard.sh` | Before Bash | Block force push, hard reset, and other dangerous git ops |
| `workspace-lock-guard.sh` | Before Bash | Prevent concurrent builds on the same branch |
| `pre-push-review.sh` | Before `git push` | Require review before pushing |
| `large-file-guard.sh` | Before Write/Edit | Prevent accidental large file commits |
| `principle-inject.sh` | Before Write/Edit | Inject relevant principle summaries into prompts |
| `learn-nudge.sh` | After Bash | Suggest principle creation or updates |
| `compaction-check.sh` | After Bash | Detect workspace file growth |

---

## Other Workflows

### Review a PR

```bash
/canon:pr-review
```

Or just ask: "Review my changes" or "Review PR #42".

Canon runs a principle-based review across changed files, grouped by architectural layer. You get a verdict, a compliance score, a fix-before-merge checklist, and violations grouped by principle.

Before the review runs, Canon shows a **change story** — files clustered into logical groups with a narrative summary of what changed.

### Security scan

> "Scan for vulnerabilities"

Or include security concerns in a build request — Canon automatically adds a security scan phase to relevant workflows.

### Explore the codebase

> "How does the auth system work?"
> "What would break if I changed the User model?"

Canon spins up parallel research agents, synthesizes their findings, and gives you a structured analysis. No code changes.

### Visual dashboards (MCP App)

When you're using Claude Desktop or another MCP-compatible client, Canon opens interactive dashboards right in the conversation.

**PR Review** — A unified progressive view. Before a review runs, it shows a change story (files clustered by logical group) and impact assessment. After a Canon review, it shows verdict, compliance score, fix-before-merge checklist, violations by principle, blast radius chart, and layer distribution. Click any violation to ask Claude to explain and suggest a fix.

![PR Impact](./docs/images/pr_impact.png)

**Codebase Graph** — An interactive dependency graph built from your source files. Parses imports, exports, function calls, and inheritance across JS/TS/Python into a unified graph. Nodes are colored by architectural layer and highlighted when they carry violations or appear in a diff. Filter by layer, violations, or changed files.

> "Show me the codebase graph"

![Codebase Graph](./docs/images/codebase_graph.png)

**File Context** — Deep-dive on a single file: layer, dependencies, exports, blast radius, and any principle violations. Shows richer entity-level data when the codebase graph has been indexed.

> "Show me the context for src/routes/orders.ts"

![File Context](./docs/images/file_context.png)

In terminal-only environments, all dashboards return the same data as structured text.

### Learn from your history

```bash
/canon:learn
```

Analyzes accumulated review data to suggest principle improvements: severity adjustments based on compliance rates, conventions ready to graduate to principles, stale principles the codebase no longer follows. Run with `--apply` to walk through suggestions interactively.

---

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/canon:init` | Set up Canon in your project (includes adoption scan; pass `--no-scan` to skip) |
| `/canon:check` | Lightweight pre-commit principle compliance check |
| `/canon:pr-review` | Review a PR or branch against principles |
| `/canon:edit-principle` | Edit a principle — severity, scope, tags, or body |
| `/canon:test-principle` | Verify a principle fires by generating a violation |
| `/canon:learn` | Analyze review data and suggest improvements |
| `/canon:doctor` | Diagnose setup issues — broken frontmatter, MCP server health |
| `/canon:clean` | Clean up workspace artifacts; optionally archive to project history |

---

## The MCP Server

Canon's tooling is provided by a TypeScript MCP server (`mcp-server/`) that Claude Code connects to automatically when the plugin is installed. It exposes approximately 40 tools across six areas:

| Area | Tools |
|------|-------|
| **Orchestration** | `load_flow`, `init_workspace`, `drive_flow`, `update_board`, `report_result`, `post_message`, `get_messages`, `inject_wave_event`, `get_transcript`, `seed_workspace`, `simulate_flow`, `resolve_wave_event`, `resolve_after_consultations` |
| **Principles** | `get_principles`, `list_principles`, `get_compliance`, `review_code` |
| **Knowledge graph** | `codebase_graph`, `graph_query`, `semantic_search`, `store_summaries` |
| **PR review** | `show_pr_impact`, `review_code`, `store_pr_review` |
| **File context** | `get_file_context` |
| **Diagnostics** | `get_drift_report`, `record_agent_metrics`, `categorize_failures`, `get_history` |

Tools that produce visual outputs (`show_pr_impact`, `codebase_graph`, `get_drift_report`, `get_compliance`, `get_file_context`, `graph_query`) open as interactive MCP App dashboards in Claude Desktop and compatible clients. In terminal-only environments, they return equivalent structured text.

The MCP server persists state to `.canon/` using SQLite databases and JSONL files.

---

## Project Layout

```
canon/
├── agents/               # Specialist agent definitions (markdown + YAML frontmatter)
├── flows/                # Flow state machine definitions
│   └── fragments/        # Reusable state groups included by flows
├── hooks/                # Pre/post tool-use interceptor scripts (hooks.json + shell scripts)
├── mcp-server/           # TypeScript MCP server — Canon harness tools + principle/graph/drift tools
│   └── src/
│       ├── app/          # Entry point (index.ts), tool registration
│       ├── domains/      # Shared domain types (flows, workspaces, messages, board)
│       ├── features/     # Tool implementations grouped by feature area
│       ├── platform/     # Job manager, infrastructure
│       └── shared/       # Constants, matcher, parser, schema, utility libs
├── principles/           # Built-in principles (56 total: 5 rules, 34 strong-opinions, 17 conventions)
│   ├── rules/
│   ├── strong-opinions/
│   └── conventions/
├── rules/                # Agent-behavior rules (loaded per agent at runtime)
├── skills/canon/         # Claude Code skill definition — entry point for Canon activation
│   ├── commands/         # Slash command definitions
│   └── references/       # Reference fragments (canon-orchestrator.md, etc.)
├── templates/            # Artifact templates agents must follow
└── .canon/               # Runtime data (workspaces, principles, config, SQLite DBs)
    └── workspaces/       # Per-branch/task build state
```

---

## Configuration

All configuration is in `.canon/config.json`. Every key is optional.

```json
{
  "layers": {
    "api": ["api/**", "routes/**", "controllers/**"],
    "ui": ["app/**", "components/**", "pages/**", "views/**"],
    "domain": ["services/**", "domain/**", "models/**"],
    "data": ["db/**", "data/**", "repositories/**"],
    "infra": ["infra/**", "deploy/**"],
    "shared": ["utils/**", "lib/**", "shared/**", "types/**"]
  }
}
```

Override `layers` to match your project's directory structure. Run `/canon:doctor` to check for configuration issues.

---

## Data and Privacy

Everything Canon stores lives in `.canon/` in your project root:

| Path | Purpose |
|------|---------|
| `principles/` | Your project's active principles |
| `CONVENTIONS.md` | Project conventions for implementors |
| `config.json` | Configuration |
| `knowledge-graph.db` | SQLite knowledge graph (file dependencies, entities, metrics) |
| `orchestration.db` | SQLite execution state for active build pipelines |
| `drift.db` | SQLite drift tracking (review results, compliance history) |
| `workspaces/{branch}/{slug}/` | Per-task build state (board.json, session.json, progress.md, plans/, reviews/) |

Canon does not collect, transmit, or share any data. No telemetry, no analytics, no background network calls. Everything stays local.

---

## Reference

Full MCP tool signatures, flow schema, hook details, and the principles guide: [docs/reference/canon-reference.md](./docs/reference/canon-reference.md).

What's coming next: [docs/roadmap.md](./docs/roadmap.md).
