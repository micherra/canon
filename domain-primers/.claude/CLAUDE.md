# Canon Domain Primers — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Domain-specific reasoning guidance injected into agent context when working in a particular technical domain. Primers shape how agents think about a problem, not which workflow steps they follow.

## Architecture
<!-- last-updated: 2026-04-09 -->

Each primer is a standalone markdown file named after its domain (e.g., `backend-api.md`, `frontend.md`). The orchestrator injects the appropriate primer(s) into agent spawn prompts based on the task's `domains:` frontmatter field.

**Available primers:**

| Primer | Domain covered |
|--------|---------------|
| `backend-api.md` | REST/RPC API design, HTTP conventions, request/response contracts |
| `backend-data.md` | Database access patterns, query design, data modeling |
| `deprecation.md` | Safe deprecation strategies, migration paths, backward compatibility |
| `frontend.md` | UI component patterns, state management, accessibility |
| `infrastructure.md` | Deployment, configuration, environment management |
| `testing.md` | Test strategy, coverage philosophy, test pyramid |

## Conventions
<!-- last-updated: 2026-04-09 -->

- Primers shape thinking, not workflow — they provide domain context, not procedural steps
- Each primer is 40–80 lines: long enough to be useful, short enough to fit in agent context without crowding
- Primers are loaded by the orchestrator; agents do not load them directly
- New primers follow the `{domain-name}.md` naming convention and include a one-line summary at the top
