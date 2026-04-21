# Canon Domain Primers — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-21 -->
Domain-specific reasoning guidance injected into agent context when working in a particular technical domain. Primers shape how agents think about a problem, not which workflow steps they follow.

## Canonical location
<!-- last-updated: 2026-04-21 -->

**The canonical primer source is `skills/canon/references/`** as of phase1-05
of the agent-teams migration. `domain-primers/*.md` in this directory are
symlinks into `skills/canon/references/` and must not be edited directly —
edits here would be overwritten on the next symlink refresh. Edit the
target file in `skills/canon/references/` instead.

The symlink alias is retained so the legacy (`CANON_AGENT_TEAMS_MODE=off`)
path in `agents/canon-implementor.md` and the
`domain-priming-integration.test.ts` contract tests continue to resolve
the built-in domain files at `${CLAUDE_PLUGIN_ROOT}/domain-primers/`.
When phase1-08 retires `canon-implementor` and `canon-engineer`'s
skill-preloading becomes the sole loading path, this directory can be
deleted — until then, single-source-of-truth lives in
`skills/canon/references/`, and this directory is a presentation alias.

## Architecture
<!-- last-updated: 2026-04-21 -->

Each primer is a standalone markdown file named after its domain (e.g., `backend-api.md`, `frontend.md`). The orchestrator injects the appropriate primer(s) into agent spawn prompts based on the task's `domains:` frontmatter field.

**Available primers (symlinks into `skills/canon/references/`):**

| Primer | Domain covered |
|--------|---------------|
| `backend-api.md` | REST/RPC API design, HTTP conventions, request/response contracts |
| `backend-data.md` | Database access patterns, query design, data modeling |
| `deprecation.md` | Safe deprecation strategies, migration paths, backward compatibility |
| `frontend.md` | UI component patterns, state management, accessibility |
| `infrastructure.md` | Deployment, configuration, environment management |
| `testing.md` | Test strategy, coverage philosophy, test pyramid |

In `CANON_AGENT_TEAMS_MODE=on`, six additional domain skills live in
`skills/canon/references/` without a `domain-primers/` alias
(`authentication-security`, `migration-strategy`, `observability`,
`error-handling`, `performance`, `devops-ci`). Those are agent-teams-only.

## Conventions
<!-- last-updated: 2026-04-21 -->

- Primers shape thinking, not workflow — they provide domain context, not procedural steps
- Each primer is 40–80 lines: long enough to be useful, short enough to fit in agent context without crowding
- Legacy mode: primers are loaded by the orchestrator; agents do not load them directly
- Agent-teams mode: primers are named in the spawn prompt and loaded by the agent per `agent-context-check`
- New primers are authored in `skills/canon/references/` following `{domain-name}.md` naming — not here
- Never edit `domain-primers/*.md` directly; the files are symlinks and the source of truth is the symlink target
