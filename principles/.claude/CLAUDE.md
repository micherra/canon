# Canon Principles — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Engineering principles encoded as markdown files with frontmatter metadata. Principles guide code generation, are checked during review, and refined through the learning loop.

## Architecture
<!-- last-updated: 2026-03-22 -->

Principles are organized by severity level:

```
principles/
├── rules/              # Non-negotiable; enforced pre-commit
├── strong-opinions/    # Strongly recommended; flagged during review
└── conventions/        # Best practices; suggested improvements
```

Each principle file has YAML frontmatter: `id`, `severity`, `title`, `tags`, `layers`, `file_patterns`, `description`. The body contains rationale, examples, and counter-examples.

**Severity levels:**

| Level | Directory | Enforcement |
|-------|-----------|-------------|
| `rule` | `rules/` | Hard block — must be fixed before commit |
| `strong-opinion` | `strong-opinions/` | Flagged in review — requires justification to deviate |
| `convention` | `conventions/` | Suggested — deviations noted but not blocking |

## Contracts
<!-- last-updated: 2026-03-22 -->

- Principles are loaded by the MCP server via `get_principles` and `review_code` tools
- `matcher.ts` in mcp-server filters principles by layer, file pattern, tags, and severity
- `parser.ts` in mcp-server extracts frontmatter metadata from principle files
- The `canon-learner` agent proposes new principles; the `canon-reviewer` checks against them

## Conventions
<!-- last-updated: 2026-03-22 -->

- Each principle has a unique `id` used for compliance tracking
- Principles should be specific and actionable — not aspirational
- Rules: `secrets-never-in-code`, `least-privilege-access`, `fail-closed-by-default`, `validate-at-trust-boundaries`
- Strong opinions cover architecture, testing, error handling, data flow
- Conventions cover naming, file organization, test structure
