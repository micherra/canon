# Canon Commands — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
User-facing CLI entry points for Canon. Each command is a markdown file defining what the command does and how to invoke it. Users trigger commands via slash commands or natural language — intake classifies and routes.

## Architecture
<!-- last-updated: 2026-03-22 -->

Each command file contains instructions for the agent that executes it. Commands are registered as Claude Code slash commands.

**Available commands:**

| Command | Purpose |
|---------|---------|
| `init` | Initialize Canon principles in a project |
| `adopt` | Scan codebase for principle coverage; identify and optionally fix violations |
| `check` | Check code for principle compliance before commit |
| `clean` | Archive or remove workspace artifacts |
| `doctor` | Diagnose Canon setup issues; validate configuration |
| `edit-principle` | Create or modify a principle |
| `pr-review` | Review pull request changes |
| `test-principle` | Verify a principle works correctly |
| `toggle-archive` | Archive/unarchive a workspace |

## Conventions
<!-- last-updated: 2026-03-22 -->

- Commands are the user interface to Canon — agents and flows are internal
- Each command file is self-contained with its own instructions
- Commands may spawn flows (e.g., `adopt` triggers the adopt flow) or run directly
