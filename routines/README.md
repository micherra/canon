# Canon Routines

Routines are automated tasks managed as first-class Canon artifacts. Each routine is a structured markdown file with a frontmatter schema and a body that describes what the routine does when it runs.

## What is a routine?

A routine is a scheduled or event-driven task that Canon manages on your behalf. Unlike ad-hoc scripts, routines are:

- **Schema-validated** — Canon lints each routine file to catch configuration errors before deployment.
- **Binding-aware** — Canon derives the execution environment (cloud vs. desktop) from the routine's declared needs.
- **Guardrail-enforced** — Every routine declares what it is allowed to write back to the repository.

Routines live in this directory as plain markdown files with YAML frontmatter.

## Frontmatter schema

Every routine file must have the following frontmatter:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique kebab-case identifier (e.g. `release-ahead`). Peer of a principle ID. |
| `title` | yes | Human-readable display name. |
| `status` | yes | `enabled`, `disabled`, or `draft`. Canon manages lifecycle transitions. |
| `trigger.kind` | yes | `schedule`, `github-event`, or `api`. |
| `trigger.cron` | if schedule | 5-field cron expression (e.g. `"0 9 * * *"` = daily at 09:00 UTC). |
| `trigger.event` | if github-event | GitHub event name (e.g. `pull_request.opened`). |
| `needs.state` | yes | `git-native` (requires a clone) or `local-canon` (requires local `.canon/` state). |
| `needs.daemon` | yes | `true` if the routine requires a persistent local process; `false` otherwise. |
| `binding_target` | no | Optional override for the resolved binding. Leave as `~` unless you have a specific reason. |
| `repos` | yes | List of repository slugs the routine operates on (e.g. `[canon]`). |
| `scope` | yes | `repo` (operates on one or more repos) or `account` (account-wide). |
| `guardrails.mutates_running_build` | yes | Must always be `false`. Canon CI-lints this field. |
| `guardrails.repo_writes` | yes | `notify-only`, `draft-pr`, or `none`. |
| `guardrails.consent` | yes | `opt-in` (default) or `tier-gated`. |
| `recurrence` | yes | `standing` (runs on every trigger) or `one-shot` (runs once then disabled). |

## Cloud vs. desktop binding

Canon automatically determines where a routine runs based on its declared `needs`.

> Canonical binding rule: `mcp-server/src/features/routines/services/resolve-binding.ts` — keep this table in sync with that source of truth.

| `needs.state` | `needs.daemon` | Resolved binding |
|---------------|----------------|-----------------|
| `git-native` | `false` | `cloud-routine` — can run in a fresh clone with no local state |
| `local-canon` | any | `desktop-task` — requires local `.canon/` state |
| any | `true` | `desktop-task` — requires a persistent local process |

**Cloud routines** (`cloud-routine`) run in an ephemeral environment with a clean repository checkout. Their bodies must be self-contained: no references to local `.canon/` directories, no assumptions about local MCP daemons.

**Desktop routines** (`desktop-task`) run on the developer's local machine where Canon is installed and running. They can read local `.canon/` state, communicate with the MCP daemon, and work with the full Canon context.

To override the derived binding, set `binding_target` explicitly in the frontmatter. Canon will lint any contradiction between the override and the needs-derived value.

## Authoring a new routine

Use the `/canon:routine` slash command to start the authoring workflow. The writer agent will interview you about the routine's purpose, trigger, binding needs, and guardrails, then produce a draft file in this directory.

To browse and manage existing routines, use `/canon:routines`.

## Routines in this directory

| Name | Title | Binding | Trigger |
|------|-------|---------|---------|
| `release-ahead` | Release Ahead Check | cloud | daily at 09:00 UTC |
| `pr-review` | Automated PR Review | cloud | on PR open/update |
| `canon-maintenance` | Canon Maintenance Run | desktop | nightly at 03:00 |

See `routines/.claude/CLAUDE.md` for the Canon-agent-facing index (auto-generated; do not edit by hand).
