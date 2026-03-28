# Canon

Canon is a Claude Code plugin that brings engineering principles and an agent-driven build pipeline to your project. You describe what you want — Canon figures out the right approach, coordinates specialist agents to research, design, implement, test, review, and ship, and enforces your principles throughout. From your side, you just talk to Claude.

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

We recommend enabling tool search to reduce context usage:

```json
// ~/.claude/settings.json
{
  "env": {
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

---

## Initialization

Run this once inside your project:

```bash
/canon:init
```

Canon scans your source files to detect conventions, then creates a `.canon/` directory with:

- **Principles** — a starter set across three severity tiers (rules, strong-opinions, conventions), tuned for your detected stack
- **CONVENTIONS.md** — project conventions pre-populated for your setup
- **config.json** — configuration with sensible defaults

After setup, Canon automatically runs an adoption scan to find any existing principle violations in your codebase and report them. Pass `--no-scan` to skip the scan if you'd rather review it later.

From this point on, Canon loads relevant principles automatically whenever you build, review, or check code.

---

## Principles

Principles are the core of Canon. They're markdown files that tell agents what rules, preferences, and conventions to apply. Canon ships with 52 built-in principles covering security, architecture, testing, and more. After init, you'll find your project's principles under `.canon/principles/`.

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
| `rule` | Hard constraint. Blocks commits. Violations in reviews are BLOCKING. |
| `strong-opinion` | Default path. Deviations require justification. |
| `convention` | Stylistic preference. Tracked for drift, doesn't block. |

### Creating and editing principles

The easiest way is to just ask:

> "Create a new principle about error handling"

Canon spawns an interactive author agent that walks you through it. You can also run `/canon:edit-principle` to modify an existing one, or edit the markdown files directly under `.canon/principles/`.

Principles are matched to files by architectural layer and path pattern. When you touch `src/routes/orders.ts`, Canon loads principles scoped to the `api` layer — plus any that match the file path — rules first, then strong-opinions, then conventions.

Project-local principles (in `.canon/`) override any built-in principle with the same `id`.

---

## Your First Build

Once Canon is initialized, just describe what you want:

> "Add an order creation endpoint with Zod validation"

Canon classifies your intent, picks an appropriate workflow, and drives specialist agents through research, design, implementation, testing, and review. You'll see progress updates in plain language. When planning is done, Canon pauses to show you what's planned and ask for your approval before writing any code.

No flags, no flow names, no configuration needed. Canon auto-detects the right approach based on the scope of your task.

### More examples

| What you say | What happens |
|-------------|-------------|
| "The login page is broken" | Quick fix or hotfix depending on urgency — diagnose, fix, verify |
| "Refactor the auth middleware" | Analyze, restructure with test verification, review |
| "Migrate from Express to Hono" | Research, staged migration with rollback planning, security check, review |
| "Rebuild the notification system" | Epic: parallel research, design, adaptive wave implementation, test, security, review |
| "How does the payment system work?" | Research and synthesize — no code changes |
| "Improve test coverage for the API layer" | Scan coverage gaps, write tests, fix revealed bugs, review |

You can also steer Canon naturally: "skip research", "just plan, don't implement", "this is urgent", "use a quick fix".

---

## Other Workflows

### Review a PR

```bash
/canon:pr-review
```

Or just ask: "Review my changes" or "Review PR #42".

Canon runs a principle-based review across changed files, grouped by architectural layer. You get a verdict, a compliance score, a fix-before-merge checklist, and violations grouped by principle — with clickable items that ask Claude to explain and suggest a fix.

Before the review runs, Canon shows a **change story** — your files clustered into logical groups with a narrative summary of what changed and why it matters.

### Security scan

> "Scan for vulnerabilities"

Or just include security concerns in a build request — Canon automatically adds a security scan phase to relevant workflows.

### Explore the codebase

> "How does the auth system work?"
> "What would break if I changed the User model?"

Canon spins up parallel research agents, synthesizes their findings, and gives you a structured analysis. No code changes.

### Visual dashboards (MCP App)

When you're using Claude Desktop or another MCP-compatible client, Canon opens interactive dashboards right in the conversation.

**PR Review** — Run a review first (`/canon:pr-review` or "review my changes"), then Canon opens a dashboard with a verdict banner, compliance score, fix-before-merge checklist, violations grouped by principle, blast radius chart, and layer distribution. You can also open it before a review to see a prep view with your change story and impact assessment. Click any violation to ask Claude to explain it.

**Codebase Graph** — An interactive dependency graph of your project. Fully standalone — just ask for it and Canon builds the graph from your source files. It parses both code relationships (imports, exports, function calls, inheritance across JS/TS/Python) and markdown relationships (frontmatter references, links between docs, backtick identifiers) into a unified graph. Nodes are colored by architectural layer and highlighted when they have violations or are part of a diff. Filter by layer, violations, or changed files. Click a node to see its dependencies.

> "Show me the codebase graph"

**File Context** — Deep-dive on a single file: its layer, dependencies, exports, blast radius, and any principle violations. Works on its own for basic info, but shows richer data (entity-level blast radius, graph metrics) if you've run the codebase graph first. Click entities to explore further.

> "Show me the context for src/routes/orders.ts"

These dashboards are powered by Canon's MCP server and render automatically when the corresponding tools run. In terminal-only environments, you get the same data as structured text.

### Compliance check

```bash
/canon:check
```

Runs a lightweight principle compliance check on staged files before you commit. Also runs automatically as a pre-commit hook after init.

### Learn from your history

```bash
/canon:learn
```

Analyzes your accumulated review data to suggest principle improvements: severity adjustments based on compliance rates, conventions ready to graduate to principles, stale principles the codebase no longer follows. Run with `--apply` to walk through suggestions interactively.

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

**Principles** are the rules Canon enforces. They live in `.canon/principles/` and are matched to code by layer and file pattern. You can write project-specific principles that override built-ins.

**Flows** are the workflows Canon picks from automatically — hotfix, quick-fix, refactor, feature, migrate, epic, explore, test-gap, review-only, security-audit, and adopt (run automatically at the end of `init`). You don't need to know which one is running; Canon selects based on scope and urgency.

**Agents** are specialists Canon dispatches — Researcher, Architect, Implementor, Tester, Reviewer, Security, and others. Each runs in its own context with relevant principles loaded. You see their output but never manage them directly.

**User checkpoints** pause the pipeline after planning so you can review what's planned and give feedback before any code is written. Approve to proceed, or share thoughts — Canon routes revisions back to planning with your notes attached.

---

## Configuration

All configuration is in `.canon/config.json`. Every key is optional.

```json
{
  "max_file_lines": 500,
  "layers": {
    "api": ["api/**", "routes/**", "controllers/**"],
    "ui": ["app/**", "components/**", "pages/**", "views/**"],
    "domain": ["services/**", "domain/**", "models/**"],
    "data": ["db/**", "data/**", "repositories/**"],
    "infra": ["infra/**", "deploy/**"],
    "shared": ["utils/**", "lib/**", "shared/**", "types/**"]
  },
  "review": {
    "max_principles_per_review": 10,
    "max_review_principles": 15
  }
}
```

Canon scans directories derived from the glob prefixes in `layers` — no separate `source_dirs` needed. Override `layers` to match your project's directory structure. Run `/canon:doctor` to check for configuration issues.

---

## Data and Privacy

Everything Canon stores lives in `.canon/` in your project root:

| File | Purpose |
|------|---------|
| `principles/` | Your project's principles |
| `CONVENTIONS.md` | Project conventions |
| `config.json` | Configuration |
| `reviews.jsonl` | Accumulated review results (used by `/canon:learn`) |
| `workspaces/{branch}/` | Build state for the current branch |

Canon does not collect, transmit, or share any data. No telemetry, no analytics, no background network calls. Everything stays local.
