# Canon Principle Format Specification

Each principle is a markdown file with YAML frontmatter.

## Frontmatter Schema

```yaml
---
id: string            # Unique slug, kebab-case (e.g., "thin-handlers")
title: string         # Human-readable name (e.g., "Handlers Are Thin Orchestrators")
severity: string      # "rule" | "strong-opinion" | "convention"
scope:
  layers:             # Architectural layers (empty = all)
    - api             # HTTP handlers, route definitions, middleware
    - ui              # Components, views, client-side logic
    - domain          # Business logic, services, entities
    - data            # Database access, queries, migrations
    - infra           # Config, deployment, CI/CD, IaC
    - shared          # Utilities, types, constants
  file_patterns:      # Optional globs for targeted matching
    - "src/api/**"
    - "**/*.controller.ts"
tags:                 # Freeform tags for cross-cutting concerns
  - simplicity
  - naming
  - error-handling
---
```

## Required Fields

- `id` — Unique kebab-case identifier
- `title` — Human-readable name
- `severity` — One of: `rule`, `strong-opinion`, `convention`

## Optional Fields

- `scope.layers` — Empty array or omitted means "applies to all layers"
- `scope.file_patterns` — Globs for targeted matching. Empty means "applies everywhere"
- `tags` — Freeform classification tags

## Body Structure

The markdown body after frontmatter follows this fixed structure:

1. **Summary** (first paragraph) — One to three sentences stating the principle as a falsifiable constraint. Make it concrete and actionable.

2. **Rationale** (`## Rationale`) — Why this principle exists. What goes wrong when violated. Name the specific failure mode.

3. **Examples** (`## Examples`) — At least one good and one bad example as fenced code blocks. Annotate each with what to notice.

4. **Exceptions** (`## Exceptions`, optional) — When it's acceptable to deviate. Be specific.

## Severity Definitions

| Level | Meaning | Hook behavior | Review behavior |
|-------|---------|--------------|-----------------|
| `rule` | Hard constraint | Block commit | Error — must fix |
| `strong-opinion` | Default path | Warn, don't block | Warning — justify or fix |
| `convention` | Stylistic preference | Silent | Info — note only |

## Authoring Tips

1. Lead with the constraint, not the philosophy. Make it falsifiable.
2. Make examples realistic. Toy examples teach the wrong lessons.
3. **Scope narrowly. A principle that applies everywhere applies nowhere.** See below.
4. Name the tradeoff. Every principle trades something.
5. One idea per principle. If you write "also," split it.

## Scope Guidance (Important)

**Empty scope = matches every file.** An unconstrained principle adds noise to every code review, every post-write check, and every implementor's context. Before leaving scope empty, ask: "Does this principle genuinely apply to a React component, a Terraform module, a database migration, AND an API handler equally?"

**Add `layers` when the principle targets specific code:**
- DDD principles → `layers: [domain]`
- Data access patterns → `layers: [data]` or `layers: [domain, data]`
- Infrastructure concerns → `layers: [infra]`
- API/handler patterns → `layers: [api]`
- Distributed system patterns → `layers: [domain, api, infra]`

**Add `file_patterns` for precise targeting:**
- Test principles → `file_patterns: ["**/*.test.*", "**/*.spec.*"]`
- Migration principles → `file_patterns: ["**/migrations/**", "**/*.sql"]`
- Infrastructure → `file_patterns: ["**/*.tf", "**/Dockerfile*"]`

**Truly universal principles** (naming, simplicity, single responsibility, information hiding) can stay unconstrained — but there should be fewer than 15 of these. If you have more, some are probably scoped more narrowly than you think.

The MCP matcher sorts by severity (rules first, then strong-opinions, then conventions). The `get_principles` tool caps results at 10 to keep context concise; `review_code` returns all matches so no principles are skipped during review.
