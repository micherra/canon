# Canon

Canon is a Claude Code plugin that adds engineering principles and a multi-agent build pipeline to your project. You describe what you want — Canon figures out the right approach, coordinates specialist agents to research, design, implement, test, review, and ship, and enforces your principles throughout. From your side, you just talk to Claude.

---

## Why Canon

Most AI coding agents are capable but unstructured. Without Canon, common patterns emerge:

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

- **Principles** — a starter set of 54 built-in principles across three severity tiers, ready to customize
- **CONVENTIONS.md** — project conventions file for implementors to read
- **config.json** — layer mappings and configuration with sensible defaults

After setup, Canon runs an adoption scan to find any existing principle violations in your codebase. Pass `--no-scan` to skip the scan if you'd rather run it later.

From this point on, Canon loads relevant principles automatically whenever you build, review, or check code.

---

## Principles

Principles are the core of Canon. They are markdown files that tell agents what rules, preferences, and conventions to apply. Canon ships with 54 built-in principles (4 rules, 33 strong-opinions, 17 conventions) covering security, architecture, testing, and code design. After init, your project's active principles live in `.canon/principles/`.

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

## Key Concepts

**Principles** are the rules Canon enforces. They live in `.canon/principles/` and are matched to code by layer and file pattern. Project-local principles override built-ins with the same `id`.

**Flows** are the workflows Canon selects automatically: `fast-path`, `refactor`, `feature`, `migrate`, `epic`, `explore`, `test-gap`, `review-only`, `security-audit`, and `adopt` (run automatically at the end of `init`). You never pick a flow; Canon selects based on task scope and urgency.

**Agents** are specialists Canon dispatches — Researcher, Architect, Implementor, Tester, Reviewer, Security, Fixer, Scribe, Shipper, Chat, Guide, Writer, Learner. Each runs in its own isolated git worktree with relevant principles loaded. You see their output but never manage them directly.

**User checkpoints** pause the pipeline after planning so you can review and give feedback before any code is written. Approve to proceed, or share thoughts — Canon routes revisions back to planning with your notes.

**The MCP server** (`mcp-server/`) is a TypeScript server that provides Canon's harness tools (flow orchestration, workspace management, board state) and principle/drift/graph tools. It persists state to `.canon/` using SQLite databases and JSONL files.

**Hooks** run automatically on tool use: `pre-commit-check.sh` (secrets + principle compliance), `destructive-guard.sh` (blocks dangerous git operations), `workspace-lock-guard.sh` (prevents concurrent builds), `principle-inject.sh` (injects relevant principles into write/edit prompts), and others.

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
