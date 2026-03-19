# Contributing to Canon

Thanks for your interest in contributing! Canon is open source under the MIT license and welcomes contributions of all kinds — bug fixes, new principles, tooling improvements, and documentation.

## Getting Started

1. Fork and clone the repo
2. Install dependencies:
   ```bash
   cd mcp-server && npm install
   cd ../cursor-extension && npm install
   ```
3. Run tests:
   ```bash
   cd mcp-server && npm test
   ```
4. Build the extension:
   ```bash
   cd cursor-extension && npm run build
   ```

## Project Layout

```
canon/
├── mcp-server/          MCP server (TypeScript)
├── cursor-extension/    VS Code/Cursor extension (Svelte + TypeScript)
├── principles/          Built-in engineering principles
├── commands/            Slash commands
├── agents/              Specialist agents
├── agent-rules/         Agent behavioral guidelines
├── hooks/               Automation hooks
└── skills/              Skill definitions
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

## Code Style

- TypeScript with strict mode
- No unnecessary abstractions — keep it simple
- Tests for logic that isn't trivial (skip passthroughs)
- No telemetry or data collection of any kind
