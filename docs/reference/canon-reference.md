# Canon Reference

<!-- Lookup tables for agents. The orchestrator doesn't need this — behavioral rules are in CLAUDE.md. -->

## Project Structure

```
canon/
├── agents/               # Plugin agent definitions (YAML frontmatter + markdown instructions)
├── rules/                # Agent-behavior rules (loaded per agent at runtime)
├── flows/                # Retired flow-engine definitions (historical; no flow engine is active)
├── hooks/                # Pre/post tool-use interceptor scripts
├── mcp-server/           # TypeScript MCP server (Canon harness tools)
│   └── src/
│       ├── orchestration/  # Orchestration runtime: journal, init/finalize_workspace, gate-runner, convergence, events, etc.
│       ├── tools/          # MCP tool implementations (one file per tool)
│       ├── drift/          # JSONL-backed drift tracking (reviews)
│       └── graph/          # Dependency graph scanner and priority scoring
├── principles/           # Canonical engineering principles (markdown)
├── primers/              # Domain primers (12 files) — reasoning context agents Read
│                         #   when their plan's `domains:` field matches (backend-api,
│                         #   backend-data, frontend, testing, infrastructure,
│                         #   deprecation, authentication-security, migration-strategy,
│                         #   observability, error-handling, performance, devops-ci)
├── references/           # Orchestrator + agent protocol fragments (11 files):
│                         #   canon-orchestrator.md, principle-format.md,
│                         #   principle-loading.md, context-isolation.md,
│                         #   workspace-logging.md, status-protocol.md,
│                         #   guide-dashboards.md, learner-dimensions.md,
│                         #   tester-report-template.md, security-checklist.md,
│                         #   writer-worked-example.md
├── skills/canon/         # Canon skill definition (Claude Code skill entry point)
│   ├── SKILL.md          # Skill frontmatter + orchestrator activation
│   ├── commands/         # Slash commands (/canon:init, /canon:check, /canon:doctor, …)
│   └── evals/            # Eval suite for intent classification
├── templates/            # Artifact templates agents must follow
└── .canon/               # Runtime data (workspaces, principles, config, drift JSONL)
    └── workspaces/       # Per-branch/task build state (orchestration.db, journal.json, plans/, etc.)
```

## Orchestration Sequence

Canon orchestration is CLAUDE.md-prose-driven: the PM classifies intent and follows the documented sequence (implement → verify → review → context-sync → ship → learn) by spawning specialist agents and journaling each step via `log_step` / `batch_log_steps`. There is no separate flow YAML or state-machine driver tool. `init_workspace` seeds the board; `finalize_workspace` closes the flow and releases file claims.

**Supported intents and their sequences:**

| Intent | Sequence |
|--------|----------|
| build / fix / change | PM triage → architect or engineer → verify → review → context-sync → ship → learn |
| explore | PM triage → architect (research-only) |
| test-gap | PM triage → tester → verify → review |
| review-only | reviewer → (fix loop if needed) → ship |
| security-audit | security → reviewer → (fix loop if needed) → ship |
| learn | learner → (proposals surfaced to user) |

## MCP Tools (Harness)

The Canon MCP server exposes these tools. The orchestrator uses the harness tools to follow the documented orchestration sequence; specialist agents use the principle and drift tools. Tools with UIs open as MCP Apps in compatible clients (Claude Desktop).

**Tools with MCP App UIs:**

| Tool | Purpose |
|------|---------|
| `show_pr_impact` | PR blast radius, hotspots, violations, dependency subgraph |
| `codebase_graph` | Interactive dependency graph with compliance overlay |
| `get_drift_report` | Full drift analysis (violations, trends, hotspots, PR reviews) |
| `get_compliance` | Per-principle compliance stats, weekly trend chart |
| `get_file_context` | File dependencies, entities, blast radius, metrics |
| `graph_query` | Call trees, blast radius, dead code, search |

**Composite context tools:**

| Tool | Purpose |
|------|---------|
| `get_context` | Batch context for multiple files — composes principles, file context, drift, and graph in one call; `include` param gates sections |

**Principle & review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for a file/layer/task |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles matched to a specific file for review |
| `report` | Log a review result (drift tracking) |
| `store_summaries` | Persist file summaries to SQLite Knowledge Graph DB |
| `store_pr_review` | Store a PR review result for drift tracking |

**Routine tools:**

| Tool | Purpose |
|------|---------|
| `list_routines` | List all Canon routines with their name, status, resolved binding, and trigger; returns project-local and plugin routines merged with project-local precedence |
| `get_routine` | Retrieve a single routine by name; returns full frontmatter fields plus the body text; `INVALID_INPUT` when the name is not found |
| `sync_routines` | Sync routine state (last-run timestamps, status) and return a summary of drift; updates `.canon/routines/` state files |

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `init_workspace` | Create or resume a workspace (SQLite `orchestration.db`, `progress.md`); seeds `progress.md` with task header on creation; runs file claim overlap preflight check (warns if other workflows target the same files) |
| `log_step` | Record a single step execution (status, artifacts, agent ID) in `journal.json` |
| `batch_log_steps` | Register multiple planned steps at once (same as `log_step` but batched) |
| `finalize_workspace` | Close the flow, verify journal completeness, release file claims |
| `write_plan_index` | Persist architect task/plan data and affected-file list |
| `post_message` | Post a message to a workspace channel (unified messaging) |
| `get_messages` | Read messages from a workspace channel; supports `include_events` for wave events |
| `get_transcript` | Read a recorded agent transcript from a workspace state; modes: `full` (all entries) or `summary` (assistant-only); returns `total_tokens` when available <!-- last-updated: 2026-04-02 --> |

## Canon Engineering Principles

This project uses Canon for engineering principles. Before writing or modifying code, load relevant principles via the `get_principles` MCP tool. Principles are in `.canon/principles/`. Severity levels: `rule` is non-negotiable, `strong-opinion` requires justification to skip, `convention` is noted but doesn't block.

## Principle Overrides

Projects can tune Canon's principle set without editing principle files. Overrides are declared in `.canon/principle-overrides.yaml` and applied at load time, after project-local principles are merged with built-in ones.

### File location

`.canon/principle-overrides.yaml`

### Override actions

| Action | Effect |
|--------|--------|
| `disable` | Removes the principle entirely from loading — it will not appear in `get_principles` results or reviewer checks |
| `override-severity` | Changes the enforcement level to `rule`, `strong-opinion`, or `convention` |
| `narrow-scope` | Replaces the principle's scope with the specified layers and file patterns (replace semantics — original `scope.layers`, `scope.file_patterns`, and `scope.tags` are all dropped) |

`disable` and `override-severity` require a non-empty `reason` field for auditability. Entries missing `reason` (or with an empty string) are silently dropped — the principle is left unchanged. `narrow-scope` validates the `applies_to` structure but does not currently enforce `reason`; including one is recommended for auditability.

### YAML format

```yaml
overrides:
  # Remove a principle that doesn't apply to this project
  - principle_id: thin-handlers
    action: disable
    reason: This project uses a single-file handler pattern; the principle is inapplicable.

  # Relax a strong-opinion to a convention
  - principle_id: errors-are-values
    action: override-severity
    severity: convention
    reason: Legacy codebase uses throw-based error handling; migration is deferred.

  # Narrow a broad principle to specific layers and file patterns
  - principle_id: information-hiding
    action: narrow-scope
    applies_to:
      layers: [domain, data]
      file_patterns: ["src/services/**", "src/repositories/**"]
    reason: Principle is critical in the domain layer but overly restrictive in infra glue code.
```

### Field reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `principle_id` | string | always | Exact principle ID (filename without `.md`) |
| `action` | string | always | `disable`, `override-severity`, or `narrow-scope` |
| `reason` | string | always | Human-readable justification |
| `severity` | string | `override-severity` only | `rule`, `strong-opinion`, or `convention` |
| `applies_to` | object | `narrow-scope` only | Contains `layers` and `file_patterns` (both required; use `[]` to omit either) |
| `applies_to.layers` | string[] | `narrow-scope` only (use `[]` to omit) | Layer names defined in `.canon/config.json` |
| `applies_to.file_patterns` | string[] | `narrow-scope` only (use `[]` to omit) | Glob patterns relative to project root |

Common mistakes: using `id:` instead of `principle_id:`, using flat `file_patterns:` instead of `applies_to: { file_patterns: [] }`.

### Validation behavior

- **Missing file**: If `.canon/principle-overrides.yaml` does not exist, no overrides are applied. This is the default state.
- **Invalid entries**: Entries that fail validation (unknown `principle_id`, missing `reason`, malformed `applies_to`, invalid `severity` value) are silently dropped. The rest of the file is still applied.
- **Malformed YAML**: If the file cannot be parsed, no overrides are applied (fail-closed). Principles load as if the file were absent.
- **Unknown action**: An entry with an unrecognized `action` value passes the principle through unchanged.

### Principle layering order

1. Project-local principles (`.canon/principles/`) load and take precedence over built-ins on ID conflict.
2. Built-in principles (`${CLAUDE_PLUGIN_ROOT}/principles/`) fill in any IDs not defined locally.
3. The merged set is passed through `applyOverrides` — overrides modify or remove principles from the merged set.

Project-local principles and overrides are two independent mechanisms: a project-local principle replaces the built-in definition by ID; an override mutates or removes any principle (local or built-in) after the merge.

### Version control

`.canon/` is typically gitignored for runtime data (workspaces, databases, caches). However, `principle-overrides.yaml` is project configuration and should be version-controlled alongside your code.

To track it:

```bash
# Add the gitignore exception
echo '!.canon/principle-overrides.yaml' >> .gitignore

# Force-add the file (required because the parent directory is ignored)
git add -f .canon/principle-overrides.yaml
git commit -m "chore: track principle overrides"
```

The `!.canon/principle-overrides.yaml` exception in `.gitignore` tells git to track this specific file even though `.canon/` is otherwise ignored. Future `git add .` runs will pick it up automatically — the `-f` flag is only needed for the initial add.

## Hooks

Hooks are pre/post tool-use interceptor scripts in `hooks/`. Key hooks: `destructive-guard.sh` (blocks dangerous git ops), `workspace-lock-guard.sh` (prevents concurrent builds), `pre-commit-check.sh` (secrets + compliance), `principle-inject.sh` (injects principle summaries into prompts).

## Agent Provenance

### Commit Trailers

All Canon-managed commits include git trailers for traceability:

```
Canon-Workflow: {workflow-slug}
Canon-Agent: {agent-type}
Canon-State: {state-id}
Canon-Task: {task-id}          # wave tasks only
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Query commits by workflow: `git log --grep='Canon-Workflow: my-slug'`
Query commits by agent: `git log --grep='Canon-Agent: implementor'`

### File Claims

`.canon/claims.json` tracks which files are targeted by active workflows. This enables early conflict detection when multiple workflows run concurrently.

- **Registration**: Claims are registered via `write_plan_index` (architect's affected-file list) and the `init_workspace` flow
- **Overlap detection**: `init_workspace` preflight warns about files claimed by other active workflows
- **Release**: Claims are released by `finalize_workspace({ workspace })`
- **Staleness**: Claims older than 24 hours are automatically pruned on every read
- **Advisory only**: Claim overlaps produce warnings, never block workspace creation

Claims file format:
```json
{
  "version": 1,
  "claims": {
    "path/to/file.ts": [
      { "workflow": "slug", "claimed_at": "2026-04-09T00:00:00Z" }
    ]
  }
}
```
