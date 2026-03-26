# Contributing to Canon

Thanks for your interest in contributing! Canon is open source under the MIT license and welcomes contributions of all kinds — bug fixes, new principles, tooling improvements, and documentation.

## Getting Started

1. Fork and clone the repo
2. Install dependencies:
   ```bash
   cd mcp-server && npm install
   ```
3. Run tests:
   ```bash
   cd mcp-server && npm test
   ```
4. Build the dashboard UI:
   ```bash
   cd mcp-server && npm run build:ui
   ```

## Project Layout

```
canon/
├── mcp-server/            MCP server (TypeScript) — 25 tools, drift tracking, orchestration
│   └── src/
│       ├── tools/           Tool implementations (one file per tool)
│       ├── orchestration/   Flow runtime: board, effects, gates, variables, clustering
│       ├── drift/           JSONL stores: decisions, patterns, reviews, analytics
│       └── graph/           Dependency graph scanner and priority scoring
├── mcp-server/ui/         Svelte/Sigma.js dashboard UI (builds to single HTML for MCP App)
├── principles/            Built-in engineering principles (markdown + YAML frontmatter)
├── flows/                 Flow state machines (YAML frontmatter + spawn instructions)
│   └── fragments/           Reusable state groups included by flows
├── templates/             Agent output templates (review checklists, summaries, plans)
├── agents/                Specialist agent definitions (13 agents + orchestrator)
├── hooks/                 Pre/post tool-use interceptor scripts
├── commands/              CLI command definitions
├── skills/                Skill definitions for Claude Code / Cursor integration
└── .canon/                Runtime data (workspaces, drift JSONL, config)
```

## Development Workflow

1. Create a branch from `main`
2. Make your changes
3. Ensure tests pass: `cd mcp-server && npm test`
4. Ensure the build succeeds: `cd mcp-server && npm run build`
5. Open a pull request against `main`

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for semantic versioning:

- `feat:` — new feature (minor version bump)
- `fix:` — bug fix (patch version bump)
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `chore:` — maintenance tasks

## Contributing Principles

Canon's built-in principles live in `principles/`. To contribute a new one:

1. Pick the right severity: `rules/` (hard constraint), `strong-opinions/` (default path), or `conventions/` (stylistic preference)
2. Create a markdown file with YAML frontmatter:
   ```yaml
   ---
   id: your-principle-id
   title: Your Principle Title
   severity: strong-opinion
   scope:
     layers: [domain]
     file_patterns: []
   tags: [relevant-tag]
   ---

   Rationale and examples here.
   ```
3. Ensure the `id` is unique (check with `grep -r "^id:" principles/`)
4. Open a PR with context on why this principle is broadly useful

## Reporting Bugs

Use the [bug report template](https://github.com/micherra/canon/issues/new?template=bug_report.yml) on GitHub. Include:

- What you expected vs what happened
- Steps to reproduce
- Your environment (Node version, OS, Claude Code version)

## Requesting Features

Use the [feature request template](https://github.com/micherra/canon/issues/new?template=feature_request.yml) on GitHub. Describe the use case and why it would be valuable.

## Key Subsystems

### Effects System
Effects run declaratively after flow states complete, parsing agent artifacts and persisting structured data to JSONL drift stores. Defined in flow YAML via `effects:` on a state:

```yaml
states:
  review:
    effects:
      - type: persist_review
        artifact: REVIEW.md
      - type: persist_decisions
      - type: persist_patterns
```

All effects are best-effort — parse failures are logged but never block the flow. Implementation: `mcp-server/src/orchestration/effects.ts`.

### Flow Gates
Gates are verification checkpoints (test suites, linters, type checkers) that run between states. See `flows/GATES.md` for the full guide on built-in and custom gates.

### Flow Analytics
Flow execution data is automatically persisted to `.canon/flow-runs.jsonl` on flow completion.

## Code Style

- TypeScript with strict mode
- No unnecessary abstractions — keep it simple
- Tests for logic that isn't trivial (skip passthroughs)
- No telemetry or data collection of any kind
