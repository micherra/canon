# Canon

Imagine asking an AI coding tool to "rebuild the notification system" and having it — without any flags or configuration — evaluate the request, plan it, design the architecture, implement it across parallel worktrees with principle enforcement throughout, run a security scan, and ship through a structured review. All driven by your own rules, loaded automatically per file.

That's what Canon does.

---

## What Canon Is

Canon is a Claude Code plugin that turns Claude into an orchestrated, multi-agent build system. You describe what you want. Canon classifies your intent, spawns the right specialist agents, and coordinates them through planning, design, implementation, testing, and review — surfacing decisions at the right moments and enforcing your engineering principles throughout.

Canon has strong opinions about software engineering and is designed to share them with every agent it spawns. Principles aren't decoration; they're loaded into agents per task, enforced during implementation, and drift-tracked across sessions. When the codebase diverges from your standards, Canon tells you.

---

## How It Works

### The pipeline

```
request → planner → runbook → architect → engineer(s) → tester → reviewer → scribe → shipper
```

Every build request routes through the planner before any code is written. The planner evaluates the request, investigates the codebase, challenges assumptions, and produces a runbook with a task plan. You approve the plan. Then specialist agents execute it step by step.

### Intent classification — invisible dispatch

Canon classifies every message and picks the right approach automatically. No flags, no mode selection. "The search is broken" becomes a fast-path fix. "Rebuild the notification system" gets a full planner evaluation. "How does the auth system work?" becomes an investigation.

### Skill preloading

Before each agent spawn, Canon calls `resolve_agent_skills` to load the agent's declared rules, references, primers, and templates, then injects the resolved content directly into the spawn prompt. Agents receive their governing context without needing to read files themselves.

### Parallel execution via DAG

For multi-task builds, the architect produces a `task-dag.yaml` that expresses ordering constraints. Canon spawns a team of engineer workers that claim tasks from the queue and execute them in parallel worktrees. Completed tasks are merged into the build branch in dependency order.

### Knowledge graph with context injection

Canon builds a SQLite-backed knowledge graph of your codebase: import/export relationships, function calls, inheritance, cycle detection, hub identification, and architectural layer assignments. When an agent is about to touch a file, Canon queries the graph and injects relevant context — callers, callees, blast radius, layer violations — into the agent's prompt automatically.

You can also query the graph directly:

```
"What breaks if I change the User model?"
"Show me the codebase graph"
"Show me the context for src/routes/orders.ts"
```

### Principles with drift detection

Canon ships 54 built-in engineering principles across three severity tiers. Every agent loads the principles relevant to its task — matched by architectural layer and file path pattern. Reviewers check compliance. Drift reports show you which principles the codebase is drifting away from, with trend data, most-violated principle lists, and hotspot directories.

### PR review with impact analysis

The `show_pr_impact` tool shows a **change story** before a review runs: files clustered into logical groups with a narrative summary of what changed. After a Canon review, it shows verdict, compliance score, fix-before-merge checklist, blast radius chart, and violations by principle — in a progressive interactive dashboard.

---

## A Walkthrough

You type: **"add dark mode to the dashboard"**

**Planning.** The planner scans the codebase, finds the theming system, identifies the files that would change, flags that the user preference isn't currently persisted. It produces a runbook with task plans. You approve.

**Design.** An architect agent reads the research, produces a design: CSS custom properties for tokens, `prefers-color-scheme` media query as default, localStorage for persistence. It writes a `task-dag.yaml` with parallel tasks for the theming system and component updates.

**Implement.** Two engineer agents work in parallel worktrees — one on the theming system, one on the component updates. Each engineer receives its task plan, relevant principles, and knowledge graph context.

**Test.** A tester agent runs the test suite, analyzes coverage gaps, and writes missing tests for the theme context and toggle behavior.

**Review.** A reviewer agent runs a principle-based review. It loads principles scoped to the `ui` layer, checks compliance, and scores the change. Verdict: clean.

**Ship.** The shipper pushes the build branch and creates a PR.

Total time from your message to ready-for-merge: Canon drove all of it. You made one decision.

---

## Agent Roster

| Agent | Role |
|-------|------|
| Planner | Pre-build gate — evaluates requests, investigates codebase, challenges assumptions, produces runbook |
| Architect | Design decisions, task plans, parallel task DAG |
| Engineer | Code changes — implementation and targeted fixes (dual-mode) |
| Tester | Test coverage analysis, test writing, verification |
| Reviewer | Principle-based code review, compliance scoring |
| Security | Vulnerability assessment, threat modeling |
| Scribe | Context sync — updates CLAUDE.md and documentation |
| Shipper | Merge, PR creation, deployment prep |
| Writer | Principle and convention authoring |
| Learner | Review data analysis, principle improvement suggestions |

---

## Principles

Principles are the core of Canon. They are markdown files with YAML frontmatter that tell agents what rules, preferences, and conventions to apply. Canon ships with 54 built-in principles (4 rules, 33 strong-opinions, 17 conventions) covering security, architecture, testing, and code design. Your active principles live in `.canon/principles/` after init.

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
| `rule` | Hard constraint. Violations block merges. |
| `strong-opinion` | Default path. Deviations require justification. |
| `convention` | Stylistic preference. Tracked for drift, doesn't block. |

Principles are matched by architectural layer and file path pattern. When you touch `src/routes/orders.ts`, Canon loads principles scoped to the `api` layer — plus any that match the file path — rules first, then strong-opinions, then conventions. Project-local principles override any built-in principle with the same `id`.

---

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/canon:init` | Set up Canon in your project — copies starter principles, auto-detects conventions, generates CLAUDE.md, runs adoption scan |
| `/canon:check` | Lightweight pre-commit principle compliance check |
| `/canon:pr-review` | Review a PR or branch against principles |
| `/canon:edit-principle` | Edit a principle — severity, scope, tags, or body |
| `/canon:test-principle` | Verify a principle fires by generating a violation |
| `/canon:review-learnings` | Review proposed learnings and apply accepted ones as principle/convention updates |
| `/canon:doctor` | Diagnose setup issues — broken frontmatter, MCP server health |
| `/canon:clean` | Clean up workspace artifacts; optionally archive to project history |

---

## The MCP Server

Canon's tooling is provided by a TypeScript MCP server (`mcp-server/`) that Claude Code connects to automatically when the plugin is installed.

| Area | Tools |
|------|-------|
| **Orchestration** | `init_workspace`, `log_step`, `batch_log_steps`, `finalize_workspace`, `resolve_agent_skills`, `post_message`, `get_messages`, `get_transcript`, `present_artifact`, `invoke_janitor` |
| **Principles** | `get_principles`, `list_principles`, `get_compliance`, `review_code` |
| **Knowledge graph** | `codebase_graph`, `graph_query`, `semantic_search`, `store_summaries`, `get_context` |
| **PR review** | `show_pr_impact`, `review_code`, `store_pr_review` |
| **File context** | `get_file_context` |
| **Diagnostics** | `get_drift_report`, `record_agent_metrics`, `categorize_failures`, `get_history` |

Tools that produce visual outputs open as interactive MCP App dashboards in Claude Desktop and compatible clients. In terminal-only environments, they return equivalent structured text.

### MCP App dashboards (Svelte UI)

Canon includes a Svelte-based UI served by the MCP server, rendered as embedded apps in Claude Desktop.

**PR Review** — Progressive view. Before a review runs: change story (files clustered by logical group), narrative summary, impact tabs. After a Canon review: verdict, compliance score, fix-before-merge checklist, violations by principle, blast radius chart, layer distribution. Click any violation to ask Claude to explain and fix it.

![PR Impact](./docs/images/pr_impact.png)

**Codebase Graph** — Interactive dependency graph built from your source files. Nodes colored by architectural layer, highlighted for violations or diff membership. Filter by layer, violations, or changed files. Built on Sigma.js.

![Codebase Graph](./docs/images/codebase_graph.png)

**File Context** — Deep-dive on a single file: layer, dependencies, exports, blast radius, principle violations, hotspot score, co-change partners.

![File Context](./docs/images/file_context.png)

Source: [`mcp-server/src/ui/`](./mcp-server/src/ui/)

---

## Feature Index

| Feature | What it does | Source |
|---------|-------------|--------|
| Pre-build gate | Planner evaluates every request before code is written — challenges assumptions, assesses value | [`agents/planner.md`](./agents/planner.md) |
| Parallel DAG execution | Architect produces task graph; workers execute in parallel worktrees with dependency ordering | [`agents/architect.md`](./agents/architect.md) |
| Competition protocol | N agents race with different optimization lenses; synthesizer merges the best ideas | [`references/competition-debate.md`](./references/competition-debate.md) |
| Debate protocol | Multi-team structured deliberation with convergence detection and HITL checkpoint | [`references/competition-debate.md`](./references/competition-debate.md) |
| Knowledge graph | SQLite-backed codebase graph with affinity injection, semantic search, cycle detection, hub identification | [`features/knowledge-graph/`](./mcp-server/src/features/knowledge-graph/) |
| Git intelligence | Hotspot scoring (churn × complexity) and co-change pair detection from git history | [`features/knowledge-graph/git-intel/`](./mcp-server/src/features/knowledge-graph/git-intel/) |
| Principle enforcement | Principles loaded per task, enforced by reviewer, drift-tracked across sessions | [`features/principles/`](./mcp-server/src/features/principles/) |
| Drift detection | Compliance rate trends, most-violated principles, hotspot directories, `/canon:review-learnings` suggestions | [`features/diagnostics/`](./mcp-server/src/features/diagnostics/) |
| PR impact analysis | Change story clustering, blast radius, co-change warnings, progressive review dashboard | [`features/pr-review/`](./mcp-server/src/features/pr-review/) |
| Worktree isolation | Each engineer works in its own git worktree; safe parallelism, clean main worktree | [`mcp-server/src/app/`](./mcp-server/src/app/) |
| Hooks system | Pre/post tool-use interceptors enforcing secrets detection, destructive-op guard, principle injection | [`hooks/hooks.json`](./hooks/hooks.json) |
| Intent classification | Auto-detect approach from natural language; no flags or configuration needed | [`skills/canon/`](./skills/canon/) |
| Resume semantics | Interrupted builds resume from `journal.json`; workspaces persist across sessions | [`mcp-server/src/domains/workspaces/`](./mcp-server/src/domains/workspaces/) |
| Skill preloading | Agent rules, references, primers, and templates resolved and injected before spawn | `resolve_agent_skills` tool |
| Journal tracking | Each step logged before and after spawn; `finalize_workspace` verifies artifacts | `log_step` / `batch_log_steps` tools |
| Agent metrics | Tool calls, orientation calls, and turns tracked per agent for efficiency analysis | [`features/diagnostics/`](./mcp-server/src/features/diagnostics/) |
| Conventions auto-detection | `/canon:init` scans your codebase and generates `CONVENTIONS.md` and `CLAUDE.md` from detected patterns | [`skills/canon/commands/init.md`](./skills/canon/commands/init.md) |
| Svelte UI | Interactive dashboards for PR review, codebase graph, and file context via MCP App protocol | [`mcp-server/src/ui/`](./mcp-server/src/ui/) |
| Agent provenance | Commit messages include structured trailers: `Canon-Workflow`, `Canon-Agent`, `Canon-State`, `Canon-Task` | [`shared/lib/`](./mcp-server/src/shared/lib/) |

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

### Initialization

Run this once inside your project:

```bash
/canon:init
```

Canon will:
- Copy 54 built-in principles into `.canon/principles/`
- Scan your codebase to auto-detect conventions and generate `.canon/CONVENTIONS.md`
- Generate or update `CLAUDE.md` with Canon orchestration instructions
- Run an adoption scan for existing principle violations (pass `--no-scan` to skip)

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
| `CONVENTIONS.md` | Project conventions for engineers |
| `config.json` | Configuration |
| `knowledge-graph.db` | SQLite knowledge graph (file dependencies, entities, metrics, hotspots, co-change pairs) |
| `orchestration.db` | SQLite execution state for active build pipelines |
| `drift.db` | SQLite drift tracking (review results, compliance history) |
| `workspaces/{branch}/{slug}/` | Per-task build state (journal.json, orchestration.db, plans/, reviews/) |

Canon does not collect, transmit, or share any data. No telemetry, no analytics, no background network calls. Everything stays local.

---

## Project Layout

```
canon/
├── agents/               # Specialist agent definitions (markdown + YAML frontmatter)
├── hooks/                # Pre/post tool-use interceptor scripts (hooks.json + shell scripts)
├── mcp-server/           # TypeScript MCP server — Canon harness tools + principle/graph/drift tools
│   └── src/
│       ├── app/          # Entry point (index.ts), tool registration
│       ├── domains/      # Shared domain types (workspaces, messages, board)
│       ├── features/     # Tool implementations grouped by feature area
│       │   ├── orchestration/   # Workspace lifecycle: init_workspace, log_step, finalize_workspace
│       │   ├── principles/      # get_principles, list_principles, get_compliance
│       │   ├── knowledge-graph/ # codebase_graph, graph_query, semantic_search
│       │   ├── pr-review/       # show_pr_impact, review_code, store_pr_review
│       │   ├── file-context/    # get_file_context
│       │   └── diagnostics/     # get_drift_report, record_agent_metrics, store_summaries
│       ├── platform/     # Job manager, infrastructure
│       └── ui/           # Svelte frontend — MCP App dashboards
├── principles/           # Built-in principles (54 total: 4 rules, 33 strong-opinions, 17 conventions)
├── rules/                # Agent-behavior rules (loaded per agent at runtime)
├── primers/              # Domain primers (backend-api, frontend, testing, …) — agent reasoning context
├── references/           # Orchestrator + protocol fragments (canon-orchestrator.md, principle-format.md, …)
├── skills/canon/         # Claude Code skill definition — entry point for Canon activation
│   ├── commands/         # Slash command definitions
│   └── evals/            # Eval suite
├── templates/            # Artifact templates agents must follow
└── .canon/               # Runtime data (workspaces, principles, config, SQLite DBs)
    └── workspaces/       # Per-branch/task build state
```

---

## Reference

Full MCP tool signatures, hook details, and the principles guide: [docs/reference/canon-reference.md](./docs/reference/canon-reference.md).

What's coming next: [docs/roadmap.md](./docs/roadmap.md).
