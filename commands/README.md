# Canon Commands

13 user-facing CLI commands for Canon. Each command is a markdown file that defines instructions for the agent executing it. Commands are registered as Claude Code slash commands and invoked as `/canon:{name}`.

## Command Reference

| Command | Purpose | Details |
|---------|---------|---------|
| `/canon:init` | Initialize Canon in a project | Creates `.canon/` directory structure, copies starter principles, generates `config.json`, patches `CLAUDE.md`, and auto-detects project conventions into `CONVENTIONS.md`. Accepts `--starter` (default) or `--empty`. |
| `/canon:adopt` | Scan codebase for principle violations | Launches the `adopt` flow: scans files, matches principles, produces a tiered violation report, and optionally spawns parallel fixers on rule-severity violations with `--fix`. |
| `/canon:check` | Lightweight pre-commit compliance check | Runs `get_principles` against staged or specified files, spawns a scoped reviewer, and reports CLEAN / WARNING / BLOCKING verdicts without creating a workspace. Suitable for pre-commit hooks. |
| `/canon:clean` | Clean up workspace artifacts | Shows a workspace summary, then offers to archive decisions and notes to `.canon/history/` before deleting. Accepts `--branch`, `--all`, `--archive`, and `--force`. |
| `/canon:create-flow` | Create a new Canon flow definition | Interviews the user for flow name, tier, states, and fragments, generates a valid flow file following the `flows/SCHEMA.md` format, validates it with `validate_flows`, and saves to `flows/{name}.md`. |
| `/canon:create-overlay` | Create a new role overlay | Interviews the user for expertise domain, target agents, priority, heuristics, review lens, and anti-patterns, then saves a structured overlay to `.canon/overlays/{name}.md`. |
| `/canon:doctor` | Diagnose Canon setup issues | Runs 11 checks: directory structure, config file, principle frontmatter, duplicate IDs, scope validation, agent-rules format, MCP server health, CLAUDE.md integration, JSONL data integrity, convention bloat, and data file rotation. Accepts `--fix` to auto-correct simple issues. |
| `/canon:edit-principle` | Edit an existing principle or agent-rule | Spawns the `canon-writer` agent in edit mode to load the target entry, apply changes (content, severity, tags, archive state), handle file moves on severity changes, and validate the result. |
| `/canon:learn` | Analyze drift data and suggest improvements | Spawns the `canon-learner` agent to analyze six dimensions: codebase patterns, drift-driven severity changes, task convention promotion, decision clusters, convention graduation, and staleness. With `--apply`, walks through each suggestion interactively for apply / skip / dismiss / modify. |
| `/canon:pr-review` | Review a PR or branch against principles | Launches the `review-only` flow for a PR number or branch name, with optional `--incremental` (only new commits since last Canon review), `--layer` filtering, and `--post-comments` to post inline GitHub review comments via `gh api`. |
| `/canon:test-principle` | Verify a principle is correctly detected | Generates a realistic file that intentionally violates the target principle, runs the reviewer against it, checks the violation was caught, reports PASS or FAIL with diagnostic detail, then cleans up the temp file. |
| `/canon:toggle-archive` | Archive or unarchive a principle | Toggles the `archived: true` flag in a principle's or agent-rule's frontmatter. Archived entries stay on disk but are skipped by the matcher — they won't appear in reviews or `get_principles` results. |
| `/canon:workspaces` | Manage Canon build workspaces | Four subcommands: `list` (table of all workspaces with status and age), `inspect <workspace>` (detailed board state and recent log), `clean` (remove completed/aborted workspaces older than N days), `diff <workspace>` (git log and stat since the build's base commit). |

## How Commands Work

Commands are the user-facing interface to Canon. When a user types `/canon:{name}`, the Claude Code skill system loads the corresponding command file and the orchestrator executes the instructions inside it.

**Two execution modes:**

- **Flow-launching commands** delegate to a full Canon flow. The command file parses arguments, constructs flow parameters, calls `init_workspace` and `load_flow`, and drives the state machine. Examples: `adopt` launches the `adopt` flow; `pr-review` launches `review-only`.

- **Direct-execution commands** run inline without a workspace or state machine. They use tools directly (Bash, Read, Glob, Agent) and report results immediately. Examples: `check` spawns a single scoped reviewer; `doctor` runs diagnostic checks; `toggle-archive` edits a frontmatter field.

The distinction is invisible to the user — both modes respond with plain-language output.

## Command File Format

Each command is a self-contained markdown file in `commands/`. No YAML frontmatter is required (unlike principles and flows), though most commands use it for metadata consumed by the skill system.

**Optional frontmatter fields:**

```yaml
---
description: One-line description shown in the slash command picker
argument-hint: <required-arg> [--optional-flag value]
allowed-tools: [Bash, Read, Write, Glob, Edit, Grep, Agent]
model: haiku | sonnet | opus
---
```

- `description` — shown in the `/canon:` command picker
- `argument-hint` — hint text shown after the command name when the user types it
- `allowed-tools` — restricts which tools the executing agent may call (principle of least privilege)
- `model` — selects the model tier; fast commands use `haiku`, complex analysis uses `sonnet`

**Body** — plain markdown instructions for the executing agent. The agent reads the file as its prompt and follows the steps. Commands reference `${ARGUMENTS}` to access whatever the user typed after the command name, and `${CLAUDE_PLUGIN_ROOT}` to reference the Canon plugin directory.

Commands that launch flows end with an orchestrator invocation pattern:

```
Invoke the orchestrator with:
- flow: {flow-name}
- task: "{task description}"
- Metadata: { ... }
```

Commands that run directly end with a result presentation step, reporting back to the user in plain language.
